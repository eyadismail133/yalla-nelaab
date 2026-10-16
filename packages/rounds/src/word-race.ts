import {
  normalizeArabic,
  type ActionCtx,
  type ContentItem,
  type DeadlineCtx,
  type PlayerId,
  type RoundInit,
  type RoundScore,
  type RoundType,
  type StepResult,
  type WordRaceContent,
} from '@game/shared';

const WRITE_MS = 60_000;
/**
 * Review time scales with the room, the same way الكذّابين's vote window does: the table is
 * one row per player times one column per field, so a room of eight has far more to read
 * through than a room of three.
 */
const VOTE_MS_BASE = 20_000;
const VOTE_MS_PER_PLAYER = 4_000;
const VOTE_MS_MAX = 60_000;
const voteMsFor = (playerCount: number): number =>
  Math.min(VOTE_MS_MAX, VOTE_MS_BASE + VOTE_MS_PER_PLAYER * playerCount);

export const MAX_WORD_LENGTH = 24;
const POINTS_FOR_LETTER = 30;
const POINTS_FOR_UNIQUE = 20;

export interface WordRaceState {
  item: WordRaceContent;
  playerIds: PlayerId[];
  startedAtMs: number;
  stage: 'writing' | 'voting' | 'done';
  /** Picked once per round, deterministically, so the state is reproducible. */
  letter: string;
  writeEndsAtMs: number;
  voteEndsAtMs: number | null;
  /** playerId → index-aligned with item.fieldsAr; null means that field is still blank. */
  answers: Record<PlayerId, Array<string | null>>;
  /** Set only by a real submission — never touched by a forced timeout. */
  lastWriteAtMs: Record<PlayerId, number>;
  /** `${authorId}:${field}` → voter ids who rejected that answer. */
  rejections: Record<string, PlayerId[]>;
  ready: Record<PlayerId, boolean>;
  closed: boolean;
}

export type WordRaceAction =
  | { kind: 'write'; field: number; text: string }
  | { kind: 'reject'; authorId: PlayerId; field: number }
  | { kind: 'ready' };

const noChange = (state: WordRaceState): StepResult<WordRaceState> => ({ state, events: [] });

