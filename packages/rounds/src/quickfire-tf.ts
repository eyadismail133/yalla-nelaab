import {
  type ActionCtx,
  type BooleanContent,
  type ContentItem,
  type DeadlineCtx,
  type PlayerId,
  type RoundInit,
  type RoundScore,
  type RoundType,
  type StepResult,
} from '@game/shared';

export const QUICKFIRE_ITEMS = 5;
const POINTS_CORRECT = 40;
/** The penalty is the whole point of this round type — see the note below. */
const POINTS_WRONG = -20;

export interface QuickfireState {
  items: BooleanContent[];
  playerIds: PlayerId[];
  startedAtMs: number;
  endsAtMs: number;
  /** Index-aligned with `items`; null means the player never reached or judged it. */
  answers: Record<PlayerId, Array<boolean | null>>;
  cursor: Record<PlayerId, number>;
  lastActionAtMs: Record<PlayerId, number>;
  closed: boolean;
}

export type QuickfireAction = { kind: 'judge'; index: number; value: boolean };

const noChange = (state: QuickfireState): StepResult<QuickfireState> => ({
  state,
  events: [],
});

/**
 * صح ولا غلط السريع — five statements inside one 24-second window.
 *
 * Two design choices carry this round:
 *
 * 1. Players advance through the five statements independently, not in lockstep. Waiting for
 *    the slowest player five times in a row would kill the pace this type exists to provide.
 * 2. A wrong judgement costs 20 points. That turns the round from a reflex test into a
 *    risk decision — burn the clock to be sure, or rush and gamble — which is a genuinely
 *    different kind of thinking from every other type in the playlist. It also lets a
 *    trailing player choose to gamble their way back.
 */
export const quickfireTf: RoundType<QuickfireState, QuickfireAction> = {
  id: 'quickfire_tf',
  nameAr: 'صح ولا غلط',
  taglineAr: '٥ عبارات في ٢٤ ثانية — بس خد بالك، الغلط بيخصم',
  scoringHintAr: 'كل إجابة صح +40، وكل غلطة −20',
  contentShapes: ['boolean'],
  itemsPerRound: QUICKFIRE_ITEMS,
  pacing: 'fast',
  long: false,
  minPlayers: 2,
  requiresTeams: false,
  // Four seconds a statement left no room for the risk decision this round is built on: the
  // −20 only means something if a player can afford to stop and be sure. Five is enough to
  // choose, and still not enough to be comfortable.
  durationMs: 24_000,
  /** Five statements to walk back through. */
  revealWeight: 1.4,
  accent: 'rose',
  supportsSuddenDeath: false,

  createState(content: ContentItem[], init: RoundInit): QuickfireState {
    const items = content.filter((c): c is BooleanContent => c.shape === 'boolean');
    if (items.length !== QUICKFIRE_ITEMS) {
      throw new Error(`quickfire_tf requires exactly ${QUICKFIRE_ITEMS} boolean items`);
    }
    const playerIds = init.players.map((p) => p.id);
    return {
      items,
      playerIds,
      startedAtMs: init.startedAtMs,
      endsAtMs: init.endsAtMs,
      answers: Object.fromEntries(playerIds.map((id) => [id, Array(QUICKFIRE_ITEMS).fill(null)])),
      cursor: Object.fromEntries(playerIds.map((id) => [id, 0])),
      lastActionAtMs: {},
      closed: false,
    };
  },

  reduce(state, action, ctx): StepResult<QuickfireState> {
    if (state.closed || ctx.nowMs > state.endsAtMs) return noChange(state);
    if (action.kind !== 'judge') return noChange(state);
    if (!state.playerIds.includes(ctx.playerId)) return noChange(state);
    if (typeof action.value !== 'boolean') return noChange(state);

    const cursor = state.cursor[ctx.playerId] ?? 0;
    // Only the player's current statement is answerable — a client cannot skip ahead to a
    // statement it has not been shown, or re-answer one it already judged.
    if (action.index !== cursor || cursor >= QUICKFIRE_ITEMS) return noChange(state);

    const mine = [...(state.answers[ctx.playerId] ?? [])];
    mine[cursor] = action.value;

    const next: QuickfireState = {
      ...state,
      answers: { ...state.answers, [ctx.playerId]: mine },
      cursor: { ...state.cursor, [ctx.playerId]: cursor + 1 },
      lastActionAtMs: { ...state.lastActionAtMs, [ctx.playerId]: ctx.nowMs },
    };
    const everyoneDone = next.playerIds.every((id) => (next.cursor[id] ?? 0) >= QUICKFIRE_ITEMS);
    next.closed = everyoneDone;

    const events: StepResult<QuickfireState>['events'] = [
      { type: 'sub_round_advanced', index: cursor + 1 },
    ];
    if (everyoneDone) events.push({ type: 'all_locked' });

    return { state: next, events };
  },

  onDeadline(state): StepResult<QuickfireState> {
    if (state.closed) return noChange(state);
    return { state: { ...state, closed: true }, events: [] };
  },

  view(state, playerId) {
    const cursor = state.cursor[playerId] ?? 0;
    const current = state.items[cursor];
    return {
      // Only ever the statement this player is currently on — the remaining four are not sent,
      // so a player cannot read ahead while others are still on statement one.
      current: current ? { index: cursor, textAr: current.textAr } : null,
      answeredCount: cursor,
      totalItems: QUICKFIRE_ITEMS,
      isDone: cursor >= QUICKFIRE_ITEMS,
      progress: state.playerIds.map((id) => ({ playerId: id, answered: state.cursor[id] ?? 0 })),
    };
  },

  reveal(state) {
    return {
      items: state.items.map((item) => ({
        textAr: item.textAr,
        isTrue: item.isTrue,
        explanationAr: item.explanationAr ?? null,
      })),
      answers: state.answers,
    };
  },

  isFinished(state) {
    return state.closed;
  },

  nextDeadline(state) {
    // The round has one deadline: its own end. Nothing to schedule in between.
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
        if (given === item.isTrue) {
          points += POINTS_CORRECT;
          correctCount += 1;
        } else {
          points += POINTS_WRONG;
        }
      }

      const lastAt = state.lastActionAtMs[playerId];
      return {
        playerId,
        points,
        // "Correct" for this round means a clean sweep — that is what the podium counts.
        isCorrect: correctCount === QUICKFIRE_ITEMS,
        msTaken: answered > 0 && lastAt !== undefined ? Math.max(0, lastAt - state.startedAtMs) : null,
      };
    });
  },
};
