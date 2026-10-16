import {
  type ActionCtx,
  type ContentItem,
  type NumericContent,
  type PlayerId,
  type RoundInit,
  type RoundScore,
  type RoundType,
  type StepResult,
} from '@game/shared';

const BULLSEYE_POINTS = 200;
/** Points by proximity rank among everyone who missed the tolerance band. */
const PROXIMITY_LADDER = [150, 110, 80, 50, 25] as const;

export interface NumericGuessState {
  item: NumericContent;
  playerIds: PlayerId[];
  startedAtMs: number;
  endsAtMs: number;
  guesses: Record<PlayerId, { value: number; atMs: number }>;
  closed: boolean;
}

export type NumericGuessAction = { kind: 'guess'; value: number };

const noChange = (state: NumericGuessState): StepResult<NumericGuessState> => ({
  state,
  events: [],
});

/**
 * خمّن التاريخ / الرقم — free numeric entry, closest wins.
 *
 * Scoring is rank-based rather than distance-based on purpose. Question magnitudes vary
 * enormously ("سنة 1952" against "عدد سكان 105,000,000"), so any distance-decay curve tuned
 * for one is nonsense for the other. Rank is scale-free, and a player can read "أنا كنت
 * التاني الأقرب" instantly without doing arithmetic.
 */
export const numericGuess: RoundType<NumericGuessState, NumericGuessAction> = {
  id: 'numeric_guess',
  nameAr: 'خمّن التاريخ',
  taglineAr: 'اكتب رقمك — الأقرب للإجابة الصح ياخد أكتر نقط',
  scoringHintAr: 'مضبوط = 200، وبعدها بالترتيب حسب الأقرب: 150 / 110 / 80 / 50 / 25',
  contentShapes: ['numeric'],
  itemsPerRound: 1,
  pacing: 'thinking',
  long: false,
  minPlayers: 2,
  requiresTeams: false,
  durationMs: 20_000,
  /** The guesses only mean anything next to each other. */
  revealWeight: 1.1,
  accent: 'sky',
  supportsSuddenDeath: false,

  createState(content: ContentItem[], init: RoundInit): NumericGuessState {
    const item = content[0];
    if (!item || item.shape !== 'numeric') throw new Error('numeric_guess requires one numeric item');
    return {
      item,
      playerIds: init.players.map((p) => p.id),
      startedAtMs: init.startedAtMs,
      endsAtMs: init.endsAtMs,
      guesses: {},
      closed: false,
    };
  },

  reduce(state, action, ctx): StepResult<NumericGuessState> {
    if (state.closed || ctx.nowMs > state.endsAtMs) return noChange(state);
    if (action.kind !== 'guess') return noChange(state);
    if (!state.playerIds.includes(ctx.playerId)) return noChange(state);
    if (state.guesses[ctx.playerId]) return noChange(state);
    if (!Number.isFinite(action.value)) return noChange(state);

    const guesses = { ...state.guesses, [ctx.playerId]: { value: action.value, atMs: ctx.nowMs } };
    const everyoneGuessed = state.playerIds.every((id) => guesses[id]);
    const next: NumericGuessState = { ...state, guesses, closed: everyoneGuessed };

    return {
      state: next,
      events: everyoneGuessed
        ? [{ type: 'player_locked', playerId: ctx.playerId }, { type: 'all_locked' }]
        : [{ type: 'player_locked', playerId: ctx.playerId }],
    };
  },

  onDeadline(state): StepResult<NumericGuessState> {
    if (state.closed) return noChange(state);
    return { state: { ...state, closed: true }, events: [] };
  },

  view(state, playerId) {
    const mine = state.guesses[playerId];
    return {
      textAr: state.item.textAr,
      unitAr: state.item.unitAr ?? null,
      myGuess: mine?.value ?? null,
      hasGuessed: mine !== undefined,
      lockedCount: Object.keys(state.guesses).length,
      totalPlayers: state.playerIds.length,
    };
  },

  reveal(state) {
    return {
      textAr: state.item.textAr,
      correctValue: state.item.correctValue,
      tolerance: state.item.tolerance,
      unitAr: state.item.unitAr ?? null,
      explanationAr: state.item.explanationAr ?? null,
      guesses: Object.fromEntries(
        Object.entries(state.guesses).map(([id, g]) => [id, g.value]),
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
    const distance = (playerId: PlayerId): number | null => {
      const g = state.guesses[playerId];
      return g ? Math.abs(g.value - state.item.correctValue) : null;
    };

    const missed = state.playerIds
      .filter((id) => {
        const d = distance(id);
        return d !== null && d > state.item.tolerance;
      })
      .sort((a, b) => (distance(a) ?? 0) - (distance(b) ?? 0));

    // Equal distances share the better ladder slot rather than being split by arrival order —
    // two players who guessed 1950 and 1954 for 1952 were equally close, and rewarding
    // whoever typed faster would contradict this round being about accuracy.
    const ladderPoints = new Map<PlayerId, number>();
    let slot = 0;
    for (const [i, playerId] of missed.entries()) {
      const previous = missed[i - 1];
      if (previous !== undefined && distance(previous) !== distance(playerId)) slot = i;
      ladderPoints.set(playerId, PROXIMITY_LADDER[Math.min(slot, PROXIMITY_LADDER.length - 1)]!);
    }

    return state.playerIds.map((playerId) => {
      const guess = state.guesses[playerId];
      if (!guess) return { playerId, points: 0, isCorrect: false, msTaken: null };

      const msTaken = Math.max(0, guess.atMs - state.startedAtMs);
      const d = Math.abs(guess.value - state.item.correctValue);
      if (d <= state.item.tolerance) {
        return { playerId, points: BULLSEYE_POINTS, isCorrect: true, msTaken };
      }
      return { playerId, points: ladderPoints.get(playerId) ?? 0, isCorrect: false, msTaken };
    });
  },
};
