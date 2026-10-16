import {
  answersMatch,
  type ActionCtx,
  type ContentItem,
  type DeadlineCtx,
  type PlayerId,
  type ProgressiveContent,
  type RoundInit,
  type RoundScore,
  type RoundType,
  type StepResult,
} from '@game/shared';

/** Points by how many hints were showing when the player got it. Index 0 = first hint only. */
const HINT_LADDER = [200, 150, 100, 50] as const;
/**
 * How long one clue stays alone on screen before the next one lands.
 *
 * Six seconds was not a pause, it was a stampede: the clue appeared, the room was still
 * reading it out loud to each other, and the next one had already replaced the silence it
 * needed. The whole round is a nerve test — commit now for 200, or wait and settle for less —
 * and that decision needs room to be argued about before the ladder moves again.
 */
const HINT_INTERVAL_MS = 9_000;
export const WHO_AM_I_ATTEMPTS = 2;

export interface WhoAmIState {
  item: ProgressiveContent;
  playerIds: PlayerId[];
  startedAtMs: number;
  endsAtMs: number;
  /** How many hints are on screen. Starts at 1 and climbs on a timer. */
  revealed: number;
  attempts: Record<PlayerId, string[]>;
  /** playerId → how many hints were showing when they got it right. */
  solvedAtHint: Record<PlayerId, number>;
  solvedAtMs: Record<PlayerId, number>;
  closed: boolean;
}

export type WhoAmIAction = { kind: 'guess'; text: string };

const noChange = (state: WhoAmIState): StepResult<WhoAmIState> => ({ state, events: [] });

const isDone = (state: WhoAmIState, playerId: PlayerId): boolean =>
  state.solvedAtHint[playerId] !== undefined ||
  (state.attempts[playerId]?.length ?? 0) >= WHO_AM_I_ATTEMPTS;

/**
 * من أنا؟ — clues appear one at a time, and every one that lands makes the answer easier and
 * the points smaller.
 *
 * The round is not really a memory test; it is a nerve test. You almost certainly work it out
 * eventually, so the only decision that matters is when to commit — take the shot on one vague
 * clue for 200, or wait for certainty and settle for 50. That is a kind of pressure no other
 * round type in the game applies, which is exactly why it earns a slot.
 */
