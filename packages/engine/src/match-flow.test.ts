import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JsonSource } from '../../../apps/server/src/content/json-source.js';
import { MatchEngine, MemoryStore, toView } from './index.js';

const content = new JsonSource(fileURLToPath(new URL('../../../content/seed', import.meta.url)));

describe('match flow upgrades', () => {
  it('advances results when every connected participant is ready, including after a disconnect', async () => {
    const engine = new MatchEngine(new MemoryStore(), content);
    const { state: room, playerId: host } = await engine.createRoom('host', { format: 'focused', roundTypeId: 'mcq_race', roundCount: 5 });
    const { playerId: first } = await engine.join(room.code, 'first');
    const { playerId: second } = await engine.join(room.code, 'second');
    await engine.start(room.code, host);
    await engine.skipPhase(room.code, host);
    for (const id of [host, first, second]) await engine.submitAction(room.code, id, 1, { kind: 'answer', choice: 0 });
    await engine.submitAction(room.code, host, 1, { kind: 'result_ready' });
    const waiting = await engine.submitAction(room.code, first, 1, { kind: 'result_ready' });
    expect(waiting.phase).toBe('round_result');
    const next = (await engine.setConnected(room.code, second, false))!;
    expect(next.phase).toBe('round_intro');
    expect(next.roundNo).toBe(2);
    expect(next.resultReady ?? []).toHaveLength(0);
  });

  it('admits late arrivals as spectators without changing scores, lets them watch safely, and promotes them on rematch', async () => {
    const engine = new MatchEngine(new MemoryStore(), content);
    const { state: room, playerId: host } = await engine.createRoom('host', { format: 'focused', roundTypeId: 'mcq_race' });
    const { playerId: guest } = await engine.join(room.code, 'guest');
    await engine.start(room.code, host);
    const before = await engine.skipPhase(room.code, host);
    const late = await engine.join(room.code, 'late');
    expect(late.state.totals).toEqual(before.totals);
    const view = toView(late.state, late.playerId, await content.categories());
    expect(view.you.isSpectator).toBe(true);
    expect(JSON.stringify(view.round?.view)).not.toMatch(/correctIndex|secretAr|answerAr/);
    await expect(engine.submitAction(room.code, late.playerId, 1, { kind: 'answer', choice: 0 })).rejects.toThrow();
    await engine.leave(room.code, guest);
    const rematch = await engine.rematch(room.code, host);
    expect(rematch.players.find((player) => player.id === late.playerId)?.spectator).toBe(false);
    expect(rematch.totals.some((total) => total.playerId === late.playerId)).toBe(true);
  });

  it('allows bounded reactions only between rounds and enforces the throttle in the engine', async () => {
    let now = 100_000;
    const engine = new MatchEngine(new MemoryStore(), content, { now: () => now });
    const { state: room, playerId: host } = await engine.createRoom('host');
    await engine.join(room.code, 'guest');
    let state = await engine.submitAction(room.code, host, 0, { kind: 'reaction', emoji: '⚽' });
    expect(state.reactions?.at(-1)?.emoji).toBe('⚽');
    await expect(engine.submitAction(room.code, host, 0, { kind: 'reaction', emoji: '🔥' })).rejects.toThrow();
    for (let index = 0; index < 20; index += 1) {
      now += 1_100;
      state = await engine.submitAction(room.code, host, 0, { kind: 'reaction', emoji: '🔥' });
    }
    expect(state.reactions!.length).toBeLessThanOrEqual(16);
    await engine.start(room.code, host);
    await engine.skipPhase(room.code, host);
    await expect(engine.submitAction(room.code, host, 1, { kind: 'reaction', emoji: '😂' })).rejects.toThrow();
  });
});
