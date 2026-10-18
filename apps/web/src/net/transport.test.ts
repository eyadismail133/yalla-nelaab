import { describe, expect, it } from 'vitest';
import {
  createGameTransport,
  getOrCreateTabSeatId,
  resolveFirebaseConfig,
  validateFirebaseConfig,
} from './transport.js';
import { FirebaseTransport } from './firebase-transport.js';

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

describe('transport factory, tab seat identity, and config validation', () => {
  it('keeps command numbers increasing after a tab closes and accepts only higher server counters', async () => {
    const { ClientSequencer } = await import('./sequence.js');
    const recoveryStorage = createMemoryStorage();
    const original = new ClientSequencer('seat-recovered', { storage: createMemoryStorage(), recoveryStorage });
    original.nextCommandId('seat-recovered');
    original.nextCommandId('seat-recovered');
    const restored = new ClientSequencer('seat-recovered', { storage: createMemoryStorage(), recoveryStorage });
    expect(restored.nextCommandId('seat-recovered').seq).toBe(3);
    restored.advanceTo(7);
    restored.advanceTo(2);
    expect(restored.nextCommandId('seat-recovered').seq).toBe(8);
  });
  it('persists tab seat identifier in sessionStorage across refresh while giving new tabs distinct seat IDs', () => {
    const tabAStorage = createMemoryStorage();
    const tabBStorage = createMemoryStorage();

    const seatA1 = getOrCreateTabSeatId(tabAStorage);
    const seatA2 = getOrCreateTabSeatId(tabAStorage);
    const seatB = getOrCreateTabSeatId(tabBStorage);

    expect(seatA1.length).toBeGreaterThanOrEqual(8);
    expect(seatA1).toBe(seatA2);
    expect(seatB).not.toBe(seatA1);
  });

  it('validates Firebase config and detects missing or invalid values clearly', () => {
    const valid = resolveFirebaseConfig();
    expect(validateFirebaseConfig(valid).ok).toBe(true);
    expect(valid.projectId).toBe('yalla-nelaab-20261016');

    const invalid = validateFirebaseConfig({
      apiKey: '',
      authDomain: '',
      databaseURL: 'not-a-url',
      projectId: '',
      appId: '',
    });
    expect(invalid.ok).toBe(false);
  });

  it('fails clearly without hanging when FirebaseTransport is given missing or invalid config', async () => {
    const transport = new FirebaseTransport({
      config: {
        apiKey: '',
        authDomain: '',
        databaseURL: 'invalid-url',
        projectId: '',
        appId: '',
      },
      seatId: 'test-invalid-config',
    });

    const states: boolean[] = [];
    const unsub = transport.onConnectionChange((connected) => states.push(connected));

    const createRes = await transport.createRoom('يوسف');
    expect(createRes.ok).toBe(false);
    if (!createRes.ok) {
      expect(createRes.error.length).toBeGreaterThan(0);
    }

    const joinRes = await transport.joinRoom('ABCDE', 'أحمد');
    expect(joinRes.ok).toBe(false);

    const resumeRes = await transport.resume('ABCDE', 'token-12345678');
    expect(resumeRes.ok).toBe(false);

    const offset = await transport.syncClock();
    expect(typeof offset).toBe('number');
    expect(states).toContain(false);

    unsub();
    transport.dispose();
  });

  it('creates FirebaseTransport when explicitly requested and disposes cleanly', () => {
    const transport = createGameTransport({
      transport: 'firebase',
      firebaseConfig: {
        apiKey: '',
        authDomain: '',
        databaseURL: '',
        projectId: '',
        appId: '',
      },
      seatId: 'factory-test-seat',
    });

    expect(typeof transport.createRoom).toBe('function');
    expect(typeof transport.joinRoom).toBe('function');
    expect(typeof transport.setReady).toBe('function');
    expect(typeof transport.dispose).toBe('function');
    expect(typeof transport.retryConnection).toBe('function');

    transport.dispose();
  });

  it('detects cloned tab seat ownership via BroadcastChannel and assigns a fresh seat while clearing session', async () => {
    const listenersA = new Set<(event: MessageEvent<any>) => void>();
    const listenersB = new Set<(event: MessageEvent<any>) => void>();

    const channelA: any = {
      addEventListener: (_type: string, fn: any) => listenersA.add(fn),
      removeEventListener: (_type: string, fn: any) => listenersA.delete(fn),
      postMessage: (data: any) => {
        // Dispatch to other channel
        for (const fn of listenersB) fn({ data } as any);
      },
      close: () => listenersA.clear(),
    };

    const channelB: any = {
      addEventListener: (_type: string, fn: any) => listenersB.add(fn),
      removeEventListener: (_type: string, fn: any) => listenersB.delete(fn),
      postMessage: (data: any) => {
        // Dispatch to other channel
        for (const fn of listenersA) fn({ data } as any);
      },
      close: () => listenersB.clear(),
    };

    const storageA = createMemoryStorage();
    const { TabSeatManager, TAB_SEAT_STORAGE_KEY } = await import('./seat.js');

    // Tab A initializes seat
    const managerA = new TabSeatManager({ storage: storageA, channel: channelA, probeTimeoutMs: 20 });
    const seatA = await managerA.resolveSeatId();

    // Tab B is a duplicate tab: copies storageA into storageB
    const storageB = createMemoryStorage();
    storageB.setItem(TAB_SEAT_STORAGE_KEY, seatA);

    let clonedDetected = false;
    const managerB = new TabSeatManager({
      storage: storageB,
      channel: channelB,
      probeTimeoutMs: 50,
      onClonedDetected: () => {
        clonedDetected = true;
      },
    });

    const seatB = await managerB.resolveSeatId();

    // Tab B detected concurrent seat ownership!
    expect(clonedDetected).toBe(true);
    expect(seatB).not.toBe(seatA);
    expect(seatB.length).toBeGreaterThanOrEqual(8);

    managerA.dispose();
    managerB.dispose();
  });

  it('enforces monotonic client sequencing and host deduplication replay vs stale rejection', async () => {
    const { ClientSequencer, HostDedupTracker, parseCommandId } = await import('./sequence.js');
    const storage = createMemoryStorage();
    const sequencer = new ClientSequencer('seat-1', { storage });

    const c1 = sequencer.nextCommandId('seat-1');
    const c2 = sequencer.nextCommandId('seat-1');
    expect(c1.seq).toBe(1);
    expect(c2.seq).toBe(2);
    expect(parseCommandId(c1.commandId)?.seq).toBe(1);
    expect(parseCommandId(c2.commandId)?.seq).toBe(2);

    const tracker = new HostDedupTracker();
    const uid = 'uid-player-1';

    // First command: execute
    const eval1 = tracker.evaluate(uid, c1.commandId);
    expect(eval1.action).toBe('execute');
    tracker.recordAck(uid, c1.commandId, 1, { ok: true, data: { score: 10 } });

    // Repeated identical command: replay previous ack without re-executing
    const replayEval = tracker.evaluate(uid, c1.commandId);
    expect(replayEval.action).toBe('replay');
    if (replayEval.action === 'replay') {
      expect(replayEval.ack.ok).toBe(true);
      expect((replayEval.ack as any).data.score).toBe(10);
    }

    // Sequence 2: execute
    const eval2 = tracker.evaluate(uid, c2.commandId);
    expect(eval2.action).toBe('execute');
    tracker.recordAck(uid, c2.commandId, 2, { ok: true, data: { score: 20 } });

    // Older sequence 1 repeated after sequence 2 committed: rejected as stale!
    const staleEval = tracker.evaluate(uid, c1.commandId);
    expect(staleEval.action).toBe('reject');
  });
});
