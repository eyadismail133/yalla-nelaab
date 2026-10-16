import {
  type ActionCtx,
  type ContentItem,
  type McqContent,
  type PlayerId,
  type RoundInit,
  type RoundScore,
  type RoundType,
  type StepResult,
} from '@game/shared';

export const LADDER_QUESTIONS = 5;
/** Value of banking after climbing this many rungs. Index 0 = one correct answer. */
const LADDER_POINTS = [25, 60, 110, 155, 200] as const;

export interface LadderState {
  items: McqContent[];
  playerIds: PlayerId[];
  startedAtMs: number;
  endsAtMs: number;
  /** How many rungs each player has climbed — also their index into `items`. */
  rung: Record<PlayerId, number>;
  busted: Record<PlayerId, boolean>;
  /** Only a locked player's rung counts for points — see roundScores. */
  locked: Record<PlayerId, boolean>;
  lockedAtMs: Record<PlayerId, number>;
  closed: boolean;
}

export type LadderAction = { kind: 'answer'; choice: number } | { kind: 'lock' };

const noChange = (state: LadderState): StepResult<LadderState> => ({ state, events: [] });

const isSettled = (state: LadderState, playerId: PlayerId): boolean =>
  (state.busted[playerId] ?? false) || (state.locked[playerId] ?? false);

/**
 * السلّم — climb one multiple-choice question at a time. A wrong answer drops you all the way
 * to zero; only a player who taps "اقفل واحفظ" actually banks what they climbed.
 *
 * This is the sharpest risk decision in the playlist. Running out the clock without locking
 * pays nothing at all — the same as busting — so standing still is never the safe option the
 * way it is everywhere else. The only way to protect points already earned is to stop
 * deliberately, which means every step past the first is a real choice between more points and
 * the ones already on the table.
 */
