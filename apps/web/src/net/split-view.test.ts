import { describe, expect, it } from 'vitest';
import { MatchEngine, MemoryStore, toView } from '@game/engine';
import { BrowserContentSource } from '../content/browser-source.js';
import { mergeSplitView, splitViewUpdates, type ProjectionRecord } from './split-view.js';

describe('public and private room projections', () => {
  it('round-trips eight redacted player views with less duplicated payload and no public player identity', async () => {
    const content = new BrowserContentSource();
    const store = new MemoryStore();
    const engine = new MatchEngine(store, content);
    const room = await engine.createRoom('host');
    for (let index = 1; index < 8; index += 1) await engine.join(room.state.code, `guest${index}`);
    const state = (await store.get(room.state.code))!;
    const categories = await content.categories();
    const views = Object.fromEntries(state.players.map((player, index) => [`views/uid${index}`, {
      slot: String(index + 1), json: JSON.stringify(toView(state, player.id, categories, 123)),
      version: state.version, updatedAtMs: 123, leaseOwnerId: 'runtime',
    }]));
    const updates = splitViewUpdates(views);
    const shared = updates.publicView as ProjectionRecord;
    expect(JSON.parse(shared.json)).not.toHaveProperty('you');
    for (let index = 0; index < 8; index += 1) {
      expect(mergeSplitView(shared, updates[`privateViews/uid${index}`] as typeof shared))
        .toEqual(JSON.parse(views[`views/uid${index}`]!.json));
    }
    expect(JSON.stringify(updates).length).toBeLessThan(JSON.stringify(views).length * 0.5);
  });

  it('keeps personal choices private and refuses to combine mismatched versions or leases', () => {
    const base = { code: 'ABCDE', round: { view: { textAr: 'Question', options: ['A', 'B'], myChoice: 0 } } };
    const updates = splitViewUpdates({
      'views/a': { slot: '1', json: JSON.stringify({ ...base, you: { id: 'p1' } }), version: 2, updatedAtMs: 10, leaseOwnerId: 'runtime' },
      'views/b': { slot: '2', json: JSON.stringify({ ...base, you: { id: 'p2' } }), version: 2, updatedAtMs: 10, leaseOwnerId: 'runtime' },
    });
    const shared = updates.publicView as ProjectionRecord;
    const privateView = updates['privateViews/a'] as typeof shared;
    expect(shared.json).not.toContain('myChoice');
    expect(privateView.json).toContain('myChoice');
    expect(mergeSplitView(shared, { ...privateView, version: 1 })).toBeNull();
    expect(mergeSplitView(shared, { ...privateView, leaseOwnerId: 'stale' })).toBeNull();
  });
});
