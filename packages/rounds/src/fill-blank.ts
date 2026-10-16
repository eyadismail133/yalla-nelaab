import {
  answersMatch,
  speedBonus,
  type ActionCtx,
  type ContentItem,
  type FillBlankContent,
  type PlayerId,
  type RoundInit,
  type RoundScore,
  type RoundType,
  type StepResult,
} from '@game/shared';

const POINTS_CORRECT = 150;
/**
 * Graded by speed rather than handed to whoever landed first.
 *
 * All-or-nothing was the wrong shape for a typing round: two players who both remembered the
 * proverb instantly could finish 50 points apart because one of them types on a bigger phone.
 * Worse, it got worse as the room grew — in a room of eight, seven people are told they were
 * "not first" for a gap they could not perceive. A decaying bonus still rewards the quickest
 * recall and stops pretending a 200ms difference is a difference in knowledge.
 */
const MAX_SPEED_BONUS = 50;
/** Reading the line and typing an Arabic word is the work, not hesitation. */
const READ_GRACE_MS = 6_000;
/** Typos in Arabic are constant. Three tries keeps it forgiving without making it free. */
export const MAX_ATTEMPTS = 3;

export interface FillBlankState {
  item: FillBlankContent;
  playerIds: PlayerId[];
  startedAtMs: number;
  endsAtMs: number;
  attempts: Record<PlayerId, string[]>;
  solved: Record<PlayerId, number>;
  /** Solve order, kept for the reveal — the scoreboard reads better with a podium of names. */
  solveOrder: PlayerId[];
  closed: boolean;
}

export type FillBlankAction = { kind: 'submit'; text: string };

const noChange = (state: FillBlankState): StepResult<FillBlankState> => ({
  state,
  events: [],
});

/**
 * الكلمة الناقصة — a proverb, lyric or famous line with one word missing, typed freehand.
 *
 * Free text is what makes this feel different from every multiple-choice round: there is
 * nothing to guess from, you either know it or you don't. Answers are compared after Arabic
 * normalization plus declared aliases, so hamza and ta-marbuta spelling never costs a player
 * a point they earned.
 */
export const fillBlank: RoundType<FillBlankState, FillBlankAction> = {
  id: 'fill_blank',
  nameAr: 'الكلمة الناقصة',
  taglineAr: 'كمّل الناقص بنفسك — مفيش اختيارات تساعدك',
  scoringHintAr: 'صح = 150 + لحد 50 على السرعة (أول ٦ ثواني بالنقط كاملة)',
  contentShapes: ['fill_blank'],
  itemsPerRound: 1,
  // Recalling a proverb and typing it out is deliberate work, not reflex — the 25s window is
  // the longest of any type. Labelling it `fast` skewed the playlist to 3 fast : 1 thinking
  // and made the alternation rule unsatisfiable.
  pacing: 'thinking',
  long: false,
  minPlayers: 2,
  requiresTeams: false,
  durationMs: 25_000,
  accent: 'amber',
  supportsSuddenDeath: false,

  createState(content: ContentItem[], init: RoundInit): FillBlankState {
    const item = content[0];
    if (!item || item.shape !== 'fill_blank') {
      throw new Error('fill_blank requires one fill_blank item');
    }
    const playerIds = init.players.map((p) => p.id);
    return {
      item,
      playerIds,
      startedAtMs: init.startedAtMs,
      endsAtMs: init.endsAtMs,
      attempts: Object.fromEntries(playerIds.map((id) => [id, []])),
      solved: {},
      solveOrder: [],
      closed: false,
    };
  },

  reduce(state, action, ctx): StepResult<FillBlankState> {
    if (state.closed || ctx.nowMs > state.endsAtMs) return noChange(state);
    if (action.kind !== 'submit') return noChange(state);
    if (!state.playerIds.includes(ctx.playerId)) return noChange(state);
    if (typeof action.text !== 'string' || action.text.trim().length === 0) return noChange(state);
    if (state.solved[ctx.playerId] !== undefined) return noChange(state);

    const mine = state.attempts[ctx.playerId] ?? [];
    if (mine.length >= MAX_ATTEMPTS) return noChange(state);

    const text = action.text.trim().slice(0, 60);
    const attempts = { ...state.attempts, [ctx.playerId]: [...mine, text] };
    const isCorrect = answersMatch(text, state.item.answerAr, state.item.aliases);

    const next: FillBlankState = { ...state, attempts };
    if (isCorrect) {
      next.solved = { ...state.solved, [ctx.playerId]: ctx.nowMs };
      next.solveOrder = [...state.solveOrder, ctx.playerId];
    }

    // The round ends once nobody can still act: everyone has either solved it or burned
    // all three attempts.
    next.closed = next.playerIds.every(
      (id) => next.solved[id] !== undefined || (next.attempts[id]?.length ?? 0) >= MAX_ATTEMPTS,
    );

    const events: StepResult<FillBlankState>['events'] = isCorrect
      ? [{ type: 'player_locked', playerId: ctx.playerId }]
      : [];
    if (next.closed) events.push({ type: 'all_locked' });

    return { state: next, events };
  },

  onDeadline(state): StepResult<FillBlankState> {
    if (state.closed) return noChange(state);
    return { state: { ...state, closed: true }, events: [] };
  },

  view(state, playerId) {
    const mine = state.attempts[playerId] ?? [];
    return {
      textAr: state.item.textAr,
      myAttempts: mine,
      attemptsLeft: Math.max(0, MAX_ATTEMPTS - mine.length),
      hasSolved: state.solved[playerId] !== undefined,
      // A count, never the names — knowing *who* solved it narrows the answer for the rest.
      solvedCount: state.solveOrder.length,
      totalPlayers: state.playerIds.length,
    };
  },

  reveal(state) {
    return {
      textAr: state.item.textAr,
      answerAr: state.item.answerAr,
      explanationAr: state.item.explanationAr ?? null,
      solveOrder: state.solveOrder,
      attempts: state.attempts,
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
      const solvedAt = state.solved[playerId];
      if (solvedAt === undefined) return { playerId, points: 0, isCorrect: false, msTaken: null };

      const bonus = speedBonus(
        solvedAt,
        state.startedAtMs,
        state.endsAtMs,
        MAX_SPEED_BONUS,
        READ_GRACE_MS,
      );
      return {
        playerId,
        points: POINTS_CORRECT + bonus,
        isCorrect: true,
        msTaken: Math.max(0, solvedAt - state.startedAtMs),
      };
    });
  },
};
