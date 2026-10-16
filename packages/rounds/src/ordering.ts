import {
  type ActionCtx,
  type ContentItem,
  type OrderingContent,
  type PlayerId,
  type RoundInit,
  type RoundScore,
  type RoundType,
  type StepResult,
} from '@game/shared';

const MAX_POINTS = 200;

export interface OrderingState {
  item: OrderingContent;
  playerIds: PlayerId[];
  startedAtMs: number;
  endsAtMs: number;
  /** The items as presented, shuffled deterministically from the stored correct order. */
  shuffled: string[];
  /** playerId → the indices of `shuffled`, in the order they tapped them. */
  arrangements: Record<PlayerId, number[]>;
  lockedAtMs: Record<PlayerId, number>;
  closed: boolean;
}

export type OrderingAction = { kind: 'place'; index: number } | { kind: 'undo' } | { kind: 'lock' };

const noChange = (state: OrderingState): StepResult<OrderingState> => ({ state, events: [] });

/** Deterministic shuffle — the state has to be reproducible, so no RNG. */
function stableHash(input: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/**
 * رتّب صح — put four things in the right sequence.
 *
 * The only round where partial knowledge pays partial points: getting two of four positions
 * right is worth exactly half. That changes how it feels to play — you are not hunting for one
 * fact you either have or don't, you are assembling what you do know and guessing the rest,
 * which is a genuinely different kind of thinking from the rest of the playlist.
 *
 * Tapping rather than dragging, because drag-and-drop on a phone during a timed round is
 * miserable and drops inputs.
 */
export const ordering: RoundType<OrderingState, OrderingAction> = {
  id: 'ordering',
  nameAr: 'رتّب صح',
  taglineAr: 'دوس على الحاجات بالترتيب الصح — واحدة ورا التانية',
  scoringHintAr: 'كل حاجة في مكانها الصح = 50 نقطة',
  contentShapes: ['ordering'],
  itemsPerRound: 1,
  pacing: 'thinking',
  long: false,
  minPlayers: 2,
  requiresTeams: false,
  durationMs: 30_000,
  /** The right order shown against yours. */
  revealWeight: 1.2,
  accent: 'sky',
  supportsSuddenDeath: false,

  createState(content: ContentItem[], init: RoundInit): OrderingState {
    const item = content[0];
    if (!item || item.shape !== 'ordering') throw new Error('ordering requires one ordering item');
    const playerIds = init.players.map((p) => p.id);

    const shuffled = [...item.items].sort(
      (a, b) => stableHash(a + item.id) - stableHash(b + item.id),
    );

    return {
      item,
      playerIds,
      startedAtMs: init.startedAtMs,
      endsAtMs: init.endsAtMs,
      shuffled,
      arrangements: Object.fromEntries(playerIds.map((id) => [id, []])),
      lockedAtMs: {},
      closed: false,
    };
  },

  reduce(state, action, ctx): StepResult<OrderingState> {
    if (state.closed || ctx.nowMs > state.endsAtMs) return noChange(state);
    if (!state.playerIds.includes(ctx.playerId)) return noChange(state);
    if (state.lockedAtMs[ctx.playerId] !== undefined) return noChange(state);

    const mine = state.arrangements[ctx.playerId] ?? [];

    if (action.kind === 'undo') {
      if (mine.length === 0) return noChange(state);
      return {
        state: { ...state, arrangements: { ...state.arrangements, [ctx.playerId]: mine.slice(0, -1) } },
        events: [],
      };
    }

    if (action.kind === 'place') {
      if (!Number.isInteger(action.index)) return noChange(state);
      if (action.index < 0 || action.index >= state.shuffled.length) return noChange(state);
      if (mine.includes(action.index)) return noChange(state);

      const placed = [...mine, action.index];
      const next: OrderingState = {
        ...state,
        arrangements: { ...state.arrangements, [ctx.playerId]: placed },
      };

      // A full arrangement locks itself — there is nothing left to decide.
      if (placed.length === state.shuffled.length) {
        next.lockedAtMs = { ...state.lockedAtMs, [ctx.playerId]: ctx.nowMs };
        next.closed = next.playerIds.every((id) => next.lockedAtMs[id] !== undefined);
        return {
          state: next,
          events: next.closed
            ? [{ type: 'player_locked', playerId: ctx.playerId }, { type: 'all_locked' }]
            : [{ type: 'player_locked', playerId: ctx.playerId }],
        };
      }
      return { state: next, events: [] };
    }

    if (action.kind === 'lock') {
      if (mine.length === 0) return noChange(state);
      const next: OrderingState = {
        ...state,
        lockedAtMs: { ...state.lockedAtMs, [ctx.playerId]: ctx.nowMs },
      };
      next.closed = next.playerIds.every((id) => next.lockedAtMs[id] !== undefined);
      return {
        state: next,
        events: next.closed
          ? [{ type: 'player_locked', playerId: ctx.playerId }, { type: 'all_locked' }]
          : [{ type: 'player_locked', playerId: ctx.playerId }],
      };
    }

    return noChange(state);
  },

  onDeadline(state): StepResult<OrderingState> {
    if (state.closed) return noChange(state);
    return { state: { ...state, closed: true }, events: [] };
  },

  view(state, playerId) {
    const mine = state.arrangements[playerId] ?? [];
    return {
      textAr: state.item.textAr,
      // The shuffled labels only. The correct sequence lives in `item.items`, which never ships.
      items: state.shuffled,
      myOrder: mine,
      isLocked: state.lockedAtMs[playerId] !== undefined,
      lockedCount: Object.keys(state.lockedAtMs).length,
      totalPlayers: state.playerIds.length,
    };
  },

  reveal(state) {
    return {
      textAr: state.item.textAr,
      correctOrder: state.item.items,
      labels: state.item.labels,
      explanationAr: state.item.explanationAr ?? null,
    };
  },

  isFinished(state) {
    return state.closed;
  },

  nextDeadline(state) {
    return state.closed ? null : state.endsAtMs;
  },

  roundScores(state): RoundScore[] {
    const perItem = MAX_POINTS / state.item.items.length;

    return state.playerIds.map((playerId) => {
      const mine = state.arrangements[playerId] ?? [];
      if (mine.length === 0) return { playerId, points: 0, isCorrect: false, msTaken: null };

      let correctPositions = 0;
      for (const [position, shuffledIndex] of mine.entries()) {
        if (state.shuffled[shuffledIndex] === state.item.items[position]) correctPositions += 1;
      }

      const lockedAt = state.lockedAtMs[playerId];
      return {
        playerId,
        points: Math.round(perItem * correctPositions),
        isCorrect: correctPositions === state.item.items.length,
        msTaken: lockedAt === undefined ? null : Math.max(0, lockedAt - state.startedAtMs),
      };
    });
  },
};
