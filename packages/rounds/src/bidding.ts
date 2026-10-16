import {
  type ActionCtx,
  type ContentItem,
  type DeadlineCtx,
  type McqContent,
  type PlayerId,
  type RoundInit,
  type RoundScore,
  type RoundType,
  type StepResult,
} from '@game/shared';

export const BIDDING_QUESTIONS = 4;
export const MAX_BID = 4;
const POINTS_PER_BID = 50;
const BID_MS = 12_000;
const ANSWER_MS = 28_000;

export interface BiddingState {
  items: McqContent[];
  playerIds: PlayerId[];
  startedAtMs: number;
  stage: 'bidding' | 'answering' | 'done';
  bidEndsAtMs: number;
  answerEndsAtMs: number | null;
  bids: Record<PlayerId, number>;
  /** Index-aligned with `items`; null means never answered. */
  answers: Record<PlayerId, Array<number | null>>;
  cursor: Record<PlayerId, number>;
  lastActionAtMs: Record<PlayerId, number>;
  closed: boolean;
}

export type BiddingAction =
  | { kind: 'bid'; amount: number }
  | { kind: 'answer'; index: number; choice: number };

const noChange = (state: BiddingState): StepResult<BiddingState> => ({ state, events: [] });

/**
 * المزايدة — say how many of four you will get right, before you see any of them.
 *
 * All-or-nothing on purpose: meeting your bid pays bid × 50, and missing it by one pays zero.
 * That makes the interesting decision happen before the questions arrive, and it is a decision
 * about yourself rather than about the topic — how well do you actually know كورة? A cautious
 * bid of two is safe and small; a bid of four is the round's only route to the ceiling.
 *
 * It is also the one round where a player can lose by knowing too little about their own
 * limits rather than about the subject.
 */
