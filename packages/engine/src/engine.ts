import { nanoid } from 'nanoid';
import {
  accumulate,
  detectTie,
  emptyTotals,
  itemsNeeded,
  matchConfigSchema,
  MAX_PLAYERS,
  MIN_PLAYERS,
  rankPlayers,
  rankTeams,
  revealMsFor,
  scoreRound,
  TEAMS,
  type AnyRoundType,
  type ContentItem,
  type ContentShape,
  type ContentSource,
  type EndReason,
  type MatchConfig,
  type PlayerId,
  type PlayerRef,
  type PlayerTotals,
  type RoomPlayer,
  type RoomState,
  type RoundScore,
} from '@game/shared';
import {
  ROUND_TYPES,
  generatePlaylist,
  getRoundType,
  suddenDeathType,
} from '@game/rounds';
import { generateCode } from './codes.js';
import { RoomNotFoundError, type RoomStore } from './store.js';

export { MAX_PLAYERS, MIN_PLAYERS };

export interface EngineOptions {
  introMs: number;
  /**
   * Base time the result screen stays up. A type's `revealWeight` scales it — see
   * `revealMsFor`.
   */
  resultMs: number;
  /** How long a disconnected player keeps their seat. */
  disconnectGraceMs: number;
  maxSuddenDeathAttempts: number;
  roomTtlMs: number;
  /** Whether host role automatically migrates on disconnect/leave (false in fixed-host Firebase mode). */
  transferHostOnLeave: boolean;
  now: () => number;
  rng: () => number;
}

/**
 * Six seconds was enough to read a score and not enough to say anything about it.
 *
 * The result screen is not dead time between rounds — it is where the room argues about the
 * answer, laughs at who fell for a lie, and notices that somebody just went past them on the
 * board. Cutting that off at six seconds made the match feel like a queue of questions rather
 * than an evening. Eleven is long enough for a reaction and a comeback without anybody
 * reaching for their phone, and the host can cut it short with `skipPhase` whenever the room
 * is already done talking.
 */
export const DEFAULT_OPTIONS: EngineOptions = {
  introMs: 4_000,
  resultMs: 11_000,
  disconnectGraceMs: 90_000,
  maxSuddenDeathAttempts: 3,
  roomTtlMs: 4 * 60 * 60 * 1_000,
  transferHostOnLeave: true,
  now: () => Date.now(),
  rng: Math.random,
};

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineError';
  }
}

const asPlayerRefs = (players: RoomPlayer[]): PlayerRef[] =>
  players.map((p) => ({
    id: p.id,
    nickname: p.nickname,
    connected: p.connected,
    teamId: p.teamId,
  }));

const clearReadiness = (players: RoomPlayer[]): RoomPlayer[] =>
  players.map((p) => ({ ...p, ready: false }));

export class MatchEngine {
  private readonly opts: EngineOptions;

