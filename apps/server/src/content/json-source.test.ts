import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  CATEGORY_AGNOSTIC_SHAPES,
  CONTENT_SHAPES,
  normalizeArabic,
  type ContentItem,
  type ContentShape,
} from '@game/shared';
import { QUICKFIRE_ITEMS, ROUND_TYPES } from '@game/rounds';
import { JsonSource } from './json-source.js';

const SEED_DIR = fileURLToPath(new URL('../../../../content/seed', import.meta.url));

const source = new JsonSource(SEED_DIR);
// Derived from the registry so a new round type cannot ship with no content behind it and
// still pass this file.
const shapesInUse: ContentShape[] = [...new Set(ROUND_TYPES.flatMap((t) => t.contentShapes))];

/** Shapes every category must cover on its own, so a single-category match still works. */
const perCategoryShapes = shapesInUse.filter((s) => !CATEGORY_AGNOSTIC_SHAPES.includes(s) && s !== 'open_answer');

describe('seed content', () => {
  it('loads and validates every seeded question', async () => {
    const categories = await source.categories();
    expect(categories.length).toBeGreaterThanOrEqual(14);
  });

  it('carries enough questions to run a real match', async () => {
    const ids = (await source.categories()).map((c) => c.id);
    const total = await Promise.all(shapesInUse.map((s) => source.countBy(ids, s)));
    expect(total.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(7500);
  });

  it('has enough of every shape the prototype plays', async () => {
    const ids = (await source.categories()).map((c) => c.id);
    for (const shape of shapesInUse) {
      // A shape with too little content silently drops its round type out of the playlist,
      // which is exactly the "every round is multiple choice" failure this project exists to
      // avoid — so it is worth asserting rather than discovering in a match.
      //
      // poll and word_race are the category-agnostic shapes and live only in friends.json's own
      // profile, not the 656-question profile the other thirteen categories share — the plan
      // fixes them at 120 and 15 respectively, well under the 200 every topic-bearing shape
      // reaches once doubled. So they keep their own, lower floors instead of the shared one.
      const floor = shape === 'word_race' ? 15 : shape === 'poll' ? 120 : 200;
      expect(await source.countBy(ids, shape), shape).toBeGreaterThanOrEqual(floor);
    }
  });

  it('has enough boolean statements for a quickfire round in any single category', async () => {
    for (const category of await source.categories()) {
      expect(await source.countBy([category.id], 'boolean'), category.id).toBeGreaterThanOrEqual(
        QUICKFIRE_ITEMS,
      );
    }
  });

  it('lets any single category on its own supply a varied match', async () => {
    // A player who picks only كورة still has to get a playable, mixed match out of it.
    for (const category of await source.categories()) {
      for (const shape of perCategoryShapes) {
        expect(
          await source.countBy([category.id], shape),
          `${category.id}/${shape}`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('keeps topic-less prompts available whatever categories are chosen', async () => {
    // مين فينا؟ is about the people in the room, so a category filter must not hide it.
    for (const shape of CATEGORY_AGNOSTIC_SHAPES) {
      const scopedToOne = await source.countBy(['football'], shape);
      const everything = await source.countBy([], shape);
      expect(scopedToOne, shape).toBe(everything);
      expect(scopedToOne, shape).toBeGreaterThan(0);
    }
  });

  it('marks fill_blank questions with a visible blank', async () => {
    const ids = (await source.categories()).map((c) => c.id);
    const items = await source.pick({ categoryIds: ids, shape: 'fill_blank', count: 100 });
    for (const item of items) {
      if (item.shape !== 'fill_blank') continue;
      expect(item.textAr, item.id).toContain('____');
    }
  });

  it('never marks a fill_blank answer as already visible in the prompt', async () => {
    const ids = (await source.categories()).map((c) => c.id);
    const items = await source.pick({ categoryIds: ids, shape: 'fill_blank', count: 100 });
    for (const item of items) {
      if (item.shape !== 'fill_blank') continue;
      expect(item.textAr, item.id).not.toContain(item.answerAr);
    }
  });

  it('only uses shapes the platform knows about', async () => {
    const ids = (await source.categories()).map((c) => c.id);
    for (const shape of CONTENT_SHAPES) {
      const count = await source.countBy(ids, shape);
      if (count > 0) expect(shapesInUse).toContain(shape);
    }
  });
});

describe('JsonSource.pick', () => {
  it('returns the requested count', async () => {
    const items = await source.pick({ categoryIds: ['football'], shape: 'mcq', count: 3 });
    expect(items).toHaveLength(3);
  });

  it('only returns the requested shape and categories', async () => {
    const items = await source.pick({ categoryIds: ['history'], shape: 'numeric', count: 5 });
    for (const item of items) {
      expect(item.shape).toBe('numeric');
      expect(item.categoryId).toBe('history');
    }
  });

  it('honours the exclusion list so a match never repeats a question', async () => {
    const first = await source.pick({ categoryIds: ['islamic'], shape: 'mcq', count: 4 });
    const second = await source.pick({
      categoryIds: ['islamic'],
      shape: 'mcq',
      count: 4,
      excludeIds: first.map((i) => i.id),
    });
    const overlap = second.filter((i) => first.some((f) => f.id === i.id));
    expect(overlap).toEqual([]);
  });

  it('prefers the requested difficulty', async () => {
    const items = await source.pick({
      categoryIds: ['general', 'history', 'geography'],
      shape: 'mcq',
      count: 3,
      difficulty: 1,
    });
    expect(Math.min(...items.map((i) => i.difficulty))).toBe(1);
  });

  it('degrades to the nearest difficulty instead of returning nothing', async () => {
    const items = await source.pick({
      categoryIds: ['football'],
      shape: 'fill_blank',
      count: 2,
      difficulty: 5,
    });
    expect(items.length).toBeGreaterThan(0);
  });

  it('returns fewer items rather than throwing when the pool is small', async () => {
    const items = await source.pick({ categoryIds: ['football'], shape: 'fill_blank', count: 99 });
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(99);
  });

  it('shuffles, so two matches do not open with the same question', async () => {
    const runs = await Promise.all(
      Array.from({ length: 12 }, () =>
        source.pick({ categoryIds: ['general'], shape: 'mcq', count: 1 }),
      ),
    );
    expect(new Set(runs.map((r) => r[0]!.id)).size).toBeGreaterThan(1);
  });
});

/**
 * The bank has one job the schema cannot check: being deep enough that an evening of matches
 * does not start recycling questions.
 *
 * The engine already excludes what a match has used, but when a pool runs dry it drops that
 * exclusion rather than crashing — a deliberate choice, and the reason "we keep seeing the same
 * questions" shows up as a content problem rather than an error. These tests put a floor under
 * it, expressed in the unit that actually matters: **rounds a type can run before it repeats.**
 */
describe('bank depth', () => {
  /**
   * Four rounds of every type, inside one category.
   *
   * The binding case is قطع الأرض, which eats nine mcq questions in a single round — so this
   * asserts thirty-six mcq per category on its own. A player who picks only كورة has to get
   * four land-grab rounds out of it without seeing a question twice.
   */
  const ROUNDS_PER_CATEGORY = 4;
  /**
   * مين فينا carries a deliberately smaller profile than the other thirteen categories (its
   * own table in the plan, not an oversight) — every one of its shapes still clears three
   * rounds' worth, so it gets a lower bar here instead of being held to the shared one.
   */
  const ROUNDS_PER_CATEGORY_FRIENDS = 3;
  /** With every category on, the same types should carry a long night. */
  const ROUNDS_ACROSS_ALL = 25;

  it('can run every round type twice inside any single category', async () => {
    for (const category of await source.categories()) {
      const rounds = category.id === 'friends' ? ROUNDS_PER_CATEGORY_FRIENDS : ROUNDS_PER_CATEGORY;
      for (const type of ROUND_TYPES) {
        for (const shape of type.contentShapes) {
          // Topic-less shapes are pooled across the whole bank by design, so a per-category
          // floor would be measuring the wrong thing for them.
          if (CATEGORY_AGNOSTIC_SHAPES.includes(shape)) continue;
          expect(
            await source.countBy([category.id], shape),
            `${category.id}/${type.id}`,
          ).toBeGreaterThanOrEqual(type.itemsPerRound * rounds);
        }
      }
    }
  });

  it('can run every round type ten times with every category selected', async () => {
    const ids = (await source.categories()).map((c) => c.id);
    for (const type of ROUND_TYPES) {
      for (const shape of type.contentShapes) {
        // word_race lives only in friends.json (15 items, by design — see the shape-floor
        // test above), so it never reaches the shared twenty-five-rounds bar; it clears fifteen
        // rounds instead, which is what its own bank actually holds.
        const rounds = shape === 'word_race' ? 15 : ROUNDS_ACROSS_ALL;
        expect(await source.countBy(ids, shape), `${type.id}/${shape}`).toBeGreaterThanOrEqual(
          type.itemsPerRound * rounds,
        );
      }
    }
  });

  it('holds no two questions of a shape that are really the same question', async () => {
    // Reworded duplicates are worse than a small bank: they survive the engine's id-based
    // exclusion, so the same fact can come back inside a single match wearing new words.
    const ids = (await source.categories()).map((c) => c.id);
    const clashes: string[] = [];

    for (const shape of CONTENT_SHAPES) {
      const items = await source.pick({ categoryIds: ids, shape, count: 10_000 });
      clashes.push(...findClashes(items));
    }

    expect(clashes).toEqual([]);
  });
});

/**
 * Same result as the naive O(n²) all-pairs scan, just reached without tokenizing each item
 * repeatedly and without comparing pairs that share no content word at all — a pair with zero
 * shared tokens can never reach the 0.6 threshold, so it never needs `similarity()` at all.
 *
 * An inverted index (token → item indices) turns "every pair" into "every pair that shares a
 * token", which is what makes this tractable once the bank is several thousand questions deep.
 */
function findClashes(items: ContentItem[]): string[] {
  const tokenSets = items.map((item) => tokens(comparableTextOf(item)));

  const postings = new Map<string, number[]>();
  for (const [i, tokenSet] of tokenSets.entries()) {
    for (const token of tokenSet) {
      const list = postings.get(token);
      if (list) list.push(i);
      else postings.set(token, [i]);
    }
  }

  const candidatePairs = new Set<string>();
  for (const list of postings.values()) {
    for (let a = 0; a < list.length; a += 1) {
      for (let b = a + 1; b < list.length; b += 1) {
        const i = list[a]!;
        const j = list[b]!;
        candidatePairs.add(i < j ? `${i}:${j}` : `${j}:${i}`);
      }
    }
  }

  const clashes: string[] = [];
  for (const pair of candidatePairs) {
    const [iStr, jStr] = pair.split(':');
    const i = Number(iStr);
    const j = Number(jStr);
    const left = tokenSets[i]!;
    const right = tokenSets[j]!;
    // Same early-exit the Jaccard formula implies: with |A∩B| ≤ min(|A|,|B|), the ratio can
    // only reach 0.6 if the smaller set is at least 60% the size of the larger one.
    if (Math.min(left.size, right.size) / Math.max(left.size, right.size) < 0.6) continue;
    if (similarityOfTokenSets(left, right) >= 0.6) {
      clashes.push(`${items[i]!.id} ↔ ${items[j]!.id}`);
    }
  }
  return clashes;
}

/** The text two questions are compared on — includes the answer, not just the prompt. */
function comparableTextOf(item: ContentItem): string {
  switch (item.shape) {
    case 'progressive':
      return `${item.hints.join(' ')} ${item.answerAr}`;
    case 'ordering':
      return `${item.textAr} ${item.items.join(' ')}`;
    case 'odd_one_out':
      return `${item.textAr} ${item.items.join(' ')} ${item.reasonAr}`;
    case 'mcq':
      return `${item.textAr} ${item.options[item.correctIndex] ?? ''}`;
    case 'numeric':
      return `${item.textAr} ${item.correctValue}`;
    case 'boolean':
    case 'poll':
      return item.textAr;
    case 'emoji':
      return `${item.emojis} ${item.answerAr}`;
    case 'word_race':
      return `${item.fieldsAr.join(' ')} ${item.letters.join(' ')}`;
    default:
      return `${item.textAr} ${item.answerAr}`;
  }
}

/**
 * Token overlap after Arabic normalization — Jaccard rather than edit distance, because the
 * failure being caught is rewording, not typos. Two askings of the same fact share almost all
 * their content words and almost none of their character positions.
 */
function similarity(a: string, b: string): number {
  return similarityOfTokenSets(tokens(a), tokens(b));
}

/**
 * Same formula as `similarity()`, taking pre-computed token sets so a hot loop over many pairs
 * never re-tokenizes the same item twice.
 */
function similarityOfTokenSets(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Words too common to say anything about whether two questions are the same. */
const STOP_WORDS = new Set([
  'في', 'من', 'على', 'عن', 'مع', 'الي', 'التي', 'الذي', 'ده', 'دي', 'ايه', 'مين', 'كام',
  'هو', 'هي', 'كان', 'كانت', 'اللي', 'ولا', 'بس', 'يا', 'ان', 'انت', 'او', 'و', 'ال',
]);

function tokens(input: string): Set<string> {
  return new Set(
    normalizeArabic(input)
      .split(' ')
      // Filtered before stripping `ال`: `اللي` is a stop word whose stem is not, so stripping
      // first would smuggle every filler word back in as a two-letter token.
      .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
      .map((word) => (word.startsWith('ال') && word.length > 3 ? word.slice(2) : word))
      .filter((word) => word.length > 1),
  );
}
