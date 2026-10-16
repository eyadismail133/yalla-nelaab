import {
  CATEGORY_AGNOSTIC_SHAPES,
  contentItemSchema,
  type Category,
  type ContentItem,
  type ContentQuery,
  type ContentShape,
  type ContentSource,
} from '@game/shared';

export interface SeedFile {
  category: Category;
  questions: unknown[];
}

export type SeedLoader = (categoryId: string) => Promise<SeedFile>;

/**
 * Lightweight category manifest so `categories()` resolves immediately without downloading
 * any of the 14 question banks (8,901 questions). Ordered identically to `content/seed/*.json`.
 */
export const CATEGORIES: readonly Category[] = [
  { id: 'anime', nameAr: 'أنمي وألعاب', emoji: '🎮' },
  { id: 'bluff', nameAr: 'غرايب ومعلومات', emoji: '🤥' },
  { id: 'cinema', nameAr: 'سينما ودراما', emoji: '🎬' },
  { id: 'food', nameAr: 'أكل ومطبخ', emoji: '🍽️' },
  { id: 'football', nameAr: 'كورة', emoji: '⚽' },
  { id: 'friends', nameAr: 'مين فينا', emoji: '🫵' },
  { id: 'general', nameAr: 'معلومات عامة', emoji: '💡' },
  { id: 'geography', nameAr: 'جغرافيا', emoji: '🌍' },
  { id: 'history', nameAr: 'تاريخ', emoji: '🏛️' },
  { id: 'islamic', nameAr: 'إسلاميات', emoji: '🕌' },
  { id: 'music', nameAr: 'موسيقى وأغاني', emoji: '🎵' },
  { id: 'nature', nameAr: 'حيوانات وطبيعة', emoji: '🐾' },
  { id: 'proverbs', nameAr: 'أمثال ولغة عربية', emoji: '🗣️' },
  { id: 'science', nameAr: 'علوم وتكنولوجيا', emoji: '🔬' },
];

const KNOWN_CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));
const AGNOSTIC_CATEGORY_ID = 'friends';

/**
 * Vite lazy JSON importers for `content/seed/*.json`.
 *
 * Each category bank is split into its own on-demand chunk by Vite's `import.meta.glob`,
 * keeping the 8,901-question bank out of the initial JS entry bundle.
 */
function createViteSeedLoader(): SeedLoader {
  const modules = import.meta.glob<SeedFile>('../../../../content/seed/*.json', {
    import: 'default',
  });
  const byCategoryId = new Map<string, () => Promise<SeedFile>>();

  for (const [path, importer] of Object.entries(modules)) {
    const match = /\/([^/]+)\.json$/.exec(path);
    if (match?.[1]) {
      byCategoryId.set(match[1], importer);
    }
  }

  return async (categoryId: string): Promise<SeedFile> => {
    const importer = byCategoryId.get(categoryId);
    if (!importer) {
      throw new Error(`Unknown seed category "${categoryId}"`);
    }
    return importer();
  };
}

/**
 * Browser-compatible `ContentSource` backed by lazy-loaded category JSON chunks.
 *
 * Preserves the exact validation, category-agnostic routing (`poll` and `word_race` from
 * `friends.json`), difficulty preference, exclusion/no-repeat, and exhaustion semantics of
 * the server's `JsonSource` while only downloading the category files a match actually uses.
 */
export class BrowserContentSource implements ContentSource {
  private readonly loaded = new Map<string, Promise<ContentItem[]>>();
  private readonly seenIds = new Map<string, string>();
  private readonly loader: SeedLoader;
  private readonly rng: () => number;

  constructor(loader: SeedLoader = createViteSeedLoader(), rng: () => number = Math.random) {
    this.loader = loader;
    this.rng = rng;
  }

  async categories(): Promise<Category[]> {
    return CATEGORIES.map((c) => ({ ...c }));
  }

  async countBy(categoryIds: string[], shape: ContentShape): Promise<number> {
    const items = await this.itemsFor(categoryIds, shape);
    return items.filter((i) => i.shape === shape && this.inScope(i, categoryIds, shape)).length;
  }

  async pick(query: ContentQuery): Promise<ContentItem[]> {
    const items = await this.itemsFor(query.categoryIds, query.shape);
    const exclude = new Set(query.excludeIds ?? []);
    const pool = items.filter(
      (i) =>
        i.shape === query.shape &&
        this.inScope(i, query.categoryIds, query.shape) &&
        !exclude.has(i.id),
    );

    const ordered =
      query.difficulty === undefined
        ? this.shuffle(pool)
        : this.shuffle(pool).sort(
            (a, b) =>
              Math.abs(a.difficulty - query.difficulty!) - Math.abs(b.difficulty - query.difficulty!),
          );

    return ordered.slice(0, query.count);
  }

  private inScope(item: ContentItem, categoryIds: string[], shape: ContentShape): boolean {
    if (CATEGORY_AGNOSTIC_SHAPES.includes(shape)) return true;
    return categoryIds.includes(item.categoryId);
  }

  private async itemsFor(categoryIds: string[], shape: ContentShape): Promise<ContentItem[]> {
    const targetIds = CATEGORY_AGNOSTIC_SHAPES.includes(shape)
      ? [AGNOSTIC_CATEGORY_ID]
      : [...new Set(categoryIds.filter((id) => KNOWN_CATEGORY_IDS.has(id)))];

    const banks = await Promise.all(targetIds.map((id) => this.loadCategory(id)));
    return banks.flat();
  }

  private loadCategory(categoryId: string): Promise<ContentItem[]> {
    const existing = this.loaded.get(categoryId);
    if (existing) return existing;

    const promise = (async () => {
      const raw = await this.loader(categoryId);
      const parsedItems: ContentItem[] = [];
      const localIds = new Set<string>();

      for (const question of raw.questions) {
        const record = (question ?? {}) as Record<string, unknown>;
        const parsed = contentItemSchema.safeParse({
          ...record,
          categoryId: raw.category.id,
        });
        if (!parsed.success) {
          throw new Error(
            `Invalid question "${String(record.id ?? 'unknown')}" in ${categoryId}.json: ${parsed.error.issues
              .map((i) => `${i.path.join('.')} ${i.message}`)
              .join('; ')}`,
          );
        }

        const id = parsed.data.id;
        const previousCategory = this.seenIds.get(id);
        if (localIds.has(id) || (previousCategory !== undefined && previousCategory !== categoryId)) {
          throw new Error(`Duplicate question id in seed content: ${id}`);
        }
        localIds.add(id);
        this.seenIds.set(id, categoryId);
        parsedItems.push(parsed.data);
      }

      return parsedItems;
    })().catch((err) => {
      this.loaded.delete(categoryId);
      throw err;
    });

    // Evict rejected loads so a transient chunk error does not permanently poison the cache.
    this.loaded.set(categoryId, promise);

    return promise;
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

export function createViteContentSource(rng: () => number = Math.random): BrowserContentSource {
  return new BrowserContentSource(createViteSeedLoader(), rng);
}
