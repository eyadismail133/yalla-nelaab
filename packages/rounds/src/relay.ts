import {
  type ActionCtx,
  type ContentItem,
  type DeadlineCtx,
  type McqContent,
  type PlayerId,
  type RoundInit,
  type RoundEvent,
  type RoundScore,
  type RoundType,
  type StepResult,
} from '@game/shared';

/** Four questions per team, one per rung of the ladder each team climbs. */
export const RELAY_RUNGS = 4;
export const RELAY_ITEMS = RELAY_RUNGS * 2;
const TURN_MS = 15_000;
const FULL_POINTS = 200;

export interface RelayState {
  /** Two decks, one per team, never shared — a team never hears the other's question. */
  itemsByTeam: Record<string, McqContent[]>;
  playerIds: PlayerId[];
  teamOf: Record<PlayerId, string>;
  teamIds: string[];
  /** Turn order per team, fixed for the whole round. */
  order: Record<string, PlayerId[]>;
  activeIndex: Record<string, number>;
  /** How many of a team's four questions have been resolved — also its index into the deck. */
  asked: Record<string, number>;
  /** Net rung reached so far, floored at 0. Can only reach RELAY_RUNGS with a clean sweep. */
  rung: Record<string, number>;
  turnDeadlineAtMs: Record<string, number>;
  /** Set only by a real answer — a forced timeout is not a decisive action. */
  lastActionAtMs: Record<string, number>;
  /** Index-aligned with each team's deck; null means the turn timed out with nobody answering. */
  answeredBy: Record<string, Array<PlayerId | null>>;
  startedAtMs: number;
  endsAtMs: number;
  closed: boolean;
}

export type RelayAction = { kind: 'answer'; choice: number };

const noChange = (state: RelayState): StepResult<RelayState> => ({ state, events: [] });

const teamDone = (state: RelayState, teamId: string): boolean =>
  (state.asked[teamId] ?? 0) >= RELAY_RUNGS;

const activePlayerOf = (state: RelayState, teamId: string): PlayerId | null => {
  const order = state.order[teamId] ?? [];
  if (order.length === 0) return null;
  return order[(state.activeIndex[teamId] ?? 0) % order.length]!;
};

/** Resolves the current turn for a team — a real answer or a forced timeout, same shape. */
function resolveTurn(
  state: RelayState,
  teamId: string,
  correct: boolean,
  nowMs: number,
  playerId: PlayerId | null,
): RelayState {
  const askedBefore = state.asked[teamId] ?? 0;
  const asked = askedBefore + 1;
  const rung = Math.max(0, (state.rung[teamId] ?? 0) + (correct ? 1 : -1));
  const order = state.order[teamId] ?? [];
  const activeIndex = order.length > 0 ? ((state.activeIndex[teamId] ?? 0) + 1) % order.length : 0;

  const answeredBy = [...(state.answeredBy[teamId] ?? [])];
  answeredBy[askedBefore] = playerId;

  return {
    ...state,
    asked: { ...state.asked, [teamId]: asked },
    rung: { ...state.rung, [teamId]: rung },
    activeIndex: { ...state.activeIndex, [teamId]: activeIndex },
    answeredBy: { ...state.answeredBy, [teamId]: answeredBy },
    turnDeadlineAtMs: { ...state.turnDeadlineAtMs, [teamId]: nowMs + TURN_MS },
  };
}

/**
 * التتابع — two teams climb their own four-rung ladder in parallel, one player answering at a
 * time and the turn rotating through the team after every question.
 *
 * Each team's four questions are its own — the other side never sees or hears them, so there is
 * nothing to overhear. A wrong answer (or a turn that times out with nobody answering) drops the
 * team a rung rather than just costing the point, which is what makes four-for-four the only
 * route to the ceiling: with exactly four questions and one slip anywhere, the team cannot climb
 * back to the top in the turns it has left.
 *
 * The fifteen-second per-turn clock exists for one reason: a disconnected player must not be
 * able to freeze their whole team's progress for the rest of the round.
 */
