import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CATEGORY_AGNOSTIC_SHAPES,
  contentItemSchema,
  type Category,
  type ContentItem,
  type ContentQuery,
  type ContentShape,
  type ContentSource,
} from '@game/shared';

interface SeedFile {
  category: Category;
  questions: ContentItem[];
}

/**
 * The prototype's ContentSource: everything loaded from `content/seed/*.json` into memory.
 *
 * Deliberately implements the same interface DbSource will, so swapping Postgres in later is a
 * constructor change in one file rather than a rewrite. Validation runs at load time so a
 * malformed question fails at boot with a useful message, instead of throwing mid-match.
 */
export class JsonSource implements ContentSource {
  private readonly items: ContentItem[] = [];
  private readonly cats: Category[] = [];
  private readonly rng: () => number;

  constructor(seedDir: string, rng: () => number = Math.random) {
    this.rng = rng;
    const items: ContentItem[] = [];
    const cats: Category[] = [];

    const files = readdirSync(seedDir).filter((f) => f.endsWith('.json'));
    if (files.length === 0) throw new Error(`No seed content found in ${seedDir}`);

    for (const file of files) {
      const raw = JSON.parse(readFileSync(join(seedDir, file), 'utf8')) as SeedFile;
      cats.push(raw.category);

      for (const question of raw.questions) {
        const parsed = contentItemSchema.safeParse({
          ...question,
          categoryId: raw.category.id,
        });
        if (!parsed.success) {
          throw new Error(
            `Invalid question "${question.id}" in ${file}: ${parsed.error.issues
              .map((i) => `${i.path.join('.')} ${i.message}`)
              .join('; ')}`,
          );
        }
        items.push(parsed.data);
      }
    }

    const ids = items.map((i) => i.id);
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (duplicate) throw new Error(`Duplicate question id in seed content: ${duplicate}`);

    this.items = items;
    this.cats = cats;
  }

  async categories(): Promise<Category[]> {
    return [...this.cats];
  }

  async countBy(categoryIds: string[], shape: ContentShape): Promise<number> {
    return this.items.filter((i) => i.shape === shape && this.inScope(i, categoryIds, shape)).length;
  }

  /**
   * Some shapes have no topic at all. "مين أكتر واحد فينا بيتأخر؟" is not a football question or
   * a history question, so filtering it by the player's chosen categories would hide the most
   * social round in the game behind an unrelated setting.
   */
  private inScope(item: ContentItem, categoryIds: string[], shape: ContentShape): boolean {
    if (CATEGORY_AGNOSTIC_SHAPES.includes(shape)) return true;
    return categoryIds.includes(item.categoryId);
  }

  async pick(query: ContentQuery): Promise<ContentItem[]> {
    const exclude = new Set(query.excludeIds ?? []);
    const pool = this.items.filter(
      (i) =>
        i.shape === query.shape &&
        this.inScope(i, query.categoryIds, query.shape) &&
        !exclude.has(i.id),
    );

    // Difficulty is a preference, not a filter. A tournament asking for difficulty 5 in a
    // category that only has easy questions should still get a playable round rather than an
    // error — nearest-difficulty ordering degrades gracefully.
    const ordered =
      query.difficulty === undefined
        ? this.shuffle(pool)
        : this.shuffle(pool).sort(
            (a, b) =>
              Math.abs(a.difficulty - query.difficulty!) - Math.abs(b.difficulty - query.difficulty!),
          );

    return ordered.slice(0, query.count);
  }

  private shuffle<T>(input: T[]): T[] {
    const out = [...input];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.rng() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
}