export const bidding: RoundType<BiddingState, BiddingAction> = {
  id: 'bidding',
  nameAr: 'المزايدة',
  taglineAr: 'قول هتجاوب كام سؤال صح من ٤ — قبل ما تشوفهم',
  scoringHintAr: 'وصلت لمزايدتك = المزايدة × 50، قصّرت ولو سؤال = صفر',
  contentShapes: ['mcq'],
  itemsPerRound: BIDDING_QUESTIONS,
  pacing: 'thinking',
  long: true,
  minPlayers: 2,
  requiresTeams: false,
  durationMs: BID_MS + ANSWER_MS,
  /** Four questions plus a bid that landed or collapsed. */
  revealWeight: 1.3,
  accent: 'amber',
  supportsSuddenDeath: false,

  createState(content: ContentItem[], init: RoundInit): BiddingState {
    const items = content.filter((c): c is McqContent => c.shape === 'mcq');
    if (items.length !== BIDDING_QUESTIONS) {
      throw new Error(`bidding requires exactly ${BIDDING_QUESTIONS} mcq items`);
    }
    const playerIds = init.players.map((p) => p.id);
    return {
      items,
      playerIds,
      startedAtMs: init.startedAtMs,
      stage: 'bidding',
      bidEndsAtMs: init.startedAtMs + BID_MS,
      answerEndsAtMs: null,
      bids: {},
      answers: Object.fromEntries(playerIds.map((id) => [id, Array(BIDDING_QUESTIONS).fill(null)])),
      cursor: Object.fromEntries(playerIds.map((id) => [id, 0])),
      lastActionAtMs: {},
      closed: false,
    };
  },

  reduce(state, action, ctx): StepResult<BiddingState> {
    if (state.closed) return noChange(state);
    if (!state.playerIds.includes(ctx.playerId)) return noChange(state);

    if (state.stage === 'bidding' && action.kind === 'bid') {
      if (ctx.nowMs > state.bidEndsAtMs) return noChange(state);
      if (state.bids[ctx.playerId] !== undefined) return noChange(state);
      if (!Number.isInteger(action.amount) || action.amount < 1 || action.amount > MAX_BID) {
        return noChange(state);
      }

      const bids = { ...state.bids, [ctx.playerId]: action.amount };
      const next: BiddingState = { ...state, bids };
      if (state.playerIds.every((id) => bids[id] !== undefined)) {
        return { state: openAnswering(next, ctx.nowMs), events: [{ type: 'all_locked' }] };
      }
      return { state: next, events: [{ type: 'player_locked', playerId: ctx.playerId }] };
    }

    if (state.stage === 'answering' && action.kind === 'answer') {
      if (state.answerEndsAtMs !== null && ctx.nowMs > state.answerEndsAtMs) return noChange(state);
      // A player who never bid sits the stage out rather than playing for free.
      if (state.bids[ctx.playerId] === undefined) return noChange(state);

      const cursor = state.cursor[ctx.playerId] ?? 0;
      if (action.index !== cursor || cursor >= BIDDING_QUESTIONS) return noChange(state);
      if (!Number.isInteger(action.choice) || action.choice < 0 || action.choice > 3) {
        return noChange(state);
      }

      const mine = [...(state.answers[ctx.playerId] ?? [])];
      mine[cursor] = action.choice;

      const next: BiddingState = {
        ...state,
        answers: { ...state.answers, [ctx.playerId]: mine },
        cursor: { ...state.cursor, [ctx.playerId]: cursor + 1 },
        lastActionAtMs: { ...state.lastActionAtMs, [ctx.playerId]: ctx.nowMs },
      };

      const everyoneDone = next.playerIds
        .filter((id) => next.bids[id] !== undefined)
        .every((id) => (next.cursor[id] ?? 0) >= BIDDING_QUESTIONS);
      if (everyoneDone) next.closed = true;

      const events: StepResult<BiddingState>['events'] = [
        { type: 'sub_round_advanced', index: cursor + 1 },
      ];
      if (everyoneDone) events.push({ type: 'all_locked' });
      return { state: next, events };
    }

    return noChange(state);
  },

  onDeadline(state, ctx: DeadlineCtx): StepResult<BiddingState> {
    if (state.stage === 'bidding') {
      const opened = openAnswering(state, ctx.nowMs);
      // Nobody bid, so there is nothing to play for.
      if (state.playerIds.every((id) => state.bids[id] === undefined)) {
        return { state: { ...opened, stage: 'done', closed: true }, events: [] };
      }
      return { state: opened, events: [{ type: 'sub_round_advanced', index: 1 }] };
    }
    if (state.stage === 'answering') {
      return { state: { ...state, stage: 'done', closed: true }, events: [] };
    }
    return noChange(state);
  },

  view(state, playerId) {
    if (state.stage === 'bidding') {
      return {
        stage: 'bidding' as const,
        maxBid: MAX_BID,
        pointsPerBid: POINTS_PER_BID,
        totalQuestions: BIDDING_QUESTIONS,
        myBid: state.bids[playerId] ?? null,
        lockedCount: Object.keys(state.bids).length,
        totalPlayers: state.playerIds.length,
      };
    }

    const cursor = state.cursor[playerId] ?? 0;
    const current = state.items[cursor];
    return {
      stage: 'answering' as const,
      myBid: state.bids[playerId] ?? null,
      // One question at a time, so nobody can scan ahead and regret their bid at leisure.
      current: current
        ? { index: cursor, textAr: current.textAr, options: current.options }
        : null,
      answeredCount: cursor,
      totalQuestions: BIDDING_QUESTIONS,
      isDone: cursor >= BIDDING_QUESTIONS,
      totalPlayers: state.playerIds.length,
    };
  },

  reveal(state) {
    const correctCount = (playerId: PlayerId) =>
      state.items.reduce(
        (sum, item, i) => sum + ((state.answers[playerId] ?? [])[i] === item.correctIndex ? 1 : 0),
        0,
      );

    return {
      items: state.items.map((item) => ({
        textAr: item.textAr,
        options: item.options,
        correctIndex: item.correctIndex,
      })),
      results: state.playerIds
        .filter((id) => state.bids[id] !== undefined)
        .map((playerId) => ({
          playerId,
          bid: state.bids[playerId]!,
          got: correctCount(playerId),
          made: correctCount(playerId) >= state.bids[playerId]!,
        })),
    };
  },

  isFinished(state) {
    return state.closed;
  },

  nextDeadline(state) {
    if (state.closed) return null;
    if (state.stage === 'bidding') return state.bidEndsAtMs;
    return state.answerEndsAtMs;
  },

  roundScores(state): RoundScore[] {
    return state.playerIds.map((playerId) => {
      const bid = state.bids[playerId];
      if (bid === undefined) return { playerId, points: 0, isCorrect: false, msTaken: null };

      const mine = state.answers[playerId] ?? [];
      const got = state.items.reduce(
        (sum, item, i) => sum + (mine[i] === item.correctIndex ? 1 : 0),
        0,
      );
      const made = got >= bid;
      const lastAt = state.lastActionAtMs[playerId];

      return {
        playerId,
        points: made ? bid * POINTS_PER_BID : 0,
        isCorrect: made,
        msTaken: lastAt === undefined ? null : Math.max(0, lastAt - state.startedAtMs),
      };
    });
  },
};

function openAnswering(state: BiddingState, nowMs: number): BiddingState {
  return { ...state, stage: 'answering', answerEndsAtMs: nowMs + ANSWER_MS };
}
