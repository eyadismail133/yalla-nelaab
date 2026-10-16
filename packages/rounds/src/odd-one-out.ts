import {
  type ActionCtx,
  type ContentItem,
  type OddOneOutContent,
  type PlayerId,
  type RoundInit,
  type RoundScore,
  type RoundType,
  type StepResult,
} from '@game/shared';

export const ODD_ONE_OUT_ITEMS = 3;
/** Sums to 200 across three puzzles without a repeating decimal. */
const POINTS = [67, 67, 66] as const;

export interface OddOneOutState {
  items: OddOneOutContent[];
  playerIds: PlayerId[];
  startedAtMs: number;
  endsAtMs: number;
  /** Index-aligned with `items`; null means that puzzle is still open for this player. */
  answers: Record<PlayerId, Array<number | null>>;
  lastActionAtMs: Record<PlayerId, number>;
  closed: boolean;
}

export type OddOneOutAction = { kind: 'answer'; index: number; choice: number };

const noChange = (state: OddOneOutState): StepResult<OddOneOutState> => ({ state, events: [] });

const isDone = (state: OddOneOutState, playerId: PlayerId): boolean =>
  (state.answers[playerId] ?? []).every((a) => a !== null);

/**
 * الدخيل — three groups of four things on screen at once, each hiding one that does not belong.
 *
 * All three puzzles are visible together rather than one at a time, which is what separates it
 * from every other round that walks a player through several items in sequence — a player can
 * jump to whichever puzzle they already see the answer to, instead of being forced through them
 * in the order the content happened to load. No speed bonus and no penalty: this is a knowledge
 * round, not a reflex or a risk one, and the playlist already has both of those covered.
 */
export const oddOneOut: RoundType<OddOneOutState, OddOneOutAction> = {
  id: 'odd_one_out',
  nameAr: 'الدخيل',
  taglineAr: 'تلات مجموعات، كل واحدة فيها حاجة مش زي الباقي — لقّطها',
  scoringHintAr: 'كل مجموعة صح تقريبًا 67 نقطة — التلاتة صح = 200',
  contentShapes: ['odd_one_out'],
  itemsPerRound: ODD_ONE_OUT_ITEMS,
  pacing: 'thinking',
  long: false,
  minPlayers: 2,
  requiresTeams: false,
  durationMs: 45_000,
  /** Three little arguments to have — "ليه هو الغريب؟" three times over. */
  revealWeight: 1.3,
  accent: 'sky',
  supportsSuddenDeath: false,

  createState(content: ContentItem[], init: RoundInit): OddOneOutState {
    const items = content.filter((c): c is OddOneOutContent => c.shape === 'odd_one_out');
    if (items.length !== ODD_ONE_OUT_ITEMS) {
      throw new Error(`odd_one_out requires exactly ${ODD_ONE_OUT_ITEMS} odd_one_out items`);
    }
    const playerIds = init.players.map((p) => p.id);
    return {
      items,
      playerIds,
      startedAtMs: init.startedAtMs,
      endsAtMs: init.endsAtMs,
      answers: Object.fromEntries(playerIds.map((id) => [id, Array(ODD_ONE_OUT_ITEMS).fill(null)])),
      lastActionAtMs: {},
      closed: false,
    };
  },

  reduce(state, action, ctx): StepResult<OddOneOutState> {
    if (state.closed || ctx.nowMs > state.endsAtMs) return noChange(state);
    if (action.kind !== 'answer') return noChange(state);
    if (!state.playerIds.includes(ctx.playerId)) return noChange(state);
    if (!Number.isInteger(action.index) || action.index < 0 || action.index >= ODD_ONE_OUT_ITEMS) {
      return noChange(state);
    }
    if (!Number.isInteger(action.choice) || action.choice < 0 || action.choice > 3) {
      return noChange(state);
    }

    const mine = [...(state.answers[ctx.playerId] ?? [])];
    if (mine[action.index] !== null) return noChange(state);
    mine[action.index] = action.choice;

    const next: OddOneOutState = {
      ...state,
      answers: { ...state.answers, [ctx.playerId]: mine },
      lastActionAtMs: { ...state.lastActionAtMs, [ctx.playerId]: ctx.nowMs },
    };

    const playerDone = mine.every((a) => a !== null);
    next.closed = next.playerIds.every((id) => isDone(next, id));

    const events: StepResult<OddOneOutState>['events'] = playerDone
      ? [{ type: 'player_locked', playerId: ctx.playerId }]
      : [];
    if (next.closed) events.push({ type: 'all_locked' });
    return { state: next, events };
  },

  onDeadline(state): StepResult<OddOneOutState> {
    if (state.closed) return noChange(state);
    return { state: { ...state, closed: true }, events: [] };
  },

  view(state, playerId) {
    const mine = state.answers[playerId] ?? Array(ODD_ONE_OUT_ITEMS).fill(null);
    return {
      puzzles: state.items.map((item) => ({ textAr: item.textAr, items: item.items })),
      myAnswers: mine,
      isDone: mine.every((a) => a !== null),
      lockedCount: state.playerIds.filter((id) => isDone(state, id)).length,
      totalPlayers: state.playerIds.length,
    };
  },

  reveal(state) {
    return {
      puzzles: state.items.map((item) => ({
        textAr: item.textAr,
        items: item.items,
        oddIndex: item.oddIndex,
        reasonAr: item.reasonAr,
        explanationAr: item.explanationAr ?? null,
      })),
      answers: state.answers,
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
      const mine = state.answers[playerId] ?? [];
      let points = 0;
      let correctCount = 0;
      let answered = 0;

      for (const [i, item] of state.items.entries()) {
        const given = mine[i];
        if (given === null || given === undefined) continue;
        answered += 1;
        if (given === item.oddIndex) {
          points += POINTS[i] ?? 0;
          correctCount += 1;
        }
      }

      const lastAt = state.lastActionAtMs[playerId];
      return {
        playerId,
        points,
        isCorrect: correctCount === state.items.length,
        msTaken: answered > 0 && lastAt !== undefined ? Math.max(0, lastAt - state.startedAtMs) : null,
      };
    });
  },
};
