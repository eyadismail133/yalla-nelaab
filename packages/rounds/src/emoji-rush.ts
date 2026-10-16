import {
  answersMatch,
  type ActionCtx,
  type ContentItem,
  type EmojiContent,
  type PlayerId,
  type RoundInit,
  type RoundScore,
  type RoundType,
  type StepResult,
} from '@game/shared';

export const EMOJI_RUSH_ITEMS = 5;
const POINTS_PER_SOLVE = 40;

export interface EmojiRushState {
  items: EmojiContent[];
  playerIds: PlayerId[];
  startedAtMs: number;
  endsAtMs: number;
  /** How many puzzles each player has solved, in order — also their index into `items`. */
  cursor: Record<PlayerId, number>;
  lastActionAtMs: Record<PlayerId, number>;
  closed: boolean;
}

export type EmojiRushAction = { kind: 'submit'; text: string };

const noChange = (state: EmojiRushState): StepResult<EmojiRushState> => ({ state, events: [] });

/**
 * إيموجي — a string of emoji stands in for a word or phrase, guessed as free text, five in a
 * row.
 *
 * A wrong guess costs nothing but the time spent typing it — the player stays on the same
 * puzzle and can try again immediately. That is what separates this from الكلمة الناقصة: this
 * round is about tempo, guessing through five puzzles as fast as the room can read pictures,
 * not about one hard recall under a countdown.
 */
export const emojiRush: RoundType<EmojiRushState, EmojiRushAction> = {
  id: 'emoji_rush',
  nameAr: 'إيموجي',
  taglineAr: 'خمّن الكلمة من الإيموجي — خمسة ألغاز ورا بعض',
  scoringHintAr: 'كل لغز تحله = 40 نقطة — خمسة صح = 200',
  contentShapes: ['emoji'],
  itemsPerRound: EMOJI_RUSH_ITEMS,
  pacing: 'fast',
  long: false,
  minPlayers: 2,
  requiresTeams: false,
  durationMs: 60_000,
  /** Five little reveals, each worth a laugh. */
  revealWeight: 1.2,
  accent: 'amber',
  supportsSuddenDeath: false,

  createState(content: ContentItem[], init: RoundInit): EmojiRushState {
    const items = content.filter((c): c is EmojiContent => c.shape === 'emoji');
    if (items.length !== EMOJI_RUSH_ITEMS) {
      throw new Error(`emoji_rush requires exactly ${EMOJI_RUSH_ITEMS} emoji items`);
    }
    const playerIds = init.players.map((p) => p.id);
    return {
      items,
      playerIds,
      startedAtMs: init.startedAtMs,
      endsAtMs: init.endsAtMs,
      cursor: Object.fromEntries(playerIds.map((id) => [id, 0])),
      lastActionAtMs: {},
      closed: false,
    };
  },

  reduce(state, action, ctx): StepResult<EmojiRushState> {
    if (state.closed || ctx.nowMs > state.endsAtMs) return noChange(state);
    if (action.kind !== 'submit') return noChange(state);
    if (!state.playerIds.includes(ctx.playerId)) return noChange(state);
    if (typeof action.text !== 'string' || !action.text.trim()) return noChange(state);

    const cursor = state.cursor[ctx.playerId] ?? 0;
    if (cursor >= EMOJI_RUSH_ITEMS) return noChange(state);

    const item = state.items[cursor]!;
    const text = action.text.trim().slice(0, 60);
    const isCorrect = answersMatch(text, item.answerAr, item.aliases);

    // Wrong guesses cost nothing — the player just stays on the same puzzle and tries again.
    if (!isCorrect) return noChange(state);

    const nextCursor = cursor + 1;
    const next: EmojiRushState = {
      ...state,
      cursor: { ...state.cursor, [ctx.playerId]: nextCursor },
      lastActionAtMs: { ...state.lastActionAtMs, [ctx.playerId]: ctx.nowMs },
    };
    next.closed = next.playerIds.every((id) => (next.cursor[id] ?? 0) >= EMOJI_RUSH_ITEMS);

    const events: StepResult<EmojiRushState>['events'] = [
      { type: 'sub_round_advanced', index: nextCursor },
    ];
    if (next.closed) events.push({ type: 'all_locked' });
    return { state: next, events };
  },

  onDeadline(state): StepResult<EmojiRushState> {
    if (state.closed) return noChange(state);
    return { state: { ...state, closed: true }, events: [] };
  },

  view(state, playerId) {
    const cursor = state.cursor[playerId] ?? 0;
    const current = state.items[cursor];
    return {
      // Only the puzzle this player is currently on — the rest is not sent, so nobody can read
      // ahead while a friend is still stuck on puzzle two.
      current: current
        ? { index: cursor, emojis: current.emojis, hintAr: current.hintAr ?? null, categoryId: current.categoryId }
        : null,
      solvedCount: cursor,
      totalItems: EMOJI_RUSH_ITEMS,
      isDone: cursor >= EMOJI_RUSH_ITEMS,
      progress: state.playerIds.map((id) => ({ playerId: id, count: state.cursor[id] ?? 0 })),
    };
  },

  reveal(state) {
    return {
      items: state.items.map((item) => ({
        emojis: item.emojis,
        answerAr: item.answerAr,
        explanationAr: item.explanationAr ?? null,
      })),
      solved: state.cursor,
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
      const solved = state.cursor[playerId] ?? 0;
      const lastAt = state.lastActionAtMs[playerId];
      return {
        playerId,
        points: POINTS_PER_SOLVE * solved,
        isCorrect: solved === EMOJI_RUSH_ITEMS,
        msTaken: lastAt === undefined ? null : Math.max(0, lastAt - state.startedAtMs),
      };
    });
  },
};
