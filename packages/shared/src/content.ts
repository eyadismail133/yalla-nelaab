import { z } from 'zod';

/**
 * Content shapes are what round types consume. A round type declares which shapes it can
 * play, NOT which categories — that is what lets any game work with any topic, and lets a
 * single question be reused by several round types.
 */
export const CONTENT_SHAPES = [
  'mcq',
  'numeric',
  'boolean',
  'fill_blank',
  'open_answer',
  'poll',
  'progressive',
  'ordering',
  'media',
  'odd_one_out',
  'emoji',
  'word_race',
] as const;

export type ContentShape = (typeof CONTENT_SHAPES)[number];

/**
 * Shapes with no topic, which the player's category selection must not filter.
 *
 * "مين أكتر واحد فينا بيتأخر؟" is not a football question or a history question — it is about
 * the people in the room. Scoping it to categories would hide the most social round in the
 * game behind a setting that has nothing to do with it.
 *
 * `word_race` joins it for a different reason: the prompt is a letter plus a set of field
 * names ("اسم، حيوان، جماد، بلاد"), which is not football or history either — it is a shape
 * of its own that a category filter has nothing to say about.
 */
export const CATEGORY_AGNOSTIC_SHAPES: ContentShape[] = ['poll', 'word_race'];

export const difficultySchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);
export type Difficulty = z.infer<typeof difficultySchema>;

const baseContentSchema = z.object({
  id: z.string().min(1),
  categoryId: z.string().min(1),
  difficulty: difficultySchema,
  explanationAr: z.string().optional(),
});

export const mcqContentSchema = baseContentSchema.extend({
  shape: z.literal('mcq'),
  textAr: z.string().min(1),
  options: z.array(z.string().min(1)).length(4),
  correctIndex: z.number().int().min(0).max(3),
});

export const numericContentSchema = baseContentSchema.extend({
  shape: z.literal('numeric'),
  textAr: z.string().min(1),
  correctValue: z.number(),
  /** Absolute distance still counted as a bullseye. 0 means the exact value only. */
  tolerance: z.number().min(0),
  unitAr: z.string().optional(),
});

export const booleanContentSchema = baseContentSchema.extend({
  shape: z.literal('boolean'),
  /** A statement the player judges, not a question. */
  textAr: z.string().min(1),
  isTrue: z.boolean(),
});

export const fillBlankContentSchema = baseContentSchema.extend({
  shape: z.literal('fill_blank'),
  /** Must contain the blank marker `____`. */
  textAr: z.string().min(1),
  answerAr: z.string().min(1),
  /** Other spellings accepted as correct, compared after Arabic normalization. */
  aliases: z.array(z.string()).default([]),
});

/**
 * A question with a short factual answer and no options at all — the players supply the wrong
 * answers themselves, by writing lies.
 *
 * This is the cheapest content in the whole bank. An mcq item needs three plausible distractors
 * written and fact-checked by hand; this needs only the truth. The distractors get generated
 * live, by people, and they are funnier than anything an author would have written.
 */
export const openAnswerContentSchema = baseContentSchema.extend({
  shape: z.literal('open_answer'),
  textAr: z.string().min(1),
  answerAr: z.string().min(1),
  /** Spellings that count as the truth, so a lie matching it is never offered as a decoy. */
  aliases: z.array(z.string()).default([]),
});

/**
 * A prompt about the people in the room, with no correct answer at all.
 *
 * Needs no fact-checking, so it can never be wrong and needs no review pipeline. Points come
 * from agreeing with the room rather than from knowing anything — a completely different skill
 * from every other shape here, and the one that makes the game feel like it is about your
 * friends rather than about trivia.
 */
export const pollContentSchema = baseContentSchema.extend({
  shape: z.literal('poll'),
  textAr: z.string().min(1),
});

/**
 * A ladder of clues from vague to obvious, plus the thing being described.
 *
 * The clues are what create the round's decision: every one that appears makes the answer
 * easier and the points smaller, so the player is choosing when to commit rather than what to
 * recall. Order matters — hint 0 must be the hardest.
 */
export const progressiveContentSchema = baseContentSchema.extend({
  shape: z.literal('progressive'),
  hints: z.array(z.string().min(1)).min(3).max(5),
  answerAr: z.string().min(1),
  aliases: z.array(z.string()).default([]),
});

/**
 * Items that belong in one correct sequence — oldest to newest, smallest to largest.
 *
 * Stored already in the right order and shuffled when the round starts, so authoring a question
 * means writing the truth once rather than writing an arrangement plus an answer key.
 */