  constructor(
    private readonly store: RoomStore,
    private readonly content: ContentSource,
    options: Partial<EngineOptions> = {},
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  // ---------------------------------------------------------------- lobby

  async createRoom(
    nickname: string,
    config?: Partial<MatchConfig>,
  ): Promise<{ state: RoomState; playerId: string; token: string }> {
    const categories = await this.content.categories();
    const rawConfig = {
      format: 'mixed' as const,
      categoryIds: categories.map((c) => c.id),
      roundCount: 10 as const,
      ...config,
    };
    if (rawConfig.format !== 'focused') {
      delete rawConfig.roundTypeId;
    }
    const merged = matchConfigSchema.parse(rawConfig);
    if (merged.format !== 'focused') {
      delete merged.roundTypeId;
    }

    const code = await this.allocateCode();
    const now = this.opts.now();
    const host = this.makePlayer(nickname, now);

    const state: RoomState = {
      code,
      hostId: host.id,
      players: [host],
      config: merged,
      phase: 'lobby',
      phaseEndsAtMs: null,
      version: 0,
      roundNo: 0,
      playlist: [],
      roundIndex: -1,
      roundTypeId: null,
      roundState: null,
      pendingContent: null,
      roundStartedAtMs: null,
      lastRoundScores: null,
      lastReveal: null,
      totals: emptyTotals([host.id]),
      standings: [],
      teamStandings: [],
      previousRanks: {},
      usedContentIds: [],
      suddenDeath: null,
      winnerId: null,
      winningTeamId: null,
      endReason: null,
      createdAtMs: now,
      updatedAtMs: now,
    };

    await this.store.create(state);
    return { state, playerId: host.id, token: host.token };
  }

  async join(
    code: string,
    nickname: string,
  ): Promise<{ state: RoomState; playerId: string; token: string }> {
    let playerId = '';
    let token = '';

    const state = await this.store.transition(code, null, (current) => {
      if (current.phase !== 'lobby') {
        throw new EngineError('الماتش بدأ خلاص — استنى لما يخلص أو اعمل غرفة جديدة');
      }
      if (current.players.length >= MAX_PLAYERS) {
        throw new EngineError(`الغرفة كاملة (${MAX_PLAYERS} لاعيبة بالكتير)`);
      }
      // Compared after truncation, because that is the name the room will actually show:
      // two seventeen-character nicknames sharing a prefix are one name on every screen.
      const player = this.makePlayer(nickname, this.opts.now());
      const taken = current.players.some(
        (p) => p.nickname.toLowerCase() === player.nickname.toLowerCase(),
      );
      if (taken) throw new EngineError('الاسم ده مستخدم في الغرفة — اختار اسم تاني');

      playerId = player.id;
      token = player.token;

      const players = clearReadiness([...current.players, player]);
      return this.touch({
        ...current,
        // Somebody joining after teams were switched on still needs a side, and it has to be
        // the smaller one or the room drifts lopsided as people trickle in.
        players: current.config.teams ? assignTeams(players) : players,
        totals: emptyTotals(players.map((p) => p.id)),
      });
    });

    return { state, playerId, token };
  }

  /** Reconnect by token — the whole of "auth" for a guest game. */
  async resume(code: string, token: string): Promise<{ state: RoomState; playerId: string }> {
    const room = await this.requireRoom(code);
    const player = room.players.find((p) => p.token === token);
    if (!player) throw new EngineError('مش لاقيين مقعدك في الغرفة دي');

    const state = await this.store.transition(code, null, (current) =>
      this.touch(this.setConnectedIn(current, player.id, true)),
    );
    return { state, playerId: player.id };
  }

  async configure(code: string, playerId: PlayerId, patch: Partial<MatchConfig>): Promise<RoomState> {
    return this.store.transition(code, null, (current) => {
      this.assertHost(current, playerId);
      if (current.phase !== 'lobby') throw new EngineError('مش هينفع تغيّر الإعدادات والماتش شغال');

      const mergedPatch = { ...current.config, ...patch };
      if (mergedPatch.format !== 'focused') {
        delete mergedPatch.roundTypeId;
      }
      const config = matchConfigSchema.parse(mergedPatch);
      if (config.format !== 'focused') {
        delete config.roundTypeId;
      }
      if (config.categoryIds.length === 0) throw new EngineError('اختار مجال واحد على الأقل');

      // Flipping teams on assigns sides immediately so the lobby shows the split rather than
      // making everybody wait until the match starts to find out who they are with.
      const assigned = config.teams
        ? assignTeams(current.players)
        : current.players.map((p) => ({ ...p, teamId: null }));
      const players = clearReadiness(assigned);

      return this.touch({ ...current, config, players });
    });
  }

  async setReady(code: string, playerId: PlayerId, ready?: boolean): Promise<RoomState> {
    return this.store.transition(code, null, (current) => {
      if (current.phase !== 'lobby') {
        throw new EngineError('مش هينفع تغيّر الاستعداد والماتش شغال');
      }
      const target = current.players.find((p) => p.id === playerId);
      if (!target) {
        throw new EngineError('مش لاقيين مقعدك في الغرفة دي');
      }

      const nextReady = ready !== undefined ? Boolean(ready) : !Boolean(target.ready);
      const players = current.players.map((p) =>
        p.id === playerId ? { ...p, ready: nextReady } : p,
      );
      return this.touch({ ...current, players });
    });
  }

  async kick(code: string, hostId: PlayerId, targetId: PlayerId): Promise<RoomState> {
    return this.store.transition(code, null, (current) => {
      this.assertHost(current, hostId);
      if (targetId === hostId) throw new EngineError('مش هتقدر تطرد نفسك');
      const remaining = current.players.filter((p) => p.id !== targetId);
      if (remaining.length === current.players.length) throw new EngineError('اللاعب ده مش موجود');
      const players = current.phase === 'lobby' ? clearReadiness(remaining) : remaining;
      return this.touch({
        ...current,
        // Removing somebody from a split room leaves it lopsided, and rooms fill back up one
        // player at a time — so the sides are recomputed for the same reason they are on join.
        //
        // Lobby only. Mid-match a reshuffle would move players between teams during a round,
        // which changes who a cooperative round is describing for and rewrites the team
        // standings under scores that were already earned.
        players:
          current.config.teams && current.phase === 'lobby' ? rebalanceTeams(players) : players,
        totals: current.totals.filter((t) => t.playerId !== targetId),
      });
    });
  }

  async start(code: string, playerId: PlayerId): Promise<RoomState> {
    return this.store.transition(code, null, async (current) => {
      this.assertHost(current, playerId);
      if (current.phase !== 'lobby') throw new EngineError('الماتش شغال بالفعل');
      const connectedCount = current.players.filter((p) => p.connected && !p.leftEarly).length;
      if (connectedCount < MIN_PLAYERS) {
        throw new EngineError(`محتاجين ${MIN_PLAYERS} لاعيبة على الأقل عشان نبدأ`);
      }

      const availableShapes = await this.availableShapes(
        current.config.categoryIds,
        current.players.length,
      );
      const playlist = generatePlaylist({
        format: current.config.format,
        roundCount: current.config.roundCount,
        playerCount: current.players.length,
        teams: current.config.teams,
        availableShapes,
        roundTypeId: current.config.roundTypeId,
        rng: this.opts.rng,
      });

      const fresh: RoomState = {
        ...current,
        players: clearReadiness(current.players),
        playlist,
        roundIndex: -1,
        totals: emptyTotals(current.players.map((p) => p.id)),
        standings: [],
        teamStandings: [],
        previousRanks: {},
        /**
         * Carried over, not cleared.
         *
         * `rematch` deliberately keeps the used ids so a second match does not replay the first
         * — and clearing them here undid that one step later, which is the whole reason the same
         * questions came back when a group played a few matches in one sitting. The room is the
         * same people on the same evening; what they have already seen does not stop counting
         * because a new playlist was generated.
         *
         * The list only grows, so eventually a long night exhausts a narrow category. That is
         * handled where it should be — `hydrate` drops the exclusion rather than failing, so the
         * worst case degrades back to a repeated question instead of a dead match.
         */
        usedContentIds: current.usedContentIds,
        suddenDeath: null,
        winnerId: null,
        winningTeamId: null,
        endReason: null,
        lastRoundScores: null,
        lastReveal: null,
      };
      return this.touch(await this.beginRound(fresh, 0, this.opts.now()));
    });
  }

  /**
   * Lets the host cut a waiting screen short.
   *
   * The result screen is deliberately long enough for the room to argue about the answer,
   * which means it is sometimes longer than the room needs. A fixed timer can be generous or
   * brisk; it cannot be both, and the person watching the room already knows which one this
   * moment wants. Only the phases nobody is playing in are skippable — a round in progress is
   * not the host's to end, or a losing host could close a round the instant they answered.
   */
  async skipPhase(code: string, playerId: PlayerId): Promise<RoomState> {
    return this.store.transition(code, null, async (current) => {
      this.assertHost(current, playerId);
      const skippable =
        current.phase === 'round_intro' ||
        current.phase === 'round_result' ||
        current.phase === 'sudden_death_intro';
      if (!skippable) throw new EngineError('مفيش حاجة تتخطى دلوقتي');

      return this.touch(await this.advance(current, this.opts.now()));
    });
  }

  async rematch(code: string, playerId: PlayerId): Promise<RoomState> {
    return this.store.transition(code, null, (current) => {
      this.assertHost(current, playerId);
      if (current.phase !== 'podium') throw new EngineError('الماتش لسه ما خلصش');

      // People who walked out do not get dragged into the next match, and the sides are
      // recomputed around whoever is left rather than kept from a room that no longer exists.
      const remaining = clearReadiness(current.players.filter((p) => p.connected));
      const staying = current.config.teams ? rebalanceTeams(remaining) : remaining;

      return this.touch({
        ...current,
        phase: 'lobby',
        phaseEndsAtMs: null,
        playlist: [],
        roundIndex: -1,
        roundTypeId: null,
        roundState: null,
        pendingContent: null,
        roundStartedAtMs: null,
        lastRoundScores: null,
        lastReveal: null,
        // Scored against the players who are actually still here. Building the totals from
        // the pre-filter list left rows for people who had already gone, which then rank on
        // the board as ghosts on zero.
        totals: emptyTotals(staying.map((p) => p.id)),
        standings: [],
        teamStandings: [],
        previousRanks: {},
        // Questions already used stay excluded, so a rematch does not replay the same match.
        suddenDeath: null,
        winnerId: null,
        winningTeamId: null,
        endReason: null,
        players: staying,
      });
    });
  }

  // ---------------------------------------------------------------- play

  async submitAction(
    code: string,
    playerId: PlayerId,
    roundNo: number,
    action: unknown,
  ): Promise<RoomState> {
    return this.store.transition(code, null, async (current) => {
      const playable = current.phase === 'in_round' || current.phase === 'sudden_death';
      if (!playable || !current.roundTypeId || !current.roundState) return current;

      // A stale round number means the client tapped on a round that has already resolved.
      // Dropping it silently is correct: the player did nothing wrong, their tap just lost
      // the race.
      if (roundNo !== current.roundNo) return current;

      const type = getRoundType(current.roundTypeId);
      const now = this.opts.now();
      const step = type.reduce(current.roundState, action, { playerId, nowMs: now });
      const next: RoomState = { ...current, roundState: step.state };

      if (type.isFinished(step.state)) return this.touch(await this.advance(next, now));

      // Sudden death ends the instant somebody is right — making the others sit out the rest
      // of the clock after the match is already decided would be a miserable way to finish.
      if (
        current.phase === 'sudden_death' &&
        type.roundScores(step.state).some((s: RoundScore) => s.isCorrect)
      ) {
        return this.touch(await this.resolveSuddenDeath(next, now));
      }

      // A stage can close early — once everyone has submitted their lie there is no reason to
      // sit out the rest of the writing clock — so the deadline is re-read after every action.
      const withDeadline: RoomState = {
        ...next,
        phaseEndsAtMs: type.nextDeadline(step.state) ?? current.phaseEndsAtMs,
      };
      if (this.allConnectedPlayersActed(withDeadline)) {
        return this.touch(await this.advanceIfAllConnectedActed(withDeadline, now));
      }
      return this.touch(withDeadline);
    });
  }

  /**
   * Sweeper step. Advances every room whose phase deadline has passed and reaps dead seats.
   * In production this same method runs behind a Redis lock; nothing about it is
   * single-process except which store backs it.
   */
  async tick(nowMs = this.opts.now()): Promise<string[]> {
    const changed: string[] = [];

    for (const code of await this.store.dueDeadlines(nowMs)) {
      try {
        await this.store.transition(code, null, async (current) => {
          if (current.phaseEndsAtMs === null || current.phaseEndsAtMs > nowMs) return current;
          return this.touch(await this.advance(current, nowMs));
        });
        changed.push(code);
      } catch (error) {
        // A room deleted between listing and transition is normal, not an error.
        if (error instanceof RoomNotFoundError) continue;

        /**
         * Anything else is a real failure to advance, and swallowing it hangs the match.
         *
         * The deadline stays in the past, so the sweeper retries the same broken transition
         * four times a second forever while the players sit on a frozen screen that never
         * moves and never explains itself. Ending the match is a bad outcome; an unending
         * one is worse, and it is invisible to the players and the operator alike.
         */
        console.error(`[engine] room ${code} could not advance`, error);
        if (await this.abandon(code, nowMs)) changed.push(code);
      }
    }

    for (const code of await this.store.staleRooms(nowMs, this.opts.roomTtlMs)) {
      await this.store.delete(code);
    }

    return changed;
  }

  /**
   * Ends a match the engine can no longer advance, so the room stops rather than spins.
   *
   * Reported as `abandoned`, which is already the "this did not finish properly" outcome the
   * podium knows how to render — no winner, honest standings.
   */
  private async abandon(code: string, nowMs: number): Promise<boolean> {
    try {
      await this.store.transition(code, null, (current) =>
        this.touch(this.concludeMatch(current, 'abandoned', nowMs)),
      );
      return true;
    } catch (error) {
      if (error instanceof RoomNotFoundError) return false;
      console.error(`[engine] room ${code} could not be ended`, error);
      return false;
    }
  }

  /** Drops seats whose grace period expired, and ends matches nobody is left playing. */
  async reapDisconnected(code: string, nowMs = this.opts.now()): Promise<RoomState | null> {
    try {
      return await this.store.transition(code, null, (current) => {
        const players = current.players.map((p) =>
          !p.connected &&
          p.disconnectedAtMs !== null &&
          nowMs - p.disconnectedAtMs > this.opts.disconnectGraceMs
            ? { ...p, leftEarly: true }
            : p,
        );

        const inLobby = current.phase === 'lobby';
        const filtered = inLobby ? players.filter((p) => !p.leftEarly) : players;
        const kept =
          inLobby && filtered.length !== current.players.length
            ? clearReadiness(filtered)
            : filtered;
        return this.touch(this.checkAbandonment({ ...current, players: kept }, nowMs));
      });
    } catch (error) {
      // A room that has already been reaped is the expected case here — a player leaving or
      // dropping after the match ended. Anything else is a defect and must not be silent.
      if (error instanceof RoomNotFoundError) return null;
      throw error;
    }
  }

  async setConnected(code: string, playerId: PlayerId, connected: boolean): Promise<RoomState | null> {
    try {
      return await this.store.transition(code, null, async (current) => {
        const now = this.opts.now();
        const checked = this.checkAbandonment(this.setConnectedIn(current, playerId, connected), now);
        if (!connected && this.allConnectedPlayersActed(checked)) {
          return this.touch(await this.advanceIfAllConnectedActed(checked, now));
        }
        return this.touch(checked);
      });
    } catch (error) {
      // A room that has already been reaped is the expected case here — a player leaving or
      // dropping after the match ended. Anything else is a defect and must not be silent.
      if (error instanceof RoomNotFoundError) return null;
      throw error;
    }
  }

  async leave(code: string, playerId: PlayerId): Promise<RoomState | null> {
    try {
      return await this.store.transition(code, null, async (current) => {
        const now = this.opts.now();
        const players =
          current.phase === 'lobby'
            ? clearReadiness(current.players.filter((p) => p.id !== playerId))
            : current.players.map((p) =>
                p.id === playerId ? { ...p, connected: false, leftEarly: true, ready: false } : p,
              );

        const withHost = this.transferHost({ ...current, players });
        const checked = this.checkAbandonment(withHost, now);
        if (this.allConnectedPlayersActed(checked)) {
          return this.touch(await this.advanceIfAllConnectedActed(checked, now));
        }
        return this.touch(checked);
      });
    } catch (error) {
      // A room that has already been reaped is the expected case here — a player leaving or
      // dropping after the match ended. Anything else is a defect and must not be silent.
      if (error instanceof RoomNotFoundError) return null;
      throw error;
    }
  }

  // ---------------------------------------------------- state machine core

  private async advance(state: RoomState, nowMs: number): Promise<RoomState> {
    switch (state.phase) {
      case 'round_intro':
        return this.startRoundPlay(state, nowMs, 'in_round');
      case 'in_round':
        return this.stepRound(state, nowMs);
      case 'round_result':
        return this.afterRoundResult(state, nowMs);
      case 'sudden_death_intro':
        return this.startRoundPlay(state, nowMs, 'sudden_death');
      case 'sudden_death':
        return this.resolveSuddenDeath(state, nowMs);
      default:
        return state;
    }
  }

  private async beginRound(state: RoomState, index: number, nowMs: number): Promise<RoomState> {
    const entry = state.playlist[index];
    if (!entry) return this.concludeMatch(state, 'completed', nowMs);

    const type = getRoundType(entry.roundTypeId);
    const content = await this.pickContent(state, type, entry.difficulty);

    return {
      ...state,
      phase: 'round_intro',
      phaseEndsAtMs: nowMs + this.opts.introMs,
      roundNo: state.roundNo + 1,
      roundIndex: index,
      roundTypeId: type.id,
      roundState: null,
      pendingContent: content,
      roundStartedAtMs: null,
      lastRoundScores: null,
      lastReveal: null,
      usedContentIds: [...state.usedContentIds, ...content.map((c) => c.id)],
    };
  }

  private startRoundPlay(
    state: RoomState,
    nowMs: number,
    phase: 'in_round' | 'sudden_death',
  ): RoomState {
    if (!state.roundTypeId || !state.pendingContent) return state;
    const type = getRoundType(state.roundTypeId);

    // The clock starts now, not when the content was fetched — otherwise a slow sweeper tick
    // silently shortens the round for everyone.
    const activePlayers = state.players.filter((p) => !p.leftEarly);
    const participants =
      phase === 'sudden_death' && state.suddenDeath
        ? activePlayers.filter((p) => state.suddenDeath!.contenders.includes(p.id))
        : activePlayers.length >= 2
          ? activePlayers
          : state.players;

    const roundState = type.createState(state.pendingContent as ContentItem[], {
      players: asPlayerRefs(participants),
      startedAtMs: nowMs,
      endsAtMs: nowMs + type.durationMs,
    });

    return {
      ...state,
      phase,
      roundState,
      pendingContent: null,
      roundStartedAtMs: nowMs,
      // The type owns its own timing. A single-phase round returns its end; a multi-phase one
      // returns the end of its first stage, so the engine wakes up to advance it.
      phaseEndsAtMs: type.nextDeadline(roundState) ?? nowMs + type.durationMs,
    };
  }

  /**
   * Fires when a round deadline passes. That is not always the end of the round: a
   * multi-stage type (write your lie, then vote on the lies) uses the same deadline to close
   * one stage and open the next. The type decides which happened; the engine just asks it
   * when to wake up again.
   */
  private stepRound(state: RoomState, nowMs: number): RoomState {
    if (!state.roundTypeId || !state.roundState) return state;
    const type = getRoundType(state.roundTypeId);

    if (type.isFinished(state.roundState)) return this.resolveRound(state, nowMs);

    const step = type.onDeadline(state.roundState, { nowMs });
    const advanced: RoomState = { ...state, roundState: step.state };
    if (type.isFinished(step.state)) return this.resolveRound(advanced, nowMs);

    return {
      ...advanced,
      phaseEndsAtMs: type.nextDeadline(step.state) ?? nowMs,
    };
  }

  private resolveRound(state: RoomState, nowMs: number): RoomState {
    if (!state.roundTypeId || !state.roundState) return state;
    const type = getRoundType(state.roundTypeId);
    const entry = state.playlist[state.roundIndex];

    const closed = type.isFinished(state.roundState)
      ? state.roundState
      : type.onDeadline(state.roundState, { nowMs }).state;

    const scores = scoreRound(type.roundScores(closed), entry?.weight ?? 1);
    const totals = accumulate(state.totals, scores, type.durationMs);
    const previousRanks = new Map(state.standings.map((s) => [s.playerId, s.rank]));
    const standings = rankPlayers(totals, previousRanks);

    return {
      ...state,
      phase: 'round_result',
      phaseEndsAtMs: nowMs + revealMsFor(type, this.opts.resultMs),
      roundState: closed,
      lastRoundScores: scores,
      lastReveal: type.reveal(closed),
      totals,
      standings,
      teamStandings: teamStandingsFor(state, totals),
      previousRanks: Object.fromEntries(state.standings.map((s) => [s.playerId, s.rank])),
    };
  }

  private async afterRoundResult(state: RoomState, nowMs: number): Promise<RoomState> {
    const nextIndex = state.roundIndex + 1;
    if (nextIndex < state.playlist.length) return this.beginRound(state, nextIndex, nowMs);

    const tied = this.tiedContenders(state);
    if (tied && tied.length > 1) return this.beginSuddenDeath(state, tied, 1, nowMs);
    return this.concludeMatch(state, 'completed', nowMs);
  }

  /**
   * Who, if anybody, has to play a tie-break.
   *
   * In a team match the individual board is not what decides anything, so a tie between two
   * players on the same winning side is meaningless and must not interrupt the podium. What
   * matters there is a tie between teams, and the whole of both sides plays it off.
   */
  private tiedContenders(state: RoomState): PlayerId[] | null {
    if (!state.config.teams) return detectTie(state.standings);

    const leaders = state.teamStandings.filter((t) => t.rank === 1);
    if (leaders.length < 2) return null;
    return leaders.flatMap((t) => t.memberIds);
  }

  private async beginSuddenDeath(
    state: RoomState,
    contenders: PlayerId[],
    attempt: number,
    nowMs: number,
  ): Promise<RoomState> {
    const type = suddenDeathType(ROUND_TYPES);
    const content = await this.pickContent(state, type, undefined);

    return {
      ...state,
      phase: 'sudden_death_intro',
      phaseEndsAtMs: nowMs + this.opts.introMs,
      roundNo: state.roundNo + 1,
      roundTypeId: type.id,
      roundState: null,
      pendingContent: content,
      lastRoundScores: null,
      lastReveal: null,
      suddenDeath: { contenders, attempt, resolvedWinner: null },
      usedContentIds: [...state.usedContentIds, ...content.map((c) => c.id)],
    };
  }

  private async resolveSuddenDeath(state: RoomState, nowMs: number): Promise<RoomState> {
    if (!state.roundTypeId || !state.roundState || !state.suddenDeath) return state;
    const type = getRoundType(state.roundTypeId);

    const closed = type.isFinished(state.roundState)
      ? state.roundState
      : type.onDeadline(state.roundState, { nowMs }).state;

    // Sudden-death points are never added to the totals — the scoreboard keeps showing the
    // honest tie. The scores are used only for their ordering, where a higher score means an
    // earlier correct answer, so "first correct wins" falls out of the existing round type
    // instead of needing a bespoke one.
    const correct = type
      .roundScores(closed)
      .filter((s: RoundScore) => s.isCorrect)
      .sort((a: RoundScore, b: RoundScore) => b.points - a.points);

    const withReveal: RoomState = { ...state, roundState: closed, lastReveal: type.reveal(closed) };

    if (correct.length > 0) {
      return this.concludeMatch(
        { ...withReveal, suddenDeath: { ...state.suddenDeath, resolvedWinner: correct[0]!.playerId } },
        'completed',
        nowMs,
      );
    }

    if (state.suddenDeath.attempt < this.opts.maxSuddenDeathAttempts) {
      return this.beginSuddenDeath(
        withReveal,
        state.suddenDeath.contenders,
        state.suddenDeath.attempt + 1,
        nowMs,
      );
    }

    // Nobody could answer three questions. Fall back to who played fastest all match, and
    // failing that let them genuinely share the win rather than picking arbitrarily.
    const bySpeed = state.totals
      .filter((t) => state.suddenDeath!.contenders.includes(t.playerId))
      .sort((a, b) => a.totalMs - b.totalMs);
    const clearFastest =
      bySpeed.length > 1 && bySpeed[0]!.totalMs !== bySpeed[1]!.totalMs ? bySpeed[0]!.playerId : null;

    return this.concludeMatch(
      { ...withReveal, suddenDeath: { ...state.suddenDeath, resolvedWinner: clearFastest } },
      'completed',
      nowMs,
    );
  }

  private concludeMatch(state: RoomState, reason: EndReason, nowMs: number): RoomState {
    const standings = state.standings.length
      ? state.standings
      : rankPlayers(state.totals, new Map(state.standings.map((s) => [s.playerId, s.rank])));

    const leaders = standings.filter((s) => s.rank === 1);
    const winnerId =
      state.suddenDeath?.resolvedWinner ??
      (reason === 'completed' && leaders.length === 1 ? leaders[0]!.playerId : null);

    const teamStandings = teamStandingsFor(state, state.totals);
    const teamLeaders = teamStandings.filter((t) => t.rank === 1);

    // A tie-break played between two sides is settled by whoever answered, so the crown goes
    // to their team rather than to them personally.
    const suddenDeathTeam = state.config.teams
      ? (state.players.find((p) => p.id === state.suddenDeath?.resolvedWinner)?.teamId ?? null)
      : null;

    return {
      ...state,
      phase: 'podium',
      phaseEndsAtMs: null,
      pendingContent: null,
      standings,
      teamStandings,
      winnerId,
      winningTeamId:
        reason !== 'completed'
          ? null
          : (suddenDeathTeam ?? (teamLeaders.length === 1 ? teamLeaders[0]!.teamId : null)),
      endReason: reason,
    };
  }

  // ---------------------------------------------------------------- helpers

  private checkAbandonment(state: RoomState, nowMs: number): RoomState {
    if (state.phase === 'lobby' || state.phase === 'podium') return state;
    const connected = state.players.filter((p) => p.connected).length;
    if (connected > 1) return state;
    // Playing alone is not a match. Show the standings as they stand rather than pretending
    // the last player standing won something.
    return this.concludeMatch(state, 'abandoned', nowMs);
  }

  private setConnectedIn(state: RoomState, playerId: PlayerId, connected: boolean): RoomState {
    const players = state.players.map((p) =>
      p.id === playerId
        ? {
            ...p,
            connected,
            disconnectedAtMs: connected ? null : this.opts.now(),
            leftEarly: connected ? false : p.leftEarly,
            ready: connected ? p.ready : false,
          }
        : p,
    );
    return this.transferHost({ ...state, players });
  }

  /** Without this the room dies with its host — nobody else can start or configure anything. */
  private transferHost(state: RoomState): RoomState {
    if (!this.opts.transferHostOnLeave) return state;

    const host = state.players.find((p) => p.id === state.hostId);
    if (host?.connected && !host.leftEarly) return state;

    const successor = [...state.players]
      .filter((p) => p.connected && !p.leftEarly)
      .sort((a, b) => a.joinedAtMs - b.joinedAtMs)[0];

    return successor ? { ...state, hostId: successor.id } : state;
  }

  private isPlayerDoneInCurrentStage(
    type: AnyRoundType,
    roundState: unknown,
    playerId: PlayerId,
  ): boolean {
    const view = type.view(roundState as never, playerId) as Record<string, unknown> | null;
    if (!view || typeof view !== 'object') return false;

    if (view.stage === 'writing') {
      if ('myLie' in view) return view.myLie !== null && view.myLie !== undefined;
      if (Array.isArray(view.myAnswers)) return view.myAnswers.every((v) => v !== null);
    }
    if (view.stage === 'voting') {
      if ('myVote' in view) return view.myVote !== null && view.myVote !== undefined;
      if ('isReady' in view) return view.isReady === true;
    }
    if (view.stage === 'answering') {
      if ('hasAnswered' in view) return view.hasAnswered === true;
      if ('isDone' in view) return view.myBid === null || view.isDone === true;
    }
    if (view.stage === 'stealing') {
      return view.iWasCorrect === false || view.hasActed === true;
    }
    if (view.stage === 'bidding') {
      return view.myBid !== null && view.myBid !== undefined;
    }

    if (view.hasAnswered === true) return true;
    if (view.hasGuessed === true) return true;
    if (view.hasVoted === true) return true;
    if (view.isDone === true) return true;
    if (view.isLocked === true || view.isBusted === true) return true;
    if (view.hasSolved === true || view.attemptsLeft === 0) return true;

    return false;
  }

  private allConnectedPlayersActed(state: RoomState): boolean {
    if (state.phase !== 'in_round' && state.phase !== 'sudden_death') return false;
    if (!state.roundTypeId || !state.roundState) return false;
    const type = getRoundType(state.roundTypeId);
    if (type.isFinished(state.roundState as never)) return false;

    const participantIds = (state.roundState as { playerIds?: PlayerId[] }).playerIds;
    if (!Array.isArray(participantIds) || participantIds.length === 0) return false;

    const connectedParticipants = state.players.filter(
      (p) => participantIds.includes(p.id) && p.connected && !p.leftEarly,
    );
    if (connectedParticipants.length === 0) return false;

    return connectedParticipants.every((p) =>
      this.isPlayerDoneInCurrentStage(type, state.roundState, p.id),
    );
  }

  private async advanceIfAllConnectedActed(state: RoomState, nowMs: number): Promise<RoomState> {
    let current = state;
    for (let guard = 0; guard < 3; guard += 1) {
      if (!this.allConnectedPlayersActed(current)) break;
      if (current.roundTypeId === 'who_am_i' && current.roundState) {
        current = {
          ...current,
          roundState: { ...(current.roundState as Record<string, unknown>), closed: true },
        };
      }
      current = await this.advance(current, nowMs);
    }
    return current;
  }

  private async pickContent(
    state: RoomState,
    type: AnyRoundType,
    difficulty: 1 | 2 | 3 | 4 | 5 | undefined,
  ): Promise<ContentItem[]> {
    const shape = type.contentShapes[0]!;
    // Room size, not a constant: قطع الأرض plays a bigger board in a bigger room, so how much
    // content a round eats is a property of this match rather than of the type alone.
    const count = itemsNeeded(type, state.players.length);
    const query = {
      categoryIds: state.config.categoryIds,
      shape,
      count,
      difficulty,
    };

    let items = await this.content.pick({ ...query, excludeIds: state.usedContentIds });
    if (items.length < count) {
      // A long match in a narrow category can exhaust the pool. Repeating a question is a far
      // better failure than crashing the match, so the exclusion list is dropped as a last
      // resort rather than treated as a hard constraint.
      items = await this.content.pick(query);
    }
    if (items.length < count) {
      throw new EngineError(`مفيش أسئلة كفاية من نوع "${shape}" في المجالات المختارة`);
    }
    return items;
  }

  private async availableShapes(
    categoryIds: string[],
    playerCount: number,
  ): Promise<ContentShape[]> {
    const shapes = new Set<ContentShape>();
    for (const type of ROUND_TYPES) {
      const needed = itemsNeeded(type, playerCount);
      const enough = await Promise.all(
        type.contentShapes.map(async (shape) => ({
          shape,
          ok: (await this.content.countBy(categoryIds, shape)) >= needed,
        })),
      );
      if (enough.every((e) => e.ok)) for (const e of enough) shapes.add(e.shape);
    }
    return [...shapes];
  }

  private async allocateCode(): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = generateCode(this.opts.rng);
      if (await this.store.reserveCode(code)) return code;
    }
    throw new EngineError('مقدرناش نعمل كود غرفة جديد، حاول تاني');
  }

  private makePlayer(nickname: string, nowMs: number): RoomPlayer {
    return {
      id: nanoid(10),
      nickname: nickname.trim().slice(0, 16),
      connected: true,
      teamId: null,
      token: nanoid(24),
      joinedAtMs: nowMs,
      disconnectedAtMs: null,
      leftEarly: false,
      ready: false,
    };
  }

  private assertHost(state: RoomState, playerId: PlayerId): void {
    if (state.hostId !== playerId) throw new EngineError('الهوست بس اللي يقدر يعمل كده');
  }

  private touch(state: RoomState): RoomState {
    return { ...state, updatedAtMs: this.opts.now() };
  }

  private async requireRoom(code: string): Promise<RoomState> {
    const room = await this.store.get(code);
    if (!room) throw new RoomNotFoundError(code);
    return room;
  }
}

