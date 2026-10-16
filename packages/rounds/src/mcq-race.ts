import {
  speedBonus,
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

/**
 * Knowing is worth more than reacting, and the split says so out loud.
 *
 * It used to be 100 + 100, which made speed exactly as valuable as being right: two players
 * who both knew the answer could finish 100 points apart — a whole round's base score — on
 * nothing but thumb speed and phone latency. 120 + 80 keeps the race feeling like a race while
 * making the gap between two correct answers smaller than the gap between right and wrong.
 */
const BASE_POINTS = 120;
const MAX_SPEED_BONUS = 80;
/**
 * How long the bonus stays at full before it starts draining.
 *
 * A question plus four Arabic options takes about three seconds to read. Without this window
 * the only way to bank the full bonus was to answer before reading — the round paid for
 * guessing fast. Now the clock effectively starts when a person could plausibly have finished
 * reading.
 */
const READ_GRACE_MS = 3_000;

export interface McqRaceState {
  item: McqContent;
  playerIds: PlayerId[];
  startedAtMs: number;
  endsAtMs: number;
  answers: Record<PlayerId, { choice: number; atMs: number }>;
  closed: boolean;
}

export type McqRaceAction = { kind: 'answer'; choice: number };

const noChange = (state: McqRaceState): StepResult<McqRaceState> => ({
  state,
  events: [],
});

/**
 * سباق الإجابات — everyone sees the same question at the same instant.
 *
 * 120 for correct plus up to 80 for speed, and the speed half does not start draining until
 * three seconds have passed. The deliberate consequence: a correct answer at the very last
 * second still banks 120, anybody who answers within reading time banks the full 200, and the
 * spread between two people who both knew it is smaller than the spread between knowing and
 * guessing. The round still feels like a race; it just no longer decides the match on reflexes.
 */
export const mcqRace: RoundType<McqRaceState, McqRaceAction> = {
  id: 'mcq_race',
  nameAr: 'سباق الإجابات',
  taglineAr: 'الكل بيشوف السؤال في نفس اللحظة — أسرع واحد يجاوب صح ياخد أكتر',
  scoringHintAr: 'صح = 120 نقطة + لحد 80 على السرعة (أول ٣ ثواني بالنقط كاملة)',
  contentShapes: ['mcq'],
  itemsPerRound: 1,
  pacing: 'fast',
  long: false,
  minPlayers: 2,
  requiresTeams: false,
  durationMs: 18_000,
  accent: 'emerald',
  supportsSuddenDeath: true,

  createState(content: ContentItem[], init: RoundInit): McqRaceState {
    const item = content[0];
    if (!item || item.shape !== 'mcq') throw new Error('mcq_race requires one mcq item');
    return {
      item,
      playerIds: init.players.map((p) => p.id),
      startedAtMs: init.startedAtMs,
      endsAtMs: init.endsAtMs,
      answers: {},
      closed: false,
    };
  },

  reduce(state, action, ctx): StepResult<McqRaceState> {
    if (state.closed || ctx.nowMs > state.endsAtMs) return noChange(state);
    if (action.kind !== 'answer') return noChange(state);
    if (!state.playerIds.includes(ctx.playerId)) return noChange(state);
    // One answer per player, enforced here rather than trusting the client to disable the UI.
    if (state.answers[ctx.playerId]) return noChange(state);
    if (!Number.isInteger(action.choice) || action.choice < 0 || action.choice > 3) {
      return noChange(state);
    }

    const answers = { ...state.answers, [ctx.playerId]: { choice: action.choice, atMs: ctx.nowMs } };
    const everyoneAnswered = state.playerIds.every((id) => answers[id]);
    const next: McqRaceState = { ...state, answers, closed: everyoneAnswered };

    return {
      state: next,
      events: everyoneAnswered
        ? [{ type: 'player_locked', playerId: ctx.playerId }, { type: 'all_locked' }]
        : [{ type: 'player_locked', playerId: ctx.playerId }],
    };
  },

  onDeadline(state): StepResult<McqRaceState> {
    if (state.closed) return noChange(state);
    return { state: { ...state, closed: true }, events: [] };
  },

  view(state, playerId) {
    const mine = state.answers[playerId];
    return {
      textAr: state.item.textAr,
      options: state.item.options,
      // Deliberately absent: correctIndex. A player who has locked in still must not learn
      // whether they were right, or their reaction leaks the answer to the room.
      myChoice: mine?.choice ?? null,
      hasAnswered: mine !== undefined,
      lockedCount: Object.keys(state.answers).length,
      totalPlayers: state.playerIds.length,
    };
  },

  reveal(state) {
    return {
      textAr: state.item.textAr,
      options: state.item.options,
      correctIndex: state.item.correctIndex,
      explanationAr: state.item.explanationAr ?? null,
      choices: Object.fromEntries(
        Object.entries(state.answers).map(([id, a]) => [id, a.choice]),
      ),
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
      const answer = state.answers[playerId];
      if (!answer) return { playerId, points: 0, isCorrect: false, msTaken: null };

      const isCorrect = answer.choice === state.item.correctIndex;
      const msTaken = Math.max(0, answer.atMs - state.startedAtMs);
      if (!isCorrect) return { playerId, points: 0, isCorrect: false, msTaken };

      const bonus = speedBonus(
        answer.atMs,
        state.startedAtMs,
        state.endsAtMs,
        MAX_SPEED_BONUS,
        READ_GRACE_MS,
      );
      return { playerId, points: BASE_POINTS + bonus, isCorrect: true, msTaken };
    });
  },
};