export const orderingContentSchema = baseContentSchema.extend({
  shape: z.literal('ordering'),
  /** What the sequence is ordered by, e.g. "رتّبهم من الأقدم للأحدث". */
  textAr: z.string().min(1),
  items: z.array(z.string().min(1)).min(3).max(5),
  /** Shown on the reveal so the answer teaches something. */
  labels: z.array(z.string()).default([]),
});

/**
 * Four things on screen at once, three sharing a trait and one that does not.
 *
 * `reasonAr` is mandatory rather than optional the way `explanationAr` is elsewhere — without
 * it the reveal is just a highlighted item with no lesson, and "الدخيل" is exactly the round
 * where the reveal argument ("ليه هو الغريب؟") is the fun part, not an afterthought.
 */
export const oddOneOutContentSchema = baseContentSchema.extend({
  shape: z.literal('odd_one_out'),
  textAr: z.string().min(1),
  items: z.array(z.string().min(1)).length(4),
  oddIndex: z.number().int().min(0).max(3),
  reasonAr: z.string().min(1),
});

/**
 * A short string of emoji standing in for a word or phrase, guessed as free text.
 *
 * Comparison goes through the same `normalizeArabic`-based matching as fill_blank and
 * open_answer — this is a spelling problem, not a new kind of judgment, so it reuses the
 * existing answer-matching path rather than inventing another one.
 */
export const emojiContentSchema = baseContentSchema.extend({
  shape: z.literal('emoji'),
  emojis: z.string().min(1),
  answerAr: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  /** Shown only if a round type chooses to reveal it — not every use needs one. */
  hintAr: z.string().optional(),
});

/**
 * A letter plus a set of field names — "اسم، حيوان، جماد، بلاد" — with no correct answer
 * stored at all. The players write the answers live, the same way `poll` needs no fact and
 * `open_answer` needs no distractors.
 *
 * Category-agnostic for the same reason `poll` is: a letter and a list of categories to fill
 * in under it is not a football fact or a history fact, so scoping it to the player's chosen
 * categories would just make it disappear when someone picks a narrow topic.
 */
export const wordRaceContentSchema = baseContentSchema.extend({
  shape: z.literal('word_race'),
  fieldsAr: z.array(z.string().min(1)).min(3).max(5),
  /** One is picked per round; several are stored so the same item can be replayed. */
  letters: z.array(z.string().min(1)).min(1),
});

export const contentItemSchema = z.discriminatedUnion('shape', [
  mcqContentSchema,
  numericContentSchema,
  booleanContentSchema,
  fillBlankContentSchema,
  openAnswerContentSchema,
  pollContentSchema,
  progressiveContentSchema,
  orderingContentSchema,
  oddOneOutContentSchema,
  emojiContentSchema,
  wordRaceContentSchema,
]);

export type McqContent = z.infer<typeof mcqContentSchema>;
export type NumericContent = z.infer<typeof numericContentSchema>;
export type BooleanContent = z.infer<typeof booleanContentSchema>;
export type FillBlankContent = z.infer<typeof fillBlankContentSchema>;
export type OpenAnswerContent = z.infer<typeof openAnswerContentSchema>;
export type PollContent = z.infer<typeof pollContentSchema>;
export type ProgressiveContent = z.infer<typeof progressiveContentSchema>;
export type OrderingContent = z.infer<typeof orderingContentSchema>;
export type OddOneOutContent = z.infer<typeof oddOneOutContentSchema>;
export type EmojiContent = z.infer<typeof emojiContentSchema>;
export type WordRaceContent = z.infer<typeof wordRaceContentSchema>;
export type ContentItem = z.infer<typeof contentItemSchema>;

export interface Category {
  id: string;
  nameAr: string;
  emoji: string;
}

/**
 * Swap interface: JsonSource in the prototype, DbSource once Postgres and the Redis cache
 * land. Round types never touch this — the engine hydrates content and hands it in.
 */
export interface ContentSource {
  preload?(categoryIds: string[]): Promise<void>;
  pick(query: ContentQuery): Promise<ContentItem[]>;
  countBy(categoryIds: string[], shape: ContentShape): Promise<number>;
  categories(): Promise<Category[]>;
}

export interface ContentQuery {
  categoryIds: string[];
  shape: ContentShape;
  count: number;
  excludeIds?: string[];
  difficulty?: Difficulty;
}
