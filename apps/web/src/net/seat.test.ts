import { nanoid } from 'nanoid';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSession, saveSession } from './client.js';
import { TabSeatManager, TAB_SEAT_STORAGE_KEY } from './seat.js';

const SEAT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function createMemoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem(key: string): string | null {
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      map.set(key, String(value));
    },
    removeItem(key: string): void {
      map.delete(key);
    },
    clear(): void {
      map.clear();
    },
    get length(): number {
      return map.size;
    },
    key(index: number): string | null {
      return [...map.keys()][index] ?? null;
    },
  };
}

const originalWindow = (globalThis as any).window;

function setMockWindowSessionStorage(storage: Storage): void {
  (globalThis as any).window = {
    sessionStorage: storage,
  };
}

function restoreWindow(): void {
  if (originalWindow !== undefined) {
    (globalThis as any).window = originalWindow;
  } else {
    delete (globalThis as any).window;
  }
}

describe('TabSeatManager regression tests', () => {
  const openChannels: BroadcastChannel[] = [];

  function makeChannel(name: string): BroadcastChannel {
    const channel = new BroadcastChannel(name);
    openChannels.push(channel);
    return channel;
  }

  afterEach(() => {
    restoreWindow();
    for (const ch of openChannels) {
      try {
        ch.close();
      } catch {
        // Ignore channel close errors
      }
    }
    openChannels.length = 0;
  });

  it('keeps active defender seat while cloned tab resolves new seat and clears inherited room session', async () => {
    const channelName = `seat-test-clone-${nanoid(8)}`;

    // Tab 1 (defender): fresh tab initialization
    const defenderStorage = createMemoryStorage();
    setMockWindowSessionStorage(defenderStorage);
    saveSession({ code: 'ROOMA', playerId: 'host-1', token: 'tok-1' });

    const defenderChannel = makeChannel(channelName);
    const defender = new TabSeatManager({
      storage: defenderStorage,
      channel: defenderChannel,
      probeTimeoutMs: 50,
    });

    const defenderSeatId = await defender.resolveSeatId();
    expect(defenderSeatId).toMatch(SEAT_ID_PATTERN);
    expect(defenderStorage.getItem(TAB_SEAT_STORAGE_KEY)).toBe(defenderSeatId);
    expect(loadSession()).toEqual({ code: 'ROOMA', playerId: 'host-1', token: 'tok-1' });

    // Tab 2 (clone): browser duplicated tab copies sessionStorage verbatim
    const clonedStorage = createMemoryStorage({
      [TAB_SEAT_STORAGE_KEY]: defenderSeatId,
      'party-game-session': JSON.stringify({ code: 'ROOMA', playerId: 'host-1', token: 'tok-1' }),
    });

    // Provide cloned tab's sessionStorage to window.sessionStorage (client.ts store() uses window.sessionStorage)
    setMockWindowSessionStorage(clonedStorage);
    expect(loadSession()).toEqual({ code: 'ROOMA', playerId: 'host-1', token: 'tok-1' });

    let clonedCallbackInvoked = false;
    const clonedChannel = makeChannel(channelName);
    const clonedManager = new TabSeatManager({
      storage: clonedStorage,
      channel: clonedChannel,
      probeTimeoutMs: 50,
      onClonedDetected: () => {
        clonedCallbackInvoked = true;
      },
    });

    const clonedSeatId = await clonedManager.resolveSeatId();

    // 1. Defender keeps its seat and original storage intact
    expect(defender.getSeatIdSync()).toBe(defenderSeatId);
    expect(defenderStorage.getItem(TAB_SEAT_STORAGE_KEY)).toBe(defenderSeatId);
    expect(defenderStorage.getItem('party-game-session')).toBe(
      JSON.stringify({ code: 'ROOMA', playerId: 'host-1', token: 'tok-1' }),
    );

    // 2. Clone detected and resolved to a distinct seat
    expect(clonedCallbackInvoked).toBe(true);
    expect(clonedSeatId).not.toBe(defenderSeatId);
    expect(clonedSeatId).toMatch(SEAT_ID_PATTERN);
    expect(clonedStorage.getItem(TAB_SEAT_STORAGE_KEY)).toBe(clonedSeatId);

    // 3. Inherited room session in cloned page's window.sessionStorage is cleared
    expect(clonedStorage.getItem('party-game-session')).toBeNull();
    expect(loadSession()).toBeNull();

    defender.dispose();
    clonedManager.dispose();
  });

  it('preserves seat identity and room session on tab refresh when original manager is disposed', async () => {
    const channelName = `seat-test-refresh-${nanoid(8)}`;
    const tabStorage = createMemoryStorage();
    setMockWindowSessionStorage(tabStorage);
    saveSession({ code: 'REFRESH1', playerId: 'guest-9', token: 'tok-9' });

    // Initial page load
    const initialChannel = makeChannel(channelName);
    const initialManager = new TabSeatManager({
      storage: tabStorage,
      channel: initialChannel,
      probeTimeoutMs: 50,
    });

    const originalSeatId = await initialManager.resolveSeatId();
    expect(originalSeatId).toMatch(SEAT_ID_PATTERN);
    expect(tabStorage.getItem(TAB_SEAT_STORAGE_KEY)).toBe(originalSeatId);

    // Tab refreshes: page unloads, disposing manager and closing channel, but keeping sessionStorage
    initialManager.dispose();

    // Recreated manager on page reload with same storage
    let cloneDetected = false;
    const refreshedChannel = makeChannel(channelName);
    const refreshedManager = new TabSeatManager({
      storage: tabStorage,
      channel: refreshedChannel,
      probeTimeoutMs: 50,
      onClonedDetected: () => {
        cloneDetected = true;
      },
    });

    const refreshedSeatId = await refreshedManager.resolveSeatId();

    // Seat identity is preserved on refresh without false clone detection
    expect(cloneDetected).toBe(false);
    expect(refreshedSeatId).toBe(originalSeatId);
    expect(tabStorage.getItem(TAB_SEAT_STORAGE_KEY)).toBe(originalSeatId);
    expect(loadSession()).toEqual({ code: 'REFRESH1', playerId: 'guest-9', token: 'tok-9' });

    refreshedManager.dispose();
  });

  it('settles simultaneous probes of the same candidate on distinct identities with exactly one original owner', async () => {
    const channelName = `seat-test-simultaneous-${nanoid(8)}`;
    const candidateSeatId = 'candidate-seat-12345678';

    const storageA = createMemoryStorage({ [TAB_SEAT_STORAGE_KEY]: candidateSeatId });
    const storageB = createMemoryStorage({ [TAB_SEAT_STORAGE_KEY]: candidateSeatId });

    let cloneDetectedA = false;
    let cloneDetectedB = false;

    const channelA = makeChannel(channelName);
    const channelB = makeChannel(channelName);

    const managerA = new TabSeatManager({
      storage: storageA,
      channel: channelA,
      probeTimeoutMs: 100,
      onClonedDetected: () => {
        cloneDetectedA = true;
      },
    });

    const managerB = new TabSeatManager({
      storage: storageB,
      channel: channelB,
      probeTimeoutMs: 100,
      onClonedDetected: () => {
        cloneDetectedB = true;
      },
    });

    // Launch simultaneous probes
    const [seatA, seatB] = await Promise.all([
      managerA.resolveSeatId(),
      managerB.resolveSeatId(),
    ]);

    // Both settled on distinct identities
    expect(seatA).not.toBe(seatB);
    expect(seatA).toMatch(SEAT_ID_PATTERN);
    expect(seatB).toMatch(SEAT_ID_PATTERN);

    // Exactly one retains the original candidate, and exactly one yields as clone
    const aKeptCandidate = seatA === candidateSeatId;
    const bKeptCandidate = seatB === candidateSeatId;

    expect(aKeptCandidate !== bKeptCandidate).toBe(true);
    if (aKeptCandidate) {
      expect(cloneDetectedA).toBe(false);
      expect(cloneDetectedB).toBe(true);
      expect(storageA.getItem(TAB_SEAT_STORAGE_KEY)).toBe(candidateSeatId);
      expect(storageB.getItem(TAB_SEAT_STORAGE_KEY)).toBe(seatB);
    } else {
      expect(cloneDetectedA).toBe(true);
      expect(cloneDetectedB).toBe(false);
      expect(storageA.getItem(TAB_SEAT_STORAGE_KEY)).toBe(seatA);
      expect(storageB.getItem(TAB_SEAT_STORAGE_KEY)).toBe(candidateSeatId);
    }

    managerA.dispose();
    managerB.dispose();
  });

  it('assigns distinct seat IDs to independent fresh tabs without existing storage', async () => {
    const channelName = `seat-test-fresh-${nanoid(8)}`;
    const storage1 = createMemoryStorage();
    const storage2 = createMemoryStorage();

    const channel1 = makeChannel(channelName);
    const channel2 = makeChannel(channelName);

    const manager1 = new TabSeatManager({
      storage: storage1,
      channel: channel1,
      probeTimeoutMs: 50,
    });
    const manager2 = new TabSeatManager({
      storage: storage2,
      channel: channel2,
      probeTimeoutMs: 50,
    });

    const seatId1 = await manager1.resolveSeatId();
    const seatId2 = await manager2.resolveSeatId();

    expect(seatId1).toMatch(SEAT_ID_PATTERN);
    expect(seatId2).toMatch(SEAT_ID_PATTERN);
    expect(seatId1).not.toBe(seatId2);

    expect(storage1.getItem(TAB_SEAT_STORAGE_KEY)).toBe(seatId1);
    expect(storage2.getItem(TAB_SEAT_STORAGE_KEY)).toBe(seatId2);

    manager1.dispose();
    manager2.dispose();
  });

  it('removes channel listener resources on disposal and stops defending seat', async () => {
    const channelName = `seat-test-dispose-${nanoid(8)}`;
    const storage1 = createMemoryStorage();
    const channel1 = makeChannel(channelName);

    const manager1 = new TabSeatManager({
      storage: storage1,
      channel: channel1,
      probeTimeoutMs: 50,
    });

    const seatId1 = await manager1.resolveSeatId();
    expect(seatId1).toMatch(SEAT_ID_PATTERN);

    // Dispose manager1: closes channel and removes defending listener
    manager1.dispose();

    // A second manager with the same candidate probes on the channel
    const storage2 = createMemoryStorage({ [TAB_SEAT_STORAGE_KEY]: seatId1 });
    let cloneDetected = false;
    const channel2 = makeChannel(channelName);
    const manager2 = new TabSeatManager({
      storage: storage2,
      channel: channel2,
      probeTimeoutMs: 50,
      onClonedDetected: () => {
        cloneDetected = true;
      },
    });

    // Because manager1 was disposed and closed, nobody defends seatId1 -> manager2 claims it without clone detection
    const seatId2 = await manager2.resolveSeatId();
    expect(cloneDetected).toBe(false);
    expect(seatId2).toBe(seatId1);

    manager2.dispose();
  });

  it('supports synchronous fallback via getSeatIdSync without bypassing async validation', async () => {
    const candidate = 'existing-valid-seat-12345';
    const storage = createMemoryStorage({ [TAB_SEAT_STORAGE_KEY]: candidate });
    const manager = new TabSeatManager({ storage, channel: null });

    // Before async resolve: returns valid candidate from storage
    expect(manager.getSeatIdSync()).toBe(candidate);

    // After async resolve: returns resolved seat ID
    const resolved = await manager.resolveSeatId();
    expect(resolved).toBe(candidate);
    expect(manager.getSeatIdSync()).toBe(candidate);

    manager.dispose();
  });

  it('rejects malformed candidate in storage during sync and async resolution', async () => {
    const malformed = 'short'; // < 8 characters, violates SEAT_ID_PATTERN
    const storage = createMemoryStorage({ [TAB_SEAT_STORAGE_KEY]: malformed });
    const manager = new TabSeatManager({ storage, channel: null });

    // getSeatIdSync ignores malformed candidate and generates fresh valid ID
    const syncId = manager.getSeatIdSync();
    expect(syncId).not.toBe(malformed);
    expect(syncId).toMatch(SEAT_ID_PATTERN);

    // resolveSeatId generates fresh valid ID and updates storage
    const resolved = await manager.resolveSeatId();
    expect(resolved).not.toBe(malformed);
    expect(resolved).toMatch(SEAT_ID_PATTERN);
    expect(storage.getItem(TAB_SEAT_STORAGE_KEY)).toBe(resolved);

    manager.dispose();
  });

  it('does not open default BroadcastChannel during TabSeatManager construction before resolveSeatId or defender startup', () => {
    let openedChannels = 0;
    const OriginalBroadcastChannel = globalThis.BroadcastChannel;

    class CountingBroadcastChannel extends OriginalBroadcastChannel {
      constructor(name: string) {
        super(name);
        openedChannels += 1;
      }
    }

    (globalThis as any).BroadcastChannel = CountingBroadcastChannel;

    let manager: TabSeatManager | null = null;
    try {
      const storage = createMemoryStorage();
      manager = new TabSeatManager({ storage });
      expect(openedChannels).toBe(0);
    } finally {
      if (manager) {
        manager.dispose();
      }
      (globalThis as any).BroadcastChannel = OriginalBroadcastChannel;
    }
  });
});