/** Deterministic ordering — the state has to be reproducible, so no RNG here. */
function stableHash(input: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function pickLetter(item: WordRaceContent, startedAtMs: number): string {
  const index = stableHash(item.id + String(startedAtMs)) % item.letters.length;
  return item.letters[index]!;
}

/** Same leading-"ال" allowance `answersMatch` gives free-text answers elsewhere in the game. */
function withoutArticle(normalized: string): string {
  return normalized.startsWith('ال') && normalized.length > 3 ? normalized.slice(2) : normalized;
}

function openVoting(state: WordRaceState, nowMs: number): WordRaceState {
  return { ...state, stage: 'voting', voteEndsAtMs: nowMs + voteMsFor(state.playerIds.length) };
}

/**
 * اسم حيوان جماد بلاد — a letter drops, everyone fills in a word for each category before the
 * clock runs out, then the room votes out anything that does not hold up.
 *
 * Two things pay off per field: starting with the right letter, and writing something nobody
 * else in the room also thought of. That second half is what makes this a genuinely different
 * kind of round from every other free-text type — the competition is not against the question,
 * it is against your friends' first instinct, so the obvious answer is worth less than the one
 * only you wrote.
 */
export const wordRace: RoundType<WordRaceState, WordRaceAction> = {
  id: 'word_race',
  nameAr: 'اسم حيوان جماد بلاد',
  taglineAr: 'حرف واحد، واملا الخانات قبل ما الوقت يخلص — والغرفة تحكم بعدين',
  scoringHintAr: 'خانة صح بالحرف = 30، ولو محدش كتب زيك = 20 زيادة — أربع خانات = 200',
  contentShapes: ['word_race'],
  itemsPerRound: 1,
  pacing: 'thinking',
  long: true,
  // Voting between two players is nothing to review — the round needs a room.
  minPlayers: 3,
  requiresTeams: false,
  // Nominal: the real vote window is sized to the room in openVoting().
  durationMs: WRITE_MS + voteMsFor(5),
  /** A full table of everyone's answers, read out and argued over. */
  revealWeight: 1.8,
  accent: 'violet',
  supportsSuddenDeath: false,

  createState(content: ContentItem[], init: RoundInit): WordRaceState {
    const item = content[0];
    if (!item || item.shape !== 'word_race') {
      throw new Error('word_race requires one word_race item');
    }
    const playerIds = init.players.map((p) => p.id);
    return {
      item,
      playerIds,
      startedAtMs: init.startedAtMs,
      stage: 'writing',
      letter: pickLetter(item, init.startedAtMs),
      writeEndsAtMs: init.startedAtMs + WRITE_MS,
      voteEndsAtMs: null,
      answers: Object.fromEntries(playerIds.map((id) => [id, Array(item.fieldsAr.length).fill(null)])),
      lastWriteAtMs: {},
      rejections: {},
      ready: {},
      closed: false,
    };
  },

  reduce(state, action, ctx): StepResult<WordRaceState> {
    if (!state.playerIds.includes(ctx.playerId)) return noChange(state);

    if (state.stage === 'writing' && action.kind === 'write') {
      if (ctx.nowMs > state.writeEndsAtMs) return noChange(state);
      if (!Number.isInteger(action.field) || action.field < 0 || action.field >= state.item.fieldsAr.length) {
        return noChange(state);
      }
      if (typeof action.text !== 'string' || !action.text.trim()) return noChange(state);

      const mine = [...(state.answers[ctx.playerId] ?? [])];
      // One shot per field — writing under a countdown, not editing.
      if (mine[action.field] !== null) return noChange(state);
      mine[action.field] = action.text.trim().slice(0, MAX_WORD_LENGTH);

      const next: WordRaceState = {
        ...state,
        answers: { ...state.answers, [ctx.playerId]: mine },
        lastWriteAtMs: { ...state.lastWriteAtMs, [ctx.playerId]: ctx.nowMs },
      };

      const everyoneWrote = next.playerIds.every((id) =>
        (next.answers[id] ?? []).every((v) => v !== null),
      );
      if (everyoneWrote) {
        return { state: openVoting(next, ctx.nowMs), events: [{ type: 'all_locked' }] };
      }
      const playerDone = mine.every((v) => v !== null);
      return {
        state: next,
        events: playerDone ? [{ type: 'player_locked', playerId: ctx.playerId }] : [],
      };
    }

    if (state.stage === 'voting' && action.kind === 'reject') {
      if (state.voteEndsAtMs !== null && ctx.nowMs > state.voteEndsAtMs) return noChange(state);
      if (action.authorId === ctx.playerId) return noChange(state);
      if (!state.playerIds.includes(action.authorId)) return noChange(state);
      if (!Number.isInteger(action.field) || action.field < 0 || action.field >= state.item.fieldsAr.length) {
        return noChange(state);
      }
      const target = state.answers[action.authorId]?.[action.field];
      if (!target) return noChange(state);

      const key = `${action.authorId}:${action.field}`;
      const already = state.rejections[key] ?? [];
      if (already.includes(ctx.playerId)) return noChange(state);

      return {
        state: { ...state, rejections: { ...state.rejections, [key]: [...already, ctx.playerId] } },
        events: [],
      };
    }

    if (state.stage === 'voting' && action.kind === 'ready') {
      if (state.voteEndsAtMs !== null && ctx.nowMs > state.voteEndsAtMs) return noChange(state);
      if (state.ready[ctx.playerId]) return noChange(state);

      const next: WordRaceState = { ...state, ready: { ...state.ready, [ctx.playerId]: true } };
      const everyoneReady = next.playerIds.every((id) => next.ready[id]);
      if (everyoneReady) {
        return { state: { ...next, stage: 'done', closed: true }, events: [{ type: 'all_locked' }] };
      }
      return { state: next, events: [{ type: 'player_locked', playerId: ctx.playerId }] };
    }

    return noChange(state);
  },

  onDeadline(state, ctx: DeadlineCtx): StepResult<WordRaceState> {
    if (state.stage === 'writing') {
      return { state: openVoting(state, ctx.nowMs), events: [{ type: 'sub_round_advanced', index: 1 }] };
    }
    if (state.stage === 'voting') {
      return { state: { ...state, stage: 'done', closed: true }, events: [] };
    }
    return noChange(state);
  },

  view(state, playerId) {
    if (state.stage === 'writing') {
      const mine = state.answers[playerId] ?? [];
      return {
        stage: 'writing' as const,
        letter: state.letter,
        fieldsAr: state.item.fieldsAr,
        myAnswers: mine,
        lockedCount: state.playerIds.filter((id) =>
          (state.answers[id] ?? []).every((v) => v !== null),
        ).length,
        totalPlayers: state.playerIds.length,
      };
    }

    return {
      stage: 'voting' as const,
      letter: state.letter,
      fieldsAr: state.item.fieldsAr,
      table: state.playerIds.map((authorId) => ({
        authorId,
        fields: state.item.fieldsAr.map((_, field) => {
          const key = `${authorId}:${field}`;
          return {
            text: state.answers[authorId]?.[field] ?? null,
            rejectedCount: (state.rejections[key] ?? []).length,
            rejectedByMe: (state.rejections[key] ?? []).includes(playerId),
          };
        }),
      })),
      isReady: state.ready[playerId] ?? false,
      readyCount: Object.keys(state.ready).length,
      totalPlayers: state.playerIds.length,
    };
  },

  reveal(state) {
    const majorityThreshold = Math.floor((state.playerIds.length - 1) / 2);
    return {
      letter: state.letter,
      fieldsAr: state.item.fieldsAr,
      explanationAr: state.item.explanationAr ?? null,
      table: state.playerIds.map((authorId) => ({
        authorId,
        fields: state.item.fieldsAr.map((_, field) => {
          const key = `${authorId}:${field}`;
          const rejectedCount = (state.rejections[key] ?? []).length;
          return {
            text: state.answers[authorId]?.[field] ?? null,
            rejected: rejectedCount > majorityThreshold,
            rejectedCount,
          };
        }),
      })),
    };
  },

  isFinished(state) {
    return state.closed;
  },

  nextDeadline(state) {
    if (state.stage === 'writing') return state.writeEndsAtMs;
    if (state.stage === 'voting') return state.voteEndsAtMs;
    return null;
  },

  roundScores(state): RoundScore[] {
    const fieldCount = state.item.fieldsAr.length;
    const majorityThreshold = Math.floor((state.playerIds.length - 1) / 2);
    const normalizedLetter = normalizeArabic(state.letter);

    return state.playerIds.map((playerId) => {
      const mine = state.answers[playerId] ?? [];
      let points = 0;
      let correctCount = 0;
      let answered = 0;

      for (let field = 0; field < fieldCount; field += 1) {
        const text = mine[field];
        if (!text) continue;
        answered += 1;

        const key = `${playerId}:${field}`;
        const rejectedCount = (state.rejections[key] ?? []).length;
        if (rejectedCount > majorityThreshold) continue;

        const normalizedMine = withoutArticle(normalizeArabic(text));
        if (normalizedLetter.length === 0 || !normalizedMine.startsWith(normalizedLetter)) continue;

        correctCount += 1;
        points += POINTS_FOR_LETTER;

        const isUnique = state.playerIds.every((otherId) => {
          if (otherId === playerId) return true;
          const other = state.answers[otherId]?.[field];
          if (!other) return true;
          return withoutArticle(normalizeArabic(other)) !== normalizedMine;
        });
        if (isUnique) points += POINTS_FOR_UNIQUE;
      }

      const lastAt = state.lastWriteAtMs[playerId];
      return {
        playerId,
        points,
        isCorrect: correctCount === fieldCount,
        msTaken: answered > 0 && lastAt !== undefined ? Math.max(0, lastAt - state.startedAtMs) : null,
      };
    });
  },
};
