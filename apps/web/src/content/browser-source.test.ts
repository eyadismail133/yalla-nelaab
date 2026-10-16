import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORY_AGNOSTIC_SHAPES, CONTENT_SHAPES, type ContentShape } from '@game/shared';
import { ROUND_TYPES } from '@game/rounds';
import { JsonSource } from '../../../../apps/server/src/content/json-source.js';
import { BrowserContentSource, CATEGORIES, createViteContentSource } from './browser-source.js';

const SEED_DIR = fileURLToPath(new URL('../../../../content/seed', import.meta.url));
const serverSource = new JsonSource(SEED_DIR);

function makeNodeLoader() {
  return vi.fn(async (categoryId: string) => {
    const raw = JSON.parse(readFileSync(join(SEED_DIR, `${categoryId}.json`), 'utf8'));
    return raw;
  });
}

describe('BrowserContentSource', () => {
  it('matches server JsonSource category metadata in exact id, nameAr, emoji and order without loading banks', async () => {
    const loader = makeNodeLoader();
    const browserSource = new BrowserContentSource(loader);

    const browserCategories = await browserSource.categories();
    const serverCategories = await serverSource.categories();

    expect(loader).not.toHaveBeenCalled();
    expect(browserCategories).toHaveLength(14);
    expect(browserCategories).toEqual(serverCategories);
    expect(CATEGORIES).toEqual(serverCategories);
  });

  it('loads only selected categories for topic-scoped queries and caches loaded banks', async () => {
    const loader = makeNodeLoader();
    const browserSource = new BrowserContentSource(loader);

    const count = await browserSource.countBy(['football'], 'mcq');
    expect(count).toBe(await serverSource.countBy(['football'], 'mcq'));
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith('football');

    const picked = await browserSource.pick({ categoryIds: ['football'], shape: 'mcq', count: 3 });
    expect(picked).toHaveLength(3);
    expect(picked.every((item) => item.categoryId === 'football' && item.shape === 'mcq')).toBe(true);
    // Cached: no second call for football
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('always loads friends bank for category-agnostic shapes (poll, word_race) regardless of selected categories', async () => {
    const loader = makeNodeLoader();
    const browserSource = new BrowserContentSource(loader);

    for (const shape of CATEGORY_AGNOSTIC_SHAPES) {
      const countScoped = await browserSource.countBy(['football'], shape);
      const countEmpty = await browserSource.countBy([], shape);
      const serverCount = await serverSource.countBy(['football'], shape);

      expect(countScoped).toBe(serverCount);
      expect(countEmpty).toBe(serverCount);
      expect(countScoped).toBeGreaterThan(0);

      const items = await browserSource.pick({ categoryIds: ['football'], shape, count: 2 });
      expect(items).toHaveLength(2);
      expect(items.every((i) => i.shape === shape)).toBe(true);
    }

    expect(loader).toHaveBeenCalledWith('friends');
    expect(loader).not.toHaveBeenCalledWith('football');
  });

  it('preserves exclusion/no-repeat, difficulty preference, and exhaustion semantics', async () => {
    const loader = makeNodeLoader();
    const browserSource = new BrowserContentSource(loader);

    // Exclusion / no-repeat
    const first = await browserSource.pick({ categoryIds: ['islamic'], shape: 'mcq', count: 4 });
    const second = await browserSource.pick({
      categoryIds: ['islamic'],
      shape: 'mcq',
      count: 4,
      excludeIds: first.map((i) => i.id),
    });
    expect(second.filter((i) => first.some((f) => f.id === i.id))).toEqual([]);

    // Difficulty preference
    const easy = await browserSource.pick({
      categoryIds: ['general', 'history', 'geography'],
      shape: 'mcq',
      count: 3,
      difficulty: 1,
    });
    expect(Math.min(...easy.map((i) => i.difficulty))).toBe(1);

    // Nearest difficulty degradation
    const degraded = await browserSource.pick({
      categoryIds: ['football'],
      shape: 'fill_blank',
      count: 2,
      difficulty: 5,
    });
    expect(degraded.length).toBeGreaterThan(0);

    // Exhaustion returns fewer items without throwing
    const exhausted = await browserSource.pick({
      categoryIds: ['football'],
      shape: 'fill_blank',
      count: 999,
    });
    expect(exhausted.length).toBeGreaterThan(0);
    expect(exhausted.length).toBeLessThan(999);
  });

  it('validates all 8901 seeded questions across 14 categories and matches server counts', async () => {
    const loader = makeNodeLoader();
    const browserSource = new BrowserContentSource(loader);
    const ids = (await browserSource.categories()).map((c) => c.id);

    let total = 0;
    for (const shape of CONTENT_SHAPES as readonly ContentShape[]) {
      const browserCount = await browserSource.countBy(ids, shape);
      const serverCount = await serverSource.countBy(ids, shape);
      expect(browserCount, shape).toBe(serverCount);
      total += browserCount;
    }
    expect(total).toBe(8901);
    expect(ROUND_TYPES.length).toBeGreaterThan(0);
  });

  it('rejects malformed questions and duplicate question IDs on load', async () => {
    const badSchemaSource = new BrowserContentSource(async (categoryId) => ({
      category: { id: categoryId, nameAr: 'تجربة', emoji: '🧪' },
      questions: [{ id: 'bad-1', shape: 'mcq', difficulty: 1, textAr: 'سؤال بدون اختيارات' }],
    }));

    await expect(badSchemaSource.countBy(['football'], 'mcq')).rejects.toThrow(/Invalid question "bad-1"/);

    const dupSource = new BrowserContentSource(async (categoryId) => ({
      category: { id: categoryId, nameAr: 'تجربة', emoji: '🧪' },
      questions: [
        {
          id: 'dup-id',
          shape: 'poll',
          difficulty: 1,
          textAr: 'سؤال ١',
        },
        {
          id: 'dup-id',
          shape: 'poll',
          difficulty: 1,
          textAr: 'سؤال ٢',
        },
      ],
    }));

    await expect(dupSource.countBy(['friends'], 'poll')).rejects.toThrow(/Duplicate question id/);
  });

  it('exposes createViteContentSource factory that lazily loads seed JSON chunks', async () => {
    const source = createViteContentSource();
    expect(await source.categories()).toEqual(CATEGORIES);
    const items = await source.pick({ categoryIds: ['football'], shape: 'mcq', count: 2 });
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.categoryId === 'football' && i.shape === 'mcq')).toBe(true);
  });
});