/**
 * Splits the room into two sides, keeping anybody already placed where they are.
 *
 * New joiners land on whichever side is smaller, so a room that fills up one player at a time
 * still ends up balanced without the host having to shuffle people around.
 */
function assignTeams(players: RoomPlayer[]): RoomPlayer[] {
  const counts = new Map(TEAMS.map((t) => [t.id, 0]));
  for (const player of players) {
    if (player.teamId && counts.has(player.teamId)) {
      counts.set(player.teamId, counts.get(player.teamId)! + 1);
    }
  }

  return players.map((player) => {
    if (player.teamId && counts.has(player.teamId)) return player;
    const smallest = [...counts.entries()].sort((a, b) => a[1] - b[1])[0]!;
    counts.set(smallest[0], smallest[1] + 1);
    return { ...player, teamId: smallest[0] };
  });
}

/**
 * Re-splits a room whose membership changed, rather than honouring the old sides.
 *
 * `assignTeams` deliberately leaves placed players alone, which is right when somebody joins
 * and wrong when somebody leaves: dropping one player from a 3–2 room leaves 2–2 or 3–1, and
 * only one of those is a match. Clearing first is what lets the same placement rule produce a
 * balanced result either way.
 */
function rebalanceTeams(players: RoomPlayer[]): RoomPlayer[] {
  return assignTeams(players.map((p) => ({ ...p, teamId: null })));
}

function teamStandingsFor(state: RoomState, totals: PlayerTotals[]) {
  if (!state.config.teams) return [];
  const membership = new Map(
    state.players.filter((p) => p.teamId).map((p) => [p.id, p.teamId!] as const),
  );
  return rankTeams(totals, membership, TEAMS.map((t) => t.id));
}
