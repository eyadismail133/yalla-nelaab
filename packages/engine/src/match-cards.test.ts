import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JsonSource } from '../../../apps/server/src/content/json-source.js';
import { MatchEngine, MemoryStore, toView } from './index.js';

const content = new JsonSource(fileURLToPath(new URL('../../../content/seed', import.meta.url)));

async function match(roundTypeId = 'mcq_race') {
  const store = new MemoryStore();
  const engine = new MatchEngine(store, content, { now: () => 100_000 });
  const { state, playerId: hostId } = await engine.createRoom('host', { format: 'focused', roundTypeId, roundCount: 5 });
  const { playerId: guestId } = await engine.join(state.code, 'guest');
  await engine.start(state.code, hostId);
  return { engine, store, code: state.code, hostId, guestId };
}

describe('two single-use match cards', () => {
  it('doubles the selected round points once and rejects reuse or activation after the intro', async () => {
    const { engine, store, code, hostId, guestId } = await match();
    await engine.submitAction(code, guestId, 1, { kind: 'card', card: 'double_captain' });
    await expect(engine.submitAction(code, guestId, 1, { kind: 'card', card: 'double_captain' })).rejects.toThrow();
    let state = await engine.skipPhase(code, hostId);
    await expect(engine.submitAction(code, hostId, 1, { kind: 'card', card: 'double_captain' })).rejects.toThrow();
    const choice = (state.roundState as { item: { correctIndex: number } }).item.correctIndex;
    await engine.submitAction(code, hostId, 1, { kind: 'answer', choice });
    state = await engine.submitAction(code, guestId, 1, { kind: 'answer', choice });
    expect(state.lastRoundScores!.find((score) => score.playerId === guestId)!.points)
      .toBe(state.lastRoundScores!.find((score) => score.playerId === hostId)!.points * 2);
    expect((await store.get(code))!.phase).toBe('round_result');
  });

  it('VAR hides exactly two wrong choices for its owner, survives snapshots, and resets on rematch', async () => {
    const { engine, store, code, hostId, guestId } = await match();
    await engine.skipPhase(code, hostId);
    const state = await engine.submitAction(code, hostId, 1, { kind: 'card', card: 'var' });
    const hostView = toView(state, hostId, await content.categories());
    const guestView = toView(state, guestId, await content.categories());
    const hint = hostView.you.cards!.varHint!;
    expect(hint.hiddenOptions).toHaveLength(2);
    expect(hint.hiddenOptions).not.toContain((state.roundState as { item: { correctIndex: number } }).item.correctIndex);
    expect(guestView.you.cards!.varHint).toBeNull();
    await expect(engine.submitAction(code, hostId, 1, { kind: 'card', card: 'var' })).rejects.toThrow();
    const restoredStore = new MemoryStore();
    await restoredStore.create(JSON.parse(JSON.stringify(state)));
    expect(toView((await restoredStore.get(code))!, hostId, await content.categories()).you.cards).toEqual(hostView.you.cards);
    await engine.leave(code, guestId);
    const rematch = await engine.rematch(code, hostId);
    expect(toView(rematch, hostId, await content.categories()).you.cards!.varAvailable).toBe(true);
  });

  it('gives a numeric range hint without publishing the exact answer or consuming unsupported cards', async () => {
    const { engine, code, hostId, guestId } = await match('numeric_guess');
    await expect(engine.submitAction(code, hostId, 1, { kind: 'card', card: 'var' })).rejects.toThrow();
    await engine.skipPhase(code, hostId);
    const state = await engine.submitAction(code, hostId, 1, { kind: 'card', card: 'var' });
    const hint = toView(state, hostId, await content.categories()).you.cards!.varHint!;
    const correct = (state.roundState as { item: { correctValue: number } }).item.correctValue;
    expect(hint.range![0]).toBeLessThanOrEqual(correct);
    expect(hint.range![1]).toBeGreaterThan(correct);
    expect(toView(state, guestId, await content.categories()).you.cards!.varAvailable).toBe(true);
  });
});
