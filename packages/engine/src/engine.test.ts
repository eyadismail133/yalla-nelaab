import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  MatchEngine,
  EngineError,
  DEFAULT_OPTIONS,
  MemoryStore,
  RoomNotFoundError,
  VersionConflictError,
  generateCode,
  normalizeCode,
  CODE_LENGTH,
  toView,
} from './index.js';
import { JsonSource } from '../../../apps/server/src/content/json-source.js';

const SEED_DIR = fileURLToPath(new URL('../../../content/seed', import.meta.url));
const content = new JsonSource(SEED_DIR);

describe('@game/engine package exports and behavioral parity', () => {
  it('exports all required room engine symbols', () => {
    expect(MatchEngine).toBeDefined();
    expect(EngineError).toBeDefined();
    expect(DEFAULT_OPTIONS).toBeDefined();
    expect(MemoryStore).toBeDefined();
    expect(RoomNotFoundError).toBeDefined();
    expect(VersionConflictError).toBeDefined();
    expect(generateCode).toBeDefined();
    expect(normalizeCode).toBeDefined();
    expect(CODE_LENGTH).toBe(5);
    expect(toView).toBeDefined();
  });

  it('creates a room, joins players, starts a match, and projects views without Node dependencies', async () => {
    const store = new MemoryStore();
    const engine = new MatchEngine(store, content);

    const { state: created, playerId: hostId } = await engine.createRoom('يوسف', {
      roundCount: 5,
      format: 'focused',
      roundTypeId: 'mcq_race',
    });
    expect(created.code).toHaveLength(CODE_LENGTH);

    const { state: joined, playerId: guestId } = await engine.join(
      normalizeCode(` ${created.code.toLowerCase()} `),
      'أحمد',
    );
    expect(joined.players).toHaveLength(2);

    const started = await engine.start(created.code, hostId);
    expect(started.phase).toBe('round_intro');

    const categories = await content.categories();
    const view = toView(started, guestId, categories);
    expect(view.you.id).toBe(guestId);
    expect(view.you.isHost).toBe(false);
    expect(view.round?.view).toBeNull();
  });

  it('toggles player readiness in lobby and clears readiness on join, leave, kick, config change, start, and rematch', async () => {
    const store = new MemoryStore();
    const engine = new MatchEngine(store, content);
    const categories = await content.categories();

    const { state: created, playerId: hostId } = await engine.createRoom('يوسف', {
      roundCount: 5,
      format: 'focused',
      roundTypeId: 'mcq_race',
    });
    const code = created.code;
    const { playerId: guest1Id } = await engine.join(code, 'أحمد');

    // Default ready is false
    let state = (await store.get(code))!;
    expect(toView(state, hostId, categories).players.every((p) => p.ready === false)).toBe(true);

    // Guest 1 toggles ready on
    state = await engine.setReady(code, guest1Id, true);
    expect(toView(state, hostId, categories).players.find((p) => p.id === guest1Id)?.ready).toBe(true);
    expect(toView(state, hostId, categories).players.find((p) => p.id === hostId)?.ready).toBe(false);

    // Join clears readiness
    const { playerId: guest2Id } = await engine.join(code, 'سارة');
    state = (await store.get(code))!;
    expect(toView(state, hostId, categories).players.every((p) => p.ready === false)).toBe(true);

    // Toggle without explicit boolean flips current state
    state = await engine.setReady(code, guest1Id);
    expect(toView(state, hostId, categories).players.find((p) => p.id === guest1Id)?.ready).toBe(true);

    // Configure clears readiness
    state = await engine.configure(code, hostId, { teams: true });
    expect(toView(state, hostId, categories).players.every((p) => p.ready === false)).toBe(true);

    // Ready again, then another player leaving clears readiness
    await engine.setReady(code, guest1Id, true);
    state = (await engine.leave(code, guest2Id))!;
    expect(toView(state, hostId, categories).players.every((p) => p.ready === false)).toBe(true);

    // Ready again, then kicking a player in lobby clears readiness
    const { playerId: guestKickId } = await engine.join(code, 'خالد');
    await engine.setReady(code, guest1Id, true);
    state = await engine.kick(code, hostId, guestKickId);
    expect(toView(state, hostId, categories).players.every((p) => p.ready === false)).toBe(true);

    // Host can start even when players are not marked ready, and mid-match setReady is rejected
    const { playerId: guest3Id } = await engine.join(code, 'مريم');
    await engine.setReady(code, guest3Id, true);
    state = await engine.start(code, hostId);
    expect(state.phase).toBe('round_intro');
    expect(toView(state, hostId, categories).players.every((p) => p.ready === false)).toBe(true);
    await expect(engine.setReady(code, guest1Id, true)).rejects.toThrow(EngineError);

    // Conclude match (abandon via guest leaves) -> podium -> rematch returns to lobby with ready=false
    await engine.leave(code, guest1Id);
    state = (await engine.leave(code, guest3Id))!;
    expect(state.phase).toBe('podium');
    state = await engine.rematch(code, hostId);
    expect(state.phase).toBe('lobby');
    expect(toView(state, hostId, categories).players.every((p) => p.ready === false)).toBe(true);
  });

  it('requires at least two connected players to start a match', async () => {
    const store = new MemoryStore();
    const engine = new MatchEngine(store, content);

    const { state: created, playerId: hostId } = await engine.createRoom('يوسف');
    const { playerId: guestId } = await engine.join(created.code, 'أحمد');

    await engine.setConnected(created.code, guestId, false);
    await expect(engine.start(created.code, hostId)).rejects.toThrow(EngineError);

    await engine.setConnected(created.code, guestId, true);
    const started = await engine.start(created.code, hostId);
    expect(started.phase).toBe('round_intro');
  });

  it('keeps creator as fixed host on leave and disconnect reap when transferHostOnLeave is false', async () => {
    let nowMs = 1_700_000_000_000;
    const store = new MemoryStore();
    const fixedEngine = new MatchEngine(store, content, {
      transferHostOnLeave: false,
      now: () => nowMs,
    });

    const { state: created, playerId: hostId } = await fixedEngine.createRoom('يوسف');
    const { playerId: guestId } = await fixedEngine.join(created.code, 'أحمد');
    await fixedEngine.join(created.code, 'سارة');

    // Mark disconnected + expire grace period -> reapDisconnected preserves original hostId
    await fixedEngine.setConnected(created.code, hostId, false);
    nowMs += DEFAULT_OPTIONS.disconnectGraceMs + 5_000;
    const afterReap = (await fixedEngine.reapDisconnected(created.code, nowMs))!;
    expect(afterReap.hostId).toBe(hostId);
    expect(afterReap.hostId).not.toBe(guestId);

    // Explicit leave in fixed-host mode also does not migrate hostId to a guest
    const store2 = new MemoryStore();
    const fixedEngine2 = new MatchEngine(store2, content, { transferHostOnLeave: false });
    const { state: created2, playerId: host2Id } = await fixedEngine2.createRoom('يوسف');
    const { playerId: guest2Id } = await fixedEngine2.join(created2.code, 'أحمد');
    const afterLeave = (await fixedEngine2.leave(created2.code, host2Id))!;
    expect(afterLeave.hostId).toBe(host2Id);
    expect(afterLeave.hostId).not.toBe(guest2Id);
  });

  it('normalizes configure so patching from focused format to mixed format deletes roundTypeId', async () => {
    const store = new MemoryStore();
    const engine = new MatchEngine(store, content);

    const { state: created, playerId: hostId } = await engine.createRoom('يوسف', {
      format: 'focused',
      roundTypeId: 'mcq_race',
    });
    expect(created.config.format).toBe('focused');
    expect(created.config.roundTypeId).toBe('mcq_race');

    const updated = await engine.configure(created.code, hostId, {
      format: 'mixed',
    });
    expect(updated.config.format).toBe('mixed');
    expect(updated.config.roundTypeId).toBeUndefined();

    // Verify serialized JSON drops roundTypeId completely
    const serialized = JSON.stringify(updated.config);
    expect(serialized).not.toContain('roundTypeId');
  });

  it('advances round immediately when all connected players have acted without waiting for a disconnected player or host', async () => {
    const store = new MemoryStore();
    const engine = new MatchEngine(store, content);

    const { state: created, playerId: hostId } = await engine.createRoom('يوسف', {
      roundCount: 5,
      format: 'focused',
      roundTypeId: 'mcq_race',
    });
    const code = created.code;
    const { playerId: guest1Id } = await engine.join(code, 'أحمد');
    const { playerId: guest2Id } = await engine.join(code, 'سارة');

    await engine.start(code, hostId);
    // Advance from round_intro to in_round
    let state = await engine.skipPhase(code, hostId);
    expect(state.phase).toBe('in_round');
    expect(state.roundNo).toBe(1);

    // Scenario A: Guest 2 switches to another app (disconnects) before answering.
    // Once Host and Guest 1 submit answers, round advances immediately to round_result!
    await engine.setConnected(code, guest2Id, false);
    await engine.submitAction(code, hostId, 1, { kind: 'answer', choice: 0 });
    state = await engine.submitAction(code, guest1Id, 1, { kind: 'answer', choice: 1 });
    expect(state.phase).toBe('round_result');

    // Guest 2 returns and reconnects; advance to Round 2
    await engine.setConnected(code, guest2Id, true);
    await engine.skipPhase(code, hostId); // round_result -> round_intro
    state = await engine.skipPhase(code, hostId); // round_intro -> in_round
    expect(state.phase).toBe('in_round');
    expect(state.roundNo).toBe(2);

    // Scenario B: Guest 1 and Guest 2 answer first, then Host disconnects -> round advances immediately on disconnect!
    await engine.submitAction(code, guest1Id, 2, { kind: 'answer', choice: 0 });
    await engine.submitAction(code, guest2Id, 2, { kind: 'answer', choice: 0 });
    expect((await store.get(code))?.phase).toBe('in_round');

    state = (await engine.setConnected(code, hostId, false))!;
    expect(state.phase).toBe('round_result');
  });
});