export const relay: RoundType<RelayState, RelayAction> = {
  id: 'relay',
  nameAr: 'التتابع',
  taglineAr: 'كل فريق بيتسلّم الدور — واحد يجاوب والباقي يوجّهوه',
  scoringHintAr: 'كل سؤال صح يطلعك درجة، وغلط ينزّلك — أربعة صح ورا بعض = 200',
  contentShapes: ['mcq'],
  itemsPerRound: RELAY_ITEMS,
  pacing: 'fast',
  long: true,
  minPlayers: 4,
  requiresTeams: true,
  durationMs: 90_000,
  /** Two ladders and who fumbled where. */
  revealWeight: 1.5,
  accent: 'emerald',
  supportsSuddenDeath: false,

  createState(content: ContentItem[], init: RoundInit): RelayState {
    const items = content.filter((c): c is McqContent => c.shape === 'mcq');
    if (items.length !== RELAY_ITEMS) {
      throw new Error(`relay requires exactly ${RELAY_ITEMS} mcq items`);
    }
    const playerIds = init.players.map((p) => p.id);
    const teamOf = Object.fromEntries(init.players.map((p) => [p.id, p.teamId ?? `solo-${p.id}`]));
    const teamIds = [...new Set(playerIds.map((id) => teamOf[id]!))];
    if (teamIds.length !== 2) {
      throw new Error('relay requires exactly two teams');
    }

    const itemsByTeam: Record<string, McqContent[]> = {
      [teamIds[0]!]: items.slice(0, RELAY_RUNGS),
      [teamIds[1]!]: items.slice(RELAY_RUNGS, RELAY_ITEMS),
    };
    const order: Record<string, PlayerId[]> = Object.fromEntries(
      teamIds.map((teamId) => [teamId, playerIds.filter((id) => teamOf[id] === teamId)]),
    );

    return {
      itemsByTeam,
      playerIds,
      teamOf,
      teamIds,
      order,
      activeIndex: Object.fromEntries(teamIds.map((id) => [id, 0])),
      asked: Object.fromEntries(teamIds.map((id) => [id, 0])),
      rung: Object.fromEntries(teamIds.map((id) => [id, 0])),
      turnDeadlineAtMs: Object.fromEntries(teamIds.map((id) => [id, init.startedAtMs + TURN_MS])),
      lastActionAtMs: {},
      answeredBy: Object.fromEntries(teamIds.map((id) => [id, Array(RELAY_RUNGS).fill(null)])),
      startedAtMs: init.startedAtMs,
      endsAtMs: init.endsAtMs,
      closed: false,
    };
  },

  reduce(state, action, ctx): StepResult<RelayState> {
    if (state.closed || ctx.nowMs > state.endsAtMs) return noChange(state);
    if (action.kind !== 'answer') return noChange(state);
    if (!state.playerIds.includes(ctx.playerId)) return noChange(state);
    if (!Number.isInteger(action.choice) || action.choice < 0 || action.choice > 3) {
      return noChange(state);
    }

    const teamId = state.teamOf[ctx.playerId];
    if (!teamId || teamDone(state, teamId)) return noChange(state);
    if (activePlayerOf(state, teamId) !== ctx.playerId) return noChange(state);
    if (ctx.nowMs > (state.turnDeadlineAtMs[teamId] ?? Infinity)) return noChange(state);

    const asked = state.asked[teamId] ?? 0;
    const item = (state.itemsByTeam[teamId] ?? [])[asked];
    if (!item) return noChange(state);

    const correct = action.choice === item.correctIndex;
    let next = resolveTurn(state, teamId, correct, ctx.nowMs, ctx.playerId);
    next = { ...next, lastActionAtMs: { ...next.lastActionAtMs, [teamId]: ctx.nowMs } };

    const allDone = next.teamIds.every((id) => teamDone(next, id));
    if (allDone) next = { ...next, closed: true };

    const events: RoundEvent[] = [{ type: 'sub_round_advanced', index: next.asked[teamId] ?? 0 }];
    if (allDone) events.push({ type: 'all_locked' });
    return { state: next, events };
  },

  onDeadline(state, ctx: DeadlineCtx): StepResult<RelayState> {
    if (state.closed) return noChange(state);

    let next = state;
    for (const teamId of next.teamIds) {
      if (teamDone(next, teamId)) continue;
      if (ctx.nowMs >= (next.turnDeadlineAtMs[teamId] ?? Infinity)) {
        // Nobody answered in time — the turn is lost as if wrong, and passes to the next player.
        next = resolveTurn(next, teamId, false, ctx.nowMs, null);
      }
    }

    const allDone = next.teamIds.every((id) => teamDone(next, id));
    const timeUp = ctx.nowMs >= next.endsAtMs;
    if (allDone || timeUp) next = { ...next, closed: true };

    return { state: next, events: [] };
  },

  view(state, playerId) {
    const teamId = state.teamOf[playerId];
    const asked = teamId ? (state.asked[teamId] ?? 0) : 0;
    const item = teamId && asked < RELAY_RUNGS ? state.itemsByTeam[teamId]?.[asked] : undefined;
    const activeId = teamId ? activePlayerOf(state, teamId) : null;

    return {
      myTeamId: teamId ?? null,
      myRung: teamId ? (state.rung[teamId] ?? 0) : 0,
      otherTeams: state.teamIds
        .filter((id) => id !== teamId)
        .map((id) => ({ teamId: id, rung: state.rung[id] ?? 0, asked: state.asked[id] ?? 0 })),
      activePlayerId: activeId,
      canAnswer: activeId === playerId,
      // The whole team sees the live question — only the active player can submit an answer,
      // enforced server-side regardless of what a client sends.
      current: item ? { textAr: item.textAr, options: item.options } : null,
      askedCount: asked,
      totalRungs: RELAY_RUNGS,
    };
  },

  reveal(state) {
    return {
      teams: state.teamIds.map((teamId) => ({
        teamId,
        finalRung: state.rung[teamId] ?? 0,
        items: (state.itemsByTeam[teamId] ?? []).map((item, i) => ({
          textAr: item.textAr,
          options: item.options,
          correctIndex: item.correctIndex,
          answeredBy: state.answeredBy[teamId]?.[i] ?? null,
        })),
      })),
    };
  },

  isFinished(state) {
    return state.closed;
  },

  nextDeadline(state) {
    if (state.closed) return null;
    const pending = state.teamIds
      .filter((id) => !teamDone(state, id))
      .map((id) => state.turnDeadlineAtMs[id])
      .filter((ms): ms is number => ms !== undefined);
    const earliestTurn = pending.length > 0 ? Math.min(...pending) : state.endsAtMs;
    return Math.min(state.endsAtMs, earliestTurn);
  },

  roundScores(state): RoundScore[] {
    return state.playerIds.map((playerId) => {
      const teamId = state.teamOf[playerId];
      if (!teamId) return { playerId, points: 0, isCorrect: false, msTaken: null };

      const rung = state.rung[teamId] ?? 0;
      const points = Math.round((FULL_POINTS * rung) / RELAY_RUNGS);
      const lastAt = state.lastActionAtMs[teamId];

      return {
        playerId,
        points,
        isCorrect: rung === RELAY_RUNGS,
        msTaken: lastAt === undefined ? null : Math.max(0, lastAt - state.startedAtMs),
      };
    });
  },
};