export const ladder: RoundType<LadderState, LadderAction> = {
  id: 'ladder',
  nameAr: 'السلّم',
  taglineAr: 'إمشي على السلّم سؤال سؤال — صح تطلع، غلط تقع، وإنت اللي بتقرر تقفل إمتى',
  scoringHintAr: 'كل درجة بتساوي أكتر: 25 / 60 / 110 / 155 / 200 — لازم تقفل عشان تاخدها',
  contentShapes: ['mcq'],
  itemsPerRound: LADDER_QUESTIONS,
  pacing: 'thinking',
  long: true,
  minPlayers: 2,
  requiresTeams: false,
  durationMs: 75_000,
  /** The ladder itself, plus who bailed where. */
  revealWeight: 1.4,
  accent: 'rose',
  supportsSuddenDeath: false,

  createState(content: ContentItem[], init: RoundInit): LadderState {
    const items = content.filter((c): c is McqContent => c.shape === 'mcq');
    if (items.length !== LADDER_QUESTIONS) {
      throw new Error(`ladder requires exactly ${LADDER_QUESTIONS} mcq items`);
    }
    const playerIds = init.players.map((p) => p.id);
    return {
      items,
      playerIds,
      startedAtMs: init.startedAtMs,
      endsAtMs: init.endsAtMs,
      rung: Object.fromEntries(playerIds.map((id) => [id, 0])),
      busted: {},
      locked: {},
      lockedAtMs: {},
      closed: false,
    };
  },

  reduce(state, action, ctx): StepResult<LadderState> {
    if (state.closed || ctx.nowMs > state.endsAtMs) return noChange(state);
    if (!state.playerIds.includes(ctx.playerId)) return noChange(state);
    if (isSettled(state, ctx.playerId)) return noChange(state);

    if (action.kind === 'lock') {
      const rung = state.rung[ctx.playerId] ?? 0;
      if (rung === 0) return noChange(state);

      const next: LadderState = {
        ...state,
        locked: { ...state.locked, [ctx.playerId]: true },
        lockedAtMs: { ...state.lockedAtMs, [ctx.playerId]: ctx.nowMs },
      };
      next.closed = next.playerIds.every((id) => isSettled(next, id));
      const events: StepResult<LadderState>['events'] = [
        { type: 'player_locked', playerId: ctx.playerId },
      ];
      if (next.closed) events.push({ type: 'all_locked' });
      return { state: next, events };
    }

    if (action.kind === 'answer') {
      if (!Number.isInteger(action.choice) || action.choice < 0 || action.choice > 3) {
        return noChange(state);
      }
      const rung = state.rung[ctx.playerId] ?? 0;
      if (rung >= state.items.length) return noChange(state);

      const item = state.items[rung]!;
      const correct = action.choice === item.correctIndex;

      if (!correct) {
        const next: LadderState = { ...state, busted: { ...state.busted, [ctx.playerId]: true } };
        next.closed = next.playerIds.every((id) => isSettled(next, id));
        const events: StepResult<LadderState>['events'] = [
          { type: 'player_locked', playerId: ctx.playerId },
        ];
        if (next.closed) events.push({ type: 'all_locked' });
        return { state: next, events };
      }

      const newRung = rung + 1;
      let next: LadderState = { ...state, rung: { ...state.rung, [ctx.playerId]: newRung } };

      // Nothing left to climb — the top of the ladder banks itself.
      if (newRung === state.items.length) {
        next = {
          ...next,
          locked: { ...next.locked, [ctx.playerId]: true },
          lockedAtMs: { ...next.lockedAtMs, [ctx.playerId]: ctx.nowMs },
        };
      }
      next.closed = next.playerIds.every((id) => isSettled(next, id));

      const events: StepResult<LadderState>['events'] = [
        { type: 'sub_round_advanced', index: newRung },
      ];
      if (newRung === state.items.length) events.push({ type: 'player_locked', playerId: ctx.playerId });
      if (next.closed) events.push({ type: 'all_locked' });
      return { state: next, events };
    }

    return noChange(state);
  },

  onDeadline(state): StepResult<LadderState> {
    if (state.closed) return noChange(state);
    return { state: { ...state, closed: true }, events: [] };
  },

  view(state, playerId) {
    const rung = state.rung[playerId] ?? 0;
    const settled = isSettled(state, playerId);
    const current = !settled && rung < state.items.length ? state.items[rung] : undefined;

    return {
      ladder: LADDER_POINTS,
      rung,
      isBusted: state.busted[playerId] ?? false,
      isLocked: state.locked[playerId] ?? false,
      current: current ? { textAr: current.textAr, options: current.options } : null,
      bankedValue: state.locked[playerId] ? (LADDER_POINTS[Math.min(rung, LADDER_POINTS.length) - 1] ?? 0) : null,
      doneCount: state.playerIds.filter((id) => isSettled(state, id)).length,
      totalPlayers: state.playerIds.length,
    };
  },

  reveal(state) {
    return {
      items: state.items.map((item) => ({
        textAr: item.textAr,
        options: item.options,
        correctIndex: item.correctIndex,
        explanationAr: item.explanationAr ?? null,
      })),
      results: state.playerIds.map((id) => ({
        playerId: id,
        rung: state.rung[id] ?? 0,
        busted: state.busted[id] ?? false,
        locked: state.locked[id] ?? false,
      })),
    };
  },

  isFinished(state) {
    return state.closed;
  },

  nextDeadline(state) {
    return state.closed ? null : state.endsAtMs;
  },

  roundScores(state): RoundScore[] {
    return state.playerIds.map((playerId) => {
      if (!state.locked[playerId]) return { playerId, points: 0, isCorrect: false, msTaken: null };

      const rung = state.rung[playerId] ?? 0;
      const points = LADDER_POINTS[Math.min(rung, LADDER_POINTS.length) - 1] ?? 0;
      const lockedAt = state.lockedAtMs[playerId];

      return {
        playerId,
        points,
        isCorrect: rung === state.items.length,
        msTaken: lockedAt === undefined ? null : Math.max(0, lockedAt - state.startedAtMs),
      };
    });
  },
};