export const whoAmI: RoundType<WhoAmIState, WhoAmIAction> = {
  id: 'who_am_i',
  nameAr: 'مين أنا؟',
  taglineAr: 'التلميحات بتظهر واحد ورا التاني — كل ما تخمّن بدري، النقط تزيد',
  scoringHintAr: 'تلميح واحد = 200، وبعدها 150 / 100 / 50 — كل تلميح بيظهر بعد 9 ثواني',
  contentShapes: ['progressive'],
  itemsPerRound: 1,
  pacing: 'thinking',
  long: false,
  minPlayers: 2,
  requiresTeams: false,
  durationMs: 30_000,
  /** Who got it off the first clue. */
  revealWeight: 1.2,
  accent: 'violet',
  supportsSuddenDeath: false,

  createState(content: ContentItem[], init: RoundInit): WhoAmIState {
    const item = content[0];
    if (!item || item.shape !== 'progressive') throw new Error('who_am_i requires one progressive item');
    const playerIds = init.players.map((p) => p.id);
    return {
      item,
      playerIds,
      startedAtMs: init.startedAtMs,
      endsAtMs: init.endsAtMs,
      revealed: 1,
      attempts: Object.fromEntries(playerIds.map((id) => [id, []])),
      solvedAtHint: {},
      solvedAtMs: {},
      closed: false,
    };
  },

  reduce(state, action, ctx): StepResult<WhoAmIState> {
    if (state.closed || ctx.nowMs > state.endsAtMs) return noChange(state);
    if (action.kind !== 'guess') return noChange(state);
    if (!state.playerIds.includes(ctx.playerId)) return noChange(state);
    if (typeof action.text !== 'string' || !action.text.trim()) return noChange(state);
    if (isDone(state, ctx.playerId)) return noChange(state);

    const text = action.text.trim().slice(0, 60);
    const next: WhoAmIState = {
      ...state,
      attempts: { ...state.attempts, [ctx.playerId]: [...(state.attempts[ctx.playerId] ?? []), text] },
    };

    if (answersMatch(text, state.item.answerAr, state.item.aliases)) {
      // Locked to the hint count at this instant — waiting for more clues can only cost points,
      // never earn them.
      next.solvedAtHint = { ...state.solvedAtHint, [ctx.playerId]: state.revealed };
      next.solvedAtMs = { ...state.solvedAtMs, [ctx.playerId]: ctx.nowMs };
    }

    next.closed = next.playerIds.every((id) => isDone(next, id));
    const events: StepResult<WhoAmIState>['events'] = next.closed ? [{ type: 'all_locked' }] : [];
    if (next.solvedAtHint[ctx.playerId] !== undefined) {
      events.unshift({ type: 'player_locked', playerId: ctx.playerId });
    }
    return { state: next, events };
  },

  onDeadline(state, ctx: DeadlineCtx): StepResult<WhoAmIState> {
    if (state.closed) return noChange(state);

    // Reveal the next clue if there is one; otherwise the round is out of road.
    if (state.revealed < state.item.hints.length && ctx.nowMs < state.endsAtMs) {
      const revealed = state.revealed + 1;
      return { state: { ...state, revealed }, events: [{ type: 'hint_revealed', index: revealed - 1 }] };
    }
    return { state: { ...state, closed: true }, events: [] };
  },

  view(state, playerId) {
    const mine = state.attempts[playerId] ?? [];
    return {
      // Only the clues released so far. Sending the rest would hand over the whole ladder.
      hints: state.item.hints.slice(0, state.revealed),
      totalHints: state.item.hints.length,
      myAttempts: mine,
      attemptsLeft: Math.max(0, WHO_AM_I_ATTEMPTS - mine.length),
      hasSolved: state.solvedAtHint[playerId] !== undefined,
      pointsIfRightNow: HINT_LADDER[Math.min(state.revealed - 1, HINT_LADDER.length - 1)],
      // When the ladder drops next, so the screen can count it down instead of ambushing
      // the player mid-thought. Null once every clue is out.
      nextHintAtMs:
        state.revealed < state.item.hints.length
          ? Math.min(state.endsAtMs, state.startedAtMs + state.revealed * HINT_INTERVAL_MS)
          : null,
      pointsAfterNextHint:
        state.revealed < state.item.hints.length
          ? HINT_LADDER[Math.min(state.revealed, HINT_LADDER.length - 1)]
          : null,
      solvedCount: Object.keys(state.solvedAtHint).length,
      totalPlayers: state.playerIds.length,
    };
  },

  reveal(state) {
    return {
      hints: state.item.hints,
      answerAr: state.item.answerAr,
      explanationAr: state.item.explanationAr ?? null,
      solvedAtHint: state.solvedAtHint,
    };
  },

  isFinished(state) {
    return state.closed;
  },

  nextDeadline(state) {
    if (state.closed) return null;
    if (state.revealed >= state.item.hints.length) return state.endsAtMs;
    // The next clue lands before the round does.
    return Math.min(state.endsAtMs, state.startedAtMs + state.revealed * HINT_INTERVAL_MS);
  },

  roundScores(state): RoundScore[] {
    return state.playerIds.map((playerId) => {
      const hint = state.solvedAtHint[playerId];
      if (hint === undefined) return { playerId, points: 0, isCorrect: false, msTaken: null };

      const solvedAt = state.solvedAtMs[playerId]!;
      return {
        playerId,
        points: HINT_LADDER[Math.min(hint - 1, HINT_LADDER.length - 1)]!,
        isCorrect: true,
        msTaken: Math.max(0, solvedAt - state.startedAtMs),
      };
    });
  },
};
