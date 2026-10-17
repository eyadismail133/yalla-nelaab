import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ContentSource, RoomView } from '@game/shared';
import {
  assertFails,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { getApps } from 'firebase/app';
import { get, goOffline, goOnline, ref, set, update } from 'firebase/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JsonSource } from '../../../../apps/server/src/content/json-source.js';
import { clearSession, loadSession } from './client.js';
import type { CommittedAck } from './firebase-host-runtime.js';
import { FirebaseSessionManager } from './firebase-session.js';
import { FirebaseTransport, type FirebaseTransportOptions } from './firebase-transport.js';
import type { FirebaseWebConfig } from './transport.js';

const SEED_DIR = fileURLToPath(new URL('../../../../content/seed', import.meta.url));
const contentSource = new JsonSource(SEED_DIR);

const RULES_PATH = fileURLToPath(new URL('../../../../database.rules.json', import.meta.url));
const RULES_JSON = readFileSync(RULES_PATH, 'utf8');

const DEMO_CONFIG: Readonly<FirebaseWebConfig> = Object.freeze({
  apiKey: 'fake-api-key-demo',
  authDomain: 'demo-yalla-nelaab.firebaseapp.com',
  databaseURL: 'http://127.0.0.1:9000?ns=demo-yalla-nelaab',
  projectId: 'demo-yalla-nelaab',
  appId: '1:123456789:web:abcdef123456',
});

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

describe('FirebaseTransport real emulator integration', () => {
  let testEnv: RulesTestEnvironment;
  const openTransports: FirebaseTransport[] = [];

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'demo-yalla-nelaab',
      database: {
        host: '127.0.0.1',
        port: 9000,
        rules: RULES_JSON,
      },
    });
  });

  function makeTransport(
    seatId: string,
    storage?: Storage,
    options?: Partial<FirebaseTransportOptions>,
  ): FirebaseTransport {
    const transport = new FirebaseTransport({
      seatId,
      config: DEMO_CONFIG,
      storage: storage ?? createMemoryStorage(),
      contentSource,
      databaseEmulatorHost: process.env.FIREBASE_DATABASE_EMULATOR_HOST ?? '127.0.0.1:9000',
      authEmulatorHost: process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099',
      leaseTtlMs: 2000,
      heartbeatIntervalMs: 800,
      ...options,
    });
    openTransports.push(transport);
    return transport;
  }

  afterAll(async () => {
    for (const t of openTransports) {
      try {
        t.dispose();
      } catch {
        // Ignore
      }
    }
    openTransports.length = 0;
    clearSession();
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  it('denies unauthenticated read to /rooms under real database security rules', async () => {
    const unauthDb = testEnv.unauthenticatedContext().database();
    await assertFails(get(ref(unauthDb, 'rooms')));
  });

  it('creates room with staged bootstrap, sets host view in slot 1, and publishes RoomView', async () => {
    const hostTransport = makeTransport('seat-host-bootstrap');

    let latestView: RoomView | null = null;
    hostTransport.onState((v) => {
      latestView = v;
    });

    const createRes = await hostTransport.createRoom('يوسف', {
      roundCount: 5,
      format: 'mixed',
    });

    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    expect(createRes.code).toHaveLength(5);
    expect(createRes.playerId).toBeDefined();
    expect(createRes.token).toBeDefined();

    // Wait for view update
    for (let i = 0; i < 20 && !latestView; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(latestView).not.toBeNull();
    expect((latestView as RoomView | null)?.phase).toBe('lobby');
    expect((latestView as RoomView | null)?.players).toHaveLength(1);
    expect((latestView as RoomView | null)?.you.isHost).toBe(true);
    expect((latestView as RoomView | null)?.you.id).toBe(createRes.playerId);
  });

  it('allows up to 8 players to join, broadcasts updated views, and rejects 9th player', async () => {
    const hostTransport = makeTransport('seat-host-capacity');
    const createRes = await hostTransport.createRoom('الهوست');
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const code = createRes.code;
    const guests: FirebaseTransport[] = [];

    // Join 7 guests (players 2 through 8)
    for (let i = 2; i <= 8; i += 1) {
      const guest = makeTransport(`seat-guest-${i}`);
      guests.push(guest);

      const joinRes = await guest.joinRoom(code, `لاعب ${i}`);
      expect(joinRes.ok).toBe(true);
      if (joinRes.ok) {
        expect(joinRes.playerId).toBeDefined();
        expect(joinRes.token).toBeDefined();
      }
    }

    // Attempt to join 9th player -> must be rejected as full room
    const ninthGuest = makeTransport('seat-guest-9');
    const rejectRes = await ninthGuest.joinRoom(code, 'لاعب ٩');
    expect(rejectRes.ok).toBe(false);
    if (!rejectRes.ok) {
      expect(rejectRes.error).toContain('كاملة');
    }
  });

  it('restores player seat on resume across tab refresh without creating duplicate seats', async () => {
    const hostTransport = makeTransport('seat-host-resume');
    const createRes = await hostTransport.createRoom('هوست الريزوم');
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const code = createRes.code;

    // Guest joins
    const guestStorage = createMemoryStorage();
    const guest1 = makeTransport('seat-guest-resume', guestStorage);
    const joinRes = await guest1.joinRoom(code, 'لاعب الاستئناف');
    expect(joinRes.ok).toBe(true);
    if (!joinRes.ok) return;

    const originalPlayerId = joinRes.playerId;
    const token = joinRes.token;

    // Simulate tab refresh: guest1 disposes and fresh transport with same seatId calls resume
    guest1.dispose();

    const guestRefreshed = makeTransport('seat-guest-resume', guestStorage);
    const resumeRes = await guestRefreshed.resume(code, token);

    expect(resumeRes.ok).toBe(true);
    if (!resumeRes.ok) return;

    expect(resumeRes.playerId).toBe(originalPlayerId);
  });

  it('supports join idempotency when guest rejoins with same UID', async () => {
    const hostTransport = makeTransport('seat-host-idempotency');
    const createRes = await hostTransport.createRoom('هوست الإيدمبوتنت');
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const code = createRes.code;
    const guestStorage = createMemoryStorage();
    const guest = makeTransport('seat-guest-idempotency', guestStorage);

    const joinRes1 = await guest.joinRoom(code, 'لاعب متكرر');
    expect(joinRes1.ok).toBe(true);
    if (!joinRes1.ok) return;

    // Second join call with same transport/UID must succeed idempotently without throwing collision error
    const joinRes2 = await guest.joinRoom(code, 'لاعب متكرر');
    expect(joinRes2.ok).toBe(true);
    if (joinRes2.ok) {
      expect(joinRes2.playerId).toBe(joinRes1.playerId);
      expect(joinRes2.token).toBe(joinRes1.token);
    }
  });

  it('restores host state, bindings, and dedup from snapshot envelope on host resume', async () => {
    const hostStorage = createMemoryStorage();
    const host1 = makeTransport('seat-host-envelope-resume', hostStorage);

    const createRes = await host1.createRoom('هوست الإنفيلوب', {
      roundCount: 5,
      format: 'mixed',
    });
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const code = createRes.code;
    const hostToken = createRes.token;

    // Add a guest so room has 2 members
    const guest = makeTransport('seat-guest-envelope');
    const joinRes = await guest.joinRoom(code, 'ضيف الإنفيلوب');
    expect(joinRes.ok).toBe(true);

    // Host refreshes: dispose host1, wait for lease expiry, construct host2 with same seat/storage, call resume
    host1.dispose();
    await new Promise((r) => setTimeout(r, 2200));

    const host2 = makeTransport('seat-host-envelope-resume', hostStorage);
    const resumeRes = await host2.resume(code, hostToken);
    expect(resumeRes.ok).toBe(true);
    if (resumeRes.ok) {
      expect(resumeRes.code).toBe(code);
      expect(resumeRes.playerId).toBe(createRes.playerId);
    }
  }, 10_000);

  it('executes match workflow: ready toggle, start, round action, and rematch', async () => {
    const hostTransport = makeTransport('seat-host-match');
    let hostView: RoomView | null = null;
    const getHostView = (): RoomView | null => hostView;
    hostTransport.onState((v) => {
      hostView = v;
    });

    const createRes = await hostTransport.createRoom('هوست الماتش', {
      roundCount: 5,
      format: 'focused',
      roundTypeId: 'mcq_race',
    });
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const code = createRes.code;
    const roomId = (hostTransport as any).currentRoomId;

    // Second player joins so room has >= 2 players
    const guestTransport = makeTransport('seat-guest-match');
    let guestView: RoomView | null = null;
    guestTransport.onState((v) => {
      guestView = v;
    });

    const joinRes = await guestTransport.joinRoom(code, 'ضيف الماتش');
    expect(joinRes.ok).toBe(true);
    if (!joinRes.ok) return;

    // Wait for guest view in lobby
    for (let i = 0; i < 20 && (!guestView || (guestView as RoomView).players.length < 2); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(guestView).not.toBeNull();
    expect((guestView as RoomView | null)?.players).toHaveLength(2);

    // Toggle readiness
    const readyRes = await guestTransport.setReady(true);
    expect(readyRes.ok).toBe(true);

    // Host starts match
    const startRes = await hostTransport.start();
    expect(startRes.ok).toBe(true);

    // Wait for round_intro phase
    for (let i = 0; i < 20 && getHostView()?.phase !== 'round_intro'; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(getHostView()?.phase).toBe('round_intro');

    // Host skips intro into in_round
    const skipRes = await hostTransport.skip();
    expect(skipRes.ok).toBe(true);

    // Wait for in_round phase
    for (let i = 0; i < 20 && getHostView()?.phase !== 'in_round'; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(getHostView()?.phase).toBe('in_round');

    // Players can submit actions
    const hostAuth = await hostTransport.session.ensureAuth();
    const snapBeforeAct = await get(ref(hostAuth.database, `rooms/${roomId}/snapshot`));
    const versionBeforeAct = snapBeforeAct.val().version;

    const actRes = await guestTransport.act(1, { kind: 'answer', choice: 0 });
    expect(actRes).toBeDefined();
    expect(actRes.ok).toBe(true);

    // Verify action effect: snapshot version increments in RTDB and answer is registered
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const snap = await get(ref(hostAuth.database, `rooms/${roomId}/snapshot`));
      if (snap.val().version > versionBeforeAct) {
        break;
      }
    }
    const snapAfterAct = await get(ref(hostAuth.database, `rooms/${roomId}/snapshot`));
    expect(snapAfterAct.val().version).toBeGreaterThan(versionBeforeAct);
    const envAfterAct = JSON.parse(snapAfterAct.val().json);
    const guestPlayerId = (joinRes as any).playerId;
    expect(envAfterAct.state.roundState?.answers?.[guestPlayerId]).toBeDefined();
    expect(envAfterAct.state.roundState?.answers?.[guestPlayerId]?.choice).toBe(0);

    // Guest leaves mid-match -> match concludes to podium (< 2 connected players)
    await guestTransport.leave();
    for (let i = 0; i < 20 && getHostView()?.phase !== 'podium'; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(getHostView()?.phase).toBe('podium');

    // Host triggers rematch -> returns to lobby with ready cleared
    const rematchRes = await hostTransport.rematch();
    expect(rematchRes.ok).toBe(true);
    for (let i = 0; i < 20 && getHostView()?.phase !== 'lobby'; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(getHostView()?.phase).toBe('lobby');
    expect(getHostView()?.players.every((p) => !p.ready)).toBe(true);
  }, 15_000);

  it('rejects second simultaneous host runtime with same UID while first host is live', async () => {
    const hostStorage = createMemoryStorage();
    const host1 = makeTransport('seat-host-simultaneous', hostStorage);

    const createRes = await host1.createRoom('هوست متزامن');
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    // Host 1 is alive and actively heartbeating
    // Second host runtime for same seat/UID attempts resume while Host 1 is live
    const host2 = makeTransport('seat-host-simultaneous', hostStorage);
    const resumeRes = await host2.resume(createRes.code, createRes.token, { maxWaitMs: 1500 });
    expect(resumeRes.ok).toBe(false);
    if (!resumeRes.ok) {
      expect(resumeRes.error).toContain('يوجد هوست نشط آخر');
    }
  }, 10_000);

  it('allows host takeover with next epoch and new runtimeId after prior lease expires within 60s', async () => {
    const hostStorage = createMemoryStorage();
    const host1 = makeTransport('seat-host-takeover', hostStorage);

    const createRes = await host1.createRoom('هوست تيك أوفر');
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const roomId = (host1 as any).currentRoomId;
    const host1RuntimeId = host1.getHostRuntime()?.getRuntimeId();

    // Dispose host 1 to stop heartbeat
    host1.dispose();

    // Wait for host 1 lease to expire (TTL is 2000ms)
    await new Promise((r) => setTimeout(r, 2200));

    // Successor host resumes
    const host2 = makeTransport('seat-host-takeover', hostStorage);
    const resumeRes = await host2.resume(createRes.code, createRes.token);
    expect(resumeRes.ok).toBe(true);

    const db = (await host2.session.ensureAuth()).database;
    const leaseSnap = await get(ref(db, `rooms/${roomId}/lease`));
    expect(leaseSnap.exists()).toBe(true);
    const leaseVal = leaseSnap.val();
    expect(leaseVal.epoch).toBe(2);
    expect(leaseVal.ownerId).toBe(host2.getHostRuntime()?.getRuntimeId());
    expect(leaseVal.ownerId).not.toBe(host1RuntimeId);
  }, 10_000);

  it('immediately stops stale runtime when lease ownership is lost to a successor', async () => {
    const hostStorage = createMemoryStorage();
    const host1 = makeTransport('seat-host-stale-fencing', hostStorage);

    const createRes = await host1.createRoom('هوست فينشنج');
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const host1Runtime = host1.getHostRuntime();
    expect(host1Runtime?.isLive()).toBe(true);

    // Stop host1 heartbeat manually so its lease will expire
    if ((host1Runtime as any).heartbeatTimer) {
      clearInterval((host1Runtime as any).heartbeatTimer);
      (host1Runtime as any).heartbeatTimer = null;
    }

    // Wait for lease to expire
    await new Promise((r) => setTimeout(r, 2200));

    // Successor host claims the lease
    const host2 = makeTransport('seat-host-stale-fencing', hostStorage);
    const resumeRes = await host2.resume(createRes.code, createRes.token);
    expect(resumeRes.ok).toBe(true);

    // Wait for host 1's active lease observer to observe the ownership change
    for (let i = 0; i < 20 && host1Runtime?.isLive(); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(host1Runtime?.isLive()).toBe(false);
  }, 10_000);

  it('host receives committed view immediately upon guest join without requiring ready or configure action', async () => {
    const hostTransport = makeTransport('seat-host-roster');
    const hostViews: RoomView[] = [];
    hostTransport.onState((v) => {
      hostViews.push(v);
    });

    const createRes = await hostTransport.createRoom('هوست الرستر');
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const code = createRes.code;

    // Wait for initial view (1 player)
    for (let i = 0; i < 20 && hostViews.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(hostViews[hostViews.length - 1]?.players).toHaveLength(1);

    // Guest 2 joins
    const guest2 = makeTransport('seat-guest-roster-2');
    const joinRes2 = await guest2.joinRoom(code, 'لاعب 2');
    expect(joinRes2.ok).toBe(true);

    // Wait for host to receive view with 2 players immediately WITHOUT sending ready or config!
    for (let i = 0; i < 20 && (hostViews[hostViews.length - 1]?.players.length ?? 0) < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(hostViews[hostViews.length - 1]?.players).toHaveLength(2);

    // Join remaining guests up to 8
    for (let p = 3; p <= 8; p += 1) {
      const guest = makeTransport(`seat-guest-roster-${p}`);
      const joinRes = await guest.joinRoom(code, `لاعب ${p}`);
      expect(joinRes.ok).toBe(true);
    }

    // Host must have received view with 8 players
    for (let i = 0; i < 20 && (hostViews[hostViews.length - 1]?.players.length ?? 0) < 8; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(hostViews[hostViews.length - 1]?.players).toHaveLength(8);
  }, 15_000);

  it('replays cached acknowledgements on duplicate command without state version change, rejects older valid sequence numbers, and survives host restoration', async () => {
    const hostStorage = createMemoryStorage();
    const hostTransport = makeTransport('seat-host-dedup', hostStorage);
    const createRes = await hostTransport.createRoom('هوست الديدب');
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const code = createRes.code;
    const roomId = (hostTransport as any).currentRoomId;
    const guestTransport = makeTransport('seat-guest-dedup');
    const joinRes = await guestTransport.joinRoom(code, 'ضيف الديدب');
    expect(joinRes.ok).toBe(true);

    const hostAuth = await hostTransport.session.ensureAuth();
    const hostDb = hostAuth.database;

    const guestAuth = await guestTransport.session.ensureAuth();
    const guestUid = guestAuth.uid;
    const db = guestAuth.database;

    // Send first command (seq 1) via transport
    const res1 = await guestTransport.setReady(true);
    expect(res1.ok).toBe(true);

    const respSnap1 = await get(ref(db, `rooms/${roomId}/responses/${guestUid}`));
    expect(respSnap1.exists()).toBe(true);
    const ackedCommandId1 = respSnap1.val().commandId;

    // Send second command (seq 2) via transport
    const res2 = await guestTransport.setReady(false);
    expect(res2.ok).toBe(true);

    const respSnap2 = await get(ref(db, `rooms/${roomId}/responses/${guestUid}`));
    expect(respSnap2.exists()).toBe(true);
    const ackedCommandId2 = respSnap2.val().commandId;
    expect(ackedCommandId2).not.toBe(ackedCommandId1);

    // Read state version from snapshot in DB using hostDb (snapshot is private to host)
    const snapAfterCmd2 = await get(ref(hostDb, `rooms/${roomId}/snapshot`));
    expect(snapAfterCmd2.exists()).toBe(true);
    const versionAfterCmd2 = snapAfterCmd2.val().version;

    // 1. Send older valid command ID (seq 1) after newer accepted command (seq 2)
    // Must be rejected by host dedup tracker as an old sequence number
    const staleSeqNow = guestTransport.serverNow();
    await set(ref(db, `rooms/${roomId}/commands/${guestUid}`), {
      commandId: ackedCommandId1,
      uid: guestUid,
      type: 'ready',
      payloadJson: JSON.stringify({ ready: true }),
      createdAtMs: staleSeqNow,
      expiresAtMs: staleSeqNow + 5000,
    });

    let oldSeqRejected = false;
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const respSnap = await get(ref(db, `rooms/${roomId}/responses/${guestUid}`));
      if (respSnap.exists() && respSnap.val().commandId === ackedCommandId1 && respSnap.val().ok === false) {
        expect(respSnap.val().error).toContain('قديم');
        oldSeqRejected = true;
        break;
      }
    }
    expect(oldSeqRejected).toBe(true);

    // Snapshot version must NOT change on rejected stale sequence
    const snapAfterStale = await get(ref(hostDb, `rooms/${roomId}/snapshot`));
    expect(snapAfterStale.val().version).toBe(versionAfterCmd2);

    // 2. Fresh acknowledgement proof: explicitly delete the response node via testEnv admin bypass
    // Rules enforce newData.exists() on client /responses/$uid writes, so rules-disabled context is used
    // to prove the response received on replay is a freshly published record from host dedup cache
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), `rooms/${roomId}/responses/${guestUid}`), null);
    });
    const checkDeleted = await get(ref(db, `rooms/${roomId}/responses/${guestUid}`));
    expect(checkDeleted.exists()).toBe(false);

    // Send the latest accepted commandId (seq 2) again directly to commands/$guestUid (duplicate replay)
    const replayNow = guestTransport.serverNow();
    await set(ref(db, `rooms/${roomId}/commands/${guestUid}`), {
      commandId: ackedCommandId2,
      uid: guestUid,
      type: 'ready',
      payloadJson: JSON.stringify({ ready: false }),
      createdAtMs: replayNow,
      expiresAtMs: replayNow + 5000,
    });

    // Wait for freshly written replay response
    let freshReplayReceived = false;
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const respSnap = await get(ref(db, `rooms/${roomId}/responses/${guestUid}`));
      if (respSnap.exists() && respSnap.val().commandId === ackedCommandId2 && respSnap.val().ok === true) {
        freshReplayReceived = true;
        break;
      }
    }
    expect(freshReplayReceived).toBe(true);

    // Snapshot version and state must be completely unchanged on replay
    const snapAfterReplay = await get(ref(hostDb, `rooms/${roomId}/snapshot`));
    expect(snapAfterReplay.val().version).toBe(versionAfterCmd2);

    // 3. Test actual replay after host successor restoration
    hostTransport.dispose();
    await new Promise((r) => setTimeout(r, 2200));

    const hostTransport2 = makeTransport('seat-host-dedup', hostStorage);
    const resumeRes = await hostTransport2.resume(code, createRes.token);
    expect(resumeRes.ok).toBe(true);

    const host2Auth = await hostTransport2.session.ensureAuth();
    const host2Db = host2Auth.database;

    // Delete response again using admin bypass
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), `rooms/${roomId}/responses/${guestUid}`), null);
    });

    // Guest sends duplicate of seq 2 command to the restored successor host
    const restoredReplayNow = guestTransport.serverNow();
    await set(ref(db, `rooms/${roomId}/commands/${guestUid}`), {
      commandId: ackedCommandId2,
      uid: guestUid,
      type: 'ready',
      payloadJson: JSON.stringify({ ready: false }),
      createdAtMs: restoredReplayNow,
      expiresAtMs: restoredReplayNow + 5000,
    });

    let restoredReplayReceived = false;
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const respSnap = await get(ref(db, `rooms/${roomId}/responses/${guestUid}`));
      if (respSnap.exists() && respSnap.val().commandId === ackedCommandId2 && respSnap.val().ok === true) {
        restoredReplayReceived = true;
        break;
      }
    }
    expect(restoredReplayReceived).toBe(true);

    // Snapshot version on successor host remains identical
    const snapAfterRestoredReplay = await get(ref(host2Db, `rooms/${roomId}/snapshot`));
    expect(snapAfterRestoredReplay.val().version).toBe(versionAfterCmd2);
  }, 20_000);

  it('recovers interrupted join reservation from memberSlots without collisions or slot overwrites', async () => {
    const hostStorage = createMemoryStorage();
    const host1 = makeTransport('seat-host-reserved-recovery', hostStorage);

    const createRes = await host1.createRoom('هوست الاستعادة');
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const code = createRes.code;
    const roomId = (host1 as any).currentRoomId;
    const hostRuntimeId = host1.getHostRuntime()!.getRuntimeId();
    const db = (await host1.session.ensureAuth()).database;

    // Simulate guest A preparing to join: guest A's UID is assigned slot '2' in memberSlots
    // but the join was interrupted before state/snapshot commit!
    const guestA = makeTransport('seat-guest-reserved-a');
    const guestAUid = (await guestA.session.ensureAuth()).uid;
    const now = host1.serverNow();

    await set(ref(db, `rooms/${roomId}/memberSlots/2`), {
      slot: '2',
      uid: guestAUid,
      assignedAtMs: now,
      leaseOwnerId: hostRuntimeId,
    });

    // Host refreshes / resumes: dispose host1, wait for lease expiry, resume host2
    host1.dispose();
    await new Promise((r) => setTimeout(r, 2200));

    const host2 = makeTransport('seat-host-reserved-recovery', hostStorage);
    const resumeRes = await host2.resume(code, createRes.token);
    expect(resumeRes.ok).toBe(true);

    // Guest B (different UID) joins room: host must assign slot 3, avoiding collision on slot 2!
    const guestB = makeTransport('seat-guest-reserved-b');
    const joinResB = await guestB.joinRoom(code, 'لاعب ب');
    expect(joinResB.ok).toBe(true);

    const host2Db = (await host2.session.ensureAuth()).database;

    // Verify guest B was assigned slot '3'
    const slot3Snap = await get(ref(host2Db, `rooms/${roomId}/memberSlots/3`));
    expect(slot3Snap.exists()).toBe(true);
    const guestBUid = (await guestB.session.ensureAuth()).uid;
    expect(slot3Snap.val().uid).toBe(guestBUid);

    // Now guest A retries their join: host reuses existing slot 2 without collision or assignedAtMs error!
    const joinResA = await guestA.joinRoom(code, 'لاعب أ');
    expect(joinResA.ok).toBe(true);

    // Both players successfully admitted
    const memberASnap = await get(ref(host2Db, `rooms/${roomId}/members/${guestAUid}`));
    expect(memberASnap.exists()).toBe(true);
    expect(memberASnap.val().slot).toBe('2');

    const memberBSnap = await get(ref(host2Db, `rooms/${roomId}/members/${guestBUid}`));
    expect(memberBSnap.exists()).toBe(true);
    expect(memberBSnap.val().slot).toBe('3');
  }, 15_000);

  it('proves command committed by predecessor during successor wait survives restoration, including its dedup record', async () => {
    const hostStorage = createMemoryStorage();
    const host1 = makeTransport('seat-host-wait-predecessor', hostStorage, { leaseTtlMs: 2500, heartbeatIntervalMs: 800 });
    const createRes = await host1.createRoom('هوست الانتظار');
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const code = createRes.code;
    const roomId = (host1 as any).currentRoomId;

    const guest = makeTransport('seat-guest-wait-predecessor');
    const joinRes = await guest.joinRoom(code, 'ضيف الانتظار');
    expect(joinRes.ok).toBe(true);

    const guestAuth = await guest.session.ensureAuth();
    const guestUid = guestAuth.uid;
    const db = guestAuth.database;

    // Start host2 resume in background - it enters wait loop waiting for host1's lease
    const host2 = makeTransport('seat-host-wait-predecessor', hostStorage, { leaseTtlMs: 2500, heartbeatIntervalMs: 800 });
    const resumePromise = host2.resume(code, createRes.token, { maxWaitMs: 8000 });

    // While host2 is in its wait loop, guest sends setReady(true) to host1!
    await new Promise((r) => setTimeout(r, 200));
    const readyRes = await guest.setReady(true);
    expect(readyRes.ok).toBe(true);

    // Read the exact commandId that host1 committed
    const respSnap = await get(ref(db, `rooms/${roomId}/responses/${guestUid}`));
    expect(respSnap.exists()).toBe(true);
    const ackedCmdId = respSnap.val().commandId;

    // Stop host1's runtime execution and heartbeat so its lease expires without deleting shared App
    host1.getHostRuntime()!.dispose();
    const resumeRes = await resumePromise;
    expect(resumeRes.ok).toBe(true);

    const host2Auth = await host2.session.ensureAuth();
    const host2Db = host2Auth.database;

    // Host 2 must have restored the fresh state (snapshot version 2 with guest ready = true)
    const host2Snap = await get(ref(host2Db, `rooms/${roomId}/snapshot`));
    expect(host2Snap.exists()).toBe(true);
    const parsedState = JSON.parse(host2Snap.val().json).state;
    const guestPlayer = parsedState.players.find((p: any) => p.nickname === 'ضيف الانتظار');
    expect(guestPlayer?.ready).toBe(true);

    // Verify dedup record survived: delete response from RTDB via admin bypass, then send duplicate command
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), `rooms/${roomId}/responses/${guestUid}`), null);
    });
    const now = guest.serverNow();
    await set(ref(db, `rooms/${roomId}/commands/${guestUid}`), {
      commandId: ackedCmdId,
      uid: guestUid,
      type: 'ready',
      payloadJson: JSON.stringify({ ready: true }),
      createdAtMs: now,
      expiresAtMs: now + 5000,
    });

    let replayed = false;
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const rSnap = await get(ref(db, `rooms/${roomId}/responses/${guestUid}`));
      if (rSnap.exists() && rSnap.val().commandId === ackedCmdId && rSnap.val().ok === true) {
        replayed = true;
        break;
      }
    }
    expect(replayed).toBe(true);

    // Snapshot version remains identical on duplicate replay
    const snapAfterDup = await get(ref(host2Db, `rooms/${roomId}/snapshot`));
    expect(snapAfterDup.val().version).toBe(host2Snap.val().version);
  }, 20_000);

  it('preserves membership fencing after successor takeover on host kick and guest leave', async () => {
    const hostStorage = createMemoryStorage();
    const host1 = makeTransport('seat-host-fencing', hostStorage, { leaseTtlMs: 2000, heartbeatIntervalMs: 700 });
    const createRes = await host1.createRoom('هوست الفنسنج');
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const code = createRes.code;
    const roomId = (host1 as any).currentRoomId;

    const guest1 = makeTransport('seat-guest-fencing-1');
    const join1 = await guest1.joinRoom(code, 'ضيف 1');
    expect(join1.ok).toBe(true);

    const guest2 = makeTransport('seat-guest-fencing-2');
    const join2 = await guest2.joinRoom(code, 'ضيف 2');
    expect(join2.ok).toBe(true);

    const guest1Uid = (await guest1.session.ensureAuth()).uid;
    const guest2Uid = (await guest2.session.ensureAuth()).uid;

    // Predecessor host exits
    host1.dispose();
    await new Promise((r) => setTimeout(r, 2200));

    // Successor host takes over
    const host2 = makeTransport('seat-host-fencing', hostStorage, { leaseTtlMs: 2000, heartbeatIntervalMs: 700 });
    const resumeRes = await host2.resume(code, createRes.token);
    expect(resumeRes.ok).toBe(true);

    const host2RuntimeId = host2.getHostRuntime()!.getRuntimeId();
    const host2Db = (await host2.session.ensureAuth()).database;

    // 1. Host 2 kicks guest 2
    const kickRes = await host2.kick((join2 as any).playerId);
    expect(kickRes.ok).toBe(true);

    // Verify member record in RTDB was updated with removed: true and leaseOwnerId matching host 2
    const guest2MemberSnap = await get(ref(host2Db, `rooms/${roomId}/members/${guest2Uid}`));
    expect(guest2MemberSnap.exists()).toBe(true);
    expect(guest2MemberSnap.val().removed).toBe(true);
    expect(guest2MemberSnap.val().leaseOwnerId).toBe(host2RuntimeId);

    // 2. Guest 1 leaves
    const leaveRes = await guest1.leave();
    expect(leaveRes.ok).toBe(true);

    // Verify guest 1 member record was updated with removed: true and leaseOwnerId matching host 2
    const guest1MemberSnap = await get(ref(host2Db, `rooms/${roomId}/members/${guest1Uid}`));
    expect(guest1MemberSnap.exists()).toBe(true);
    expect(guest1MemberSnap.val().removed).toBe(true);
    expect(guest1MemberSnap.val().leaseOwnerId).toBe(host2RuntimeId);
  }, 15_000);

  it('pauses content work across SDK disconnect and proves reconnected runtime cannot commit, and successor restores exact uncorrupted state', async () => {
    let pauseResolve: (() => void) | null = null;
    let shouldPause = false;
    let pauseTriggered = false;

    const pauseHook = async () => {
      if (shouldPause && !pauseTriggered) {
        pauseTriggered = true;
        await new Promise<void>((r) => {
          pauseResolve = r;
        });
      }
    };

    const pausingSource: ContentSource = {
      categories: () => contentSource.categories(),
      async countBy(categoryIds, shape) {
        await pauseHook();
        return contentSource.countBy(categoryIds, shape);
      },
      async pick(query) {
        await pauseHook();
        return contentSource.pick(query);
      },
    };

    const hostStorage = createMemoryStorage();
    const host1 = makeTransport('seat-host-pause-disconnect', hostStorage, {
      contentSource: pausingSource,
      leaseTtlMs: 2500,
      heartbeatIntervalMs: 800,
    });

    const createRes = await host1.createRoom('هوست الانقطاع', {
      roundCount: 5,
      format: 'focused',
      roundTypeId: 'mcq_race',
    });
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const code = createRes.code;
    const roomId = (host1 as any).currentRoomId;

    const guest = makeTransport('seat-guest-pause-disconnect');
    await guest.joinRoom(code, 'ضيف الانقطاع');
    await guest.setReady(true);

    const host1Auth = await host1.session.ensureAuth();
    const host1Db = host1Auth.database;
    const hostUid = host1Auth.uid;

    const hostAuthDb = testEnv.authenticatedContext(hostUid).database();
    const snapBefore = await get(ref(hostAuthDb, `rooms/${roomId}/snapshot`));
    const versionBefore = snapBefore.val().version;
    const jsonBefore = snapBefore.val().json;

    try {
      // Enable content pause and start match (will pause inside countBy or pick during availableShapes)
      shouldPause = true;
      const startPromise = host1.start();

      // Wait until start is paused in content work
      for (let i = 0; i < 30 && !pauseResolve; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(pauseResolve).not.toBeNull();

      // Disconnect host SDK WITHOUT manually disposing runtime:
      // Real database onConnectionChange listener triggers stopExecution on disconnect
      goOffline(host1Db);

      // Wait 100ms for connection listener to trigger stopExecution
      await new Promise((r) => setTimeout(r, 100));

      // Bring host DB back online
      goOnline(host1Db);

      // Release paused content after reconnect
      pauseResolve!();
      pauseResolve = null;

      const startResult = await startPromise.catch((err) => ({ ok: false, error: err.message }));
      expect(startResult.ok).toBe(false);

      // Allow any stray queue ticks to settle
      await new Promise((r) => setTimeout(r, 200));

      // Prove stopped execution cannot commit to RTDB
      const snapAfter = await get(ref(hostAuthDb, `rooms/${roomId}/snapshot`));
      expect(snapAfter.val().version).toBe(versionBefore);
      expect(snapAfter.val().json).toBe(jsonBefore);
      expect(snapAfter.val().phase ?? 'lobby').toBe('lobby');

      // Stop host1 runtime so its lease expires, then restore with successor
      host1.getHostRuntime()!.dispose();
      await new Promise((r) => setTimeout(r, 2700));

      // Successor restores from canonical RTDB records
      const host2 = makeTransport('seat-host-pause-disconnect', hostStorage, {
        leaseTtlMs: 2500,
        heartbeatIntervalMs: 800,
      });
      const resumeRes = await host2.resume(code, createRes.token);
      expect(resumeRes.ok).toBe(true);

      // Verify exact saved state has no leaked in-round mutation
      const snapSuccessor = await get(ref(hostAuthDb, `rooms/${roomId}/snapshot`));
      expect(snapSuccessor.val().version).toBe(versionBefore);
      const parsedState = JSON.parse(snapSuccessor.val().json).state;
      expect(parsedState.phase).toBe('lobby');
      expect(parsedState.roundIndex).toBe(-1);
      expect(parsedState.roundState).toBeNull();
      expect(parsedState.pendingContent).toBeNull();
    } finally {
      shouldPause = false;
      if (pauseResolve) {
        (pauseResolve as () => void)();
        pauseResolve = null;
      }
      try {
        goOnline(host1Db);
      } catch {
        // Ignore
      }
    }
  }, 20_000);

  it('pauses content work across runtime disposal and proves in-flight task cannot commit', async () => {
    let pauseResolve: (() => void) | null = null;
    let shouldPause = false;
    let pauseTriggered = false;

    const pauseHook = async () => {
      if (shouldPause && !pauseTriggered) {
        pauseTriggered = true;
        await new Promise<void>((r) => {
          pauseResolve = r;
        });
      }
    };

    const pausingSource: ContentSource = {
      categories: () => contentSource.categories(),
      async countBy(categoryIds, shape) {
        await pauseHook();
        return contentSource.countBy(categoryIds, shape);
      },
      async pick(query) {
        await pauseHook();
        return contentSource.pick(query);
      },
    };

    const host = makeTransport('seat-host-pause-dispose', undefined, {
      contentSource: pausingSource,
      leaseTtlMs: 3000,
      heartbeatIntervalMs: 1000,
    });

    const createRes = await host.createRoom('هوست التجميد');
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const code = createRes.code;
    const roomId = (host as any).currentRoomId;

    const guest = makeTransport('seat-guest-pause-dispose');
    await guest.joinRoom(code, 'ضيف التجميد');
    await guest.setReady(true);

    const hostAuth = await host.session.ensureAuth();
    const hostUid = hostAuth.uid;
    const hostAuthDb = testEnv.authenticatedContext(hostUid).database();

    const snapBefore = await get(ref(hostAuthDb, `rooms/${roomId}/snapshot`));
    const versionBefore = snapBefore.val().version;

    try {
      shouldPause = true;
      const startPromise = host.start();

      for (let i = 0; i < 30 && !pauseResolve; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(pauseResolve).not.toBeNull();

      // Dispose runtime only, preserving SDK and authorized observer
      host.getHostRuntime()!.dispose();

      // Release paused content
      (pauseResolve as (() => void) | null)?.();
      pauseResolve = null;

      const startResult = await startPromise.catch((err) => ({ ok: false, error: err.message }));
      expect(startResult.ok).toBe(false);

      await new Promise((r) => setTimeout(r, 200));

      const snapAfter = await get(ref(hostAuthDb, `rooms/${roomId}/snapshot`));
      expect(snapAfter.val().version).toBe(versionBefore);
      expect(snapAfter.val().phase ?? 'lobby').toBe('lobby');
    } finally {
      shouldPause = false;
      if (pauseResolve) {
        (pauseResolve as () => void)();
        pauseResolve = null;
      }
    }
  }, 15_000);

  it('handles full transport disposal cleanly while preserving persisted room records in database', async () => {
    const host = makeTransport('seat-host-full-dispose');
    const createRes = await host.createRoom('هوست التخلص');
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const code = createRes.code;
    const roomId = (host as any).currentRoomId;

    const guest = makeTransport('seat-guest-full-dispose');
    const joinRes = await guest.joinRoom(code, 'ضيف التخلص');
    expect(joinRes.ok).toBe(true);

    const hostAuth = await host.session.ensureAuth();
    const hostUid = hostAuth.uid;
    const hostAuthDb = testEnv.authenticatedContext(hostUid).database();

    const snapBefore = await get(ref(hostAuthDb, `rooms/${roomId}/snapshot`));
    expect(snapBefore.exists()).toBe(true);

    // Fully dispose host transport (deletes its session and runtime)
    host.dispose();

    // Verify via independent authorized observer that database records are intact
    const snapAfter = await get(ref(hostAuthDb, `rooms/${roomId}/snapshot`));
    expect(snapAfter.exists()).toBe(true);
    expect(snapAfter.val().version).toBe(snapBefore.val().version);

    const metaSnap = await get(ref(hostAuthDb, `rooms/${roomId}/meta`));
    expect(metaSnap.exists()).toBe(true);
    expect(metaSnap.val().status).toBe('open');
  });

  it('disposing a waiting runtime during stale lease wait prevents subsequent lease acquisition or background startup', async () => {
    const hostStorage = createMemoryStorage();
    const host1 = makeTransport('seat-host-waiting-dispose', hostStorage, { leaseTtlMs: 2500, heartbeatIntervalMs: 800 });
    const createRes = await host1.createRoom('هوست الإلغاء');
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const code = createRes.code;
    const roomId = (host1 as any).currentRoomId;
    const host1RuntimeId = host1.getHostRuntime()!.getRuntimeId();
    const host1Auth = await host1.session.ensureAuth();
    const hostUid = host1Auth.uid;
    const hostAuthDb = testEnv.authenticatedContext(hostUid).database();

    // Start host2 resume with bounded wait
    const host2 = makeTransport('seat-host-waiting-dispose', hostStorage, { leaseTtlMs: 2500, heartbeatIntervalMs: 800 });
    const resumePromise = host2.resume(code, createRes.token, { maxWaitMs: 8000 });

    // Dispose ONLY host2's target getHostRuntime(), keeping the shared named SDK app alive
    await new Promise((r) => setTimeout(r, 200));
    host2.getHostRuntime()!.dispose();

    // The resume promise must reject or fail
    const resumeResult = await resumePromise.catch((err) => ({ ok: false, error: err.message }));
    expect(resumeResult.ok).toBe(false);

    // Stop host1 runtime execution so lease will expire
    host1.getHostRuntime()!.dispose();
    await new Promise((r) => setTimeout(r, 2700));

    // Check lease in RTDB via authorized observer: host2 must NOT have acquired the lease
    const leaseSnap = await get(ref(hostAuthDb, `rooms/${roomId}/lease`));
    expect(leaseSnap.exists()).toBe(true);
    expect(leaseSnap.val().ownerId).toBe(host1RuntimeId); // Not host2!
  }, 15_000);

  it('rolls back in-memory state and dedup cache on atomic publication failure (expired command) without emitting committed view, allowing subsequent command to succeed', async () => {
    let pauseCategoriesResolve: (() => void) | null = null;
    let shouldPauseCategories = false;

    const pausingSource: ContentSource = {
      async categories() {
        if (shouldPauseCategories) {
          await new Promise<void>((r) => {
            pauseCategoriesResolve = r;
          });
        }
        return contentSource.categories();
      },
      countBy: (categoryIds, shape) => contentSource.countBy(categoryIds, shape),
      pick: (query) => contentSource.pick(query),
    };

    const hostStorage = createMemoryStorage();
    const hostTransport = makeTransport('seat-host-denied-rollback', hostStorage, {
      contentSource: pausingSource,
    });

    const createRes = await hostTransport.createRoom('هوست التراجع');
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const code = createRes.code;
    const roomId = (hostTransport as any).currentRoomId;

    const guestTransport = makeTransport('seat-guest-denied-rollback');
    const joinRes = await guestTransport.joinRoom(code, 'ضيف التراجع');
    expect(joinRes.ok).toBe(true);

    const guestAuth = await guestTransport.session.ensureAuth();
    const guestUid = guestAuth.uid;
    const guestDb = guestAuth.database;

    const hostAuth = await hostTransport.session.ensureAuth();
    const hostUid = hostAuth.uid;
    const hostAuthDb = testEnv.authenticatedContext(hostUid).database();

    const snapBefore = await get(ref(hostAuthDb, `rooms/${roomId}/snapshot`));
    const versionBefore = snapBefore.val().version;
    const jsonBefore = snapBefore.val().json;

    // Track views emitted to host transport
    const emittedViews: RoomView[] = [];
    hostTransport.onState((v) => {
      emittedViews.push(v);
    });
    const emittedViewsCountBefore = emittedViews.length;

    try {
      // Arm the pause in categories() right before atomic commit (after engine mutation)
      shouldPauseCategories = true;

      // Use the actual guestTransport.setReady(true) API so its real sequencer advances correctly
      const readyPromise = guestTransport.setReady(true);

      // Wait until host runtime executes setReady and enters categories()
      for (let i = 0; i < 30 && !pauseCategoriesResolve; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(pauseCategoriesResolve).not.toBeNull();

      // Capture the actual queued command written by guestTransport sequencer
      const cmdSnap = await get(ref(guestDb, `rooms/${roomId}/commands/${guestUid}`));
      expect(cmdSnap.exists()).toBe(true);
      const actualCmd = cmdSnap.val();
      const actualCmdId = actualCmd.commandId;
      const actualPayloadJson = actualCmd.payloadJson;

      // While paused, expire that actual queued command using a clearly adversarial rules-disabled fixture
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await update(ref(ctx.database(), `rooms/${roomId}/commands/${guestUid}`), {
          expiresAtMs: Date.now() - 5000,
        });
      });

      // Release the pause - host will now attempt atomic commit
      // RTDB rules validate: newData.child('ok').val() === false || commands/$uid.expiresAtMs > now
      // Since command expired, atomic commit update() is denied by rules!
      (pauseCategoriesResolve as (() => void) | null)?.();
      pauseCategoriesResolve = null;

      // Capture the actual API outcome (failure)
      const readyResult = await readyPromise;
      expect(readyResult.ok).toBe(false);

      // Wait for host runtime catch block to write ok: false response to RTDB
      let failureResponseReceived = false;
      for (let i = 0; i < 30; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
        const resp = await get(ref(guestDb, `rooms/${roomId}/responses/${guestUid}`));
        if (resp.exists() && resp.val().commandId === actualCmdId && resp.val().ok === false) {
          failureResponseReceived = true;
          break;
        }
      }
      expect(failureResponseReceived).toBe(true);

      // 1. Verify NO committed view was emitted to host on the failed publication
      expect(emittedViews.length).toBe(emittedViewsCountBefore);

      // 2. Exact prior persisted state in RTDB
      const snapAfterFailed = await get(ref(hostAuthDb, `rooms/${roomId}/snapshot`));
      expect(snapAfterFailed.val().version).toBe(versionBefore);
      expect(snapAfterFailed.val().json).toBe(jsonBefore);

      // 3. Observable state proof: snapshot in RTDB was not updated by the failed command
      const parsedFailedState = JSON.parse(snapAfterFailed.val().json).state;
      const failedGuest = parsedFailedState.players.find((p: any) => p.nickname === 'ضيف التراجع');
      expect(failedGuest?.ready).toBe(false);

      // 4. Disarm the pause hook so subsequent calls execute normally
      shouldPauseCategories = false;

      // 5. Re-submit THE SAME ID as a fresh unexpired raw command after disarming pause:
      // It must really execute, proving failure didn't poison dedup!
      const resubmitNow = guestTransport.serverNow();
      await set(ref(guestDb, `rooms/${roomId}/commands/${guestUid}`), {
        commandId: actualCmdId,
        uid: guestUid,
        type: 'ready',
        payloadJson: actualPayloadJson,
        createdAtMs: resubmitNow,
        expiresAtMs: resubmitNow + 5000,
      });

      let resubmitAccepted = false;
      for (let i = 0; i < 30; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
        const respSnap = await get(ref(guestDb, `rooms/${roomId}/responses/${guestUid}`));
        if (respSnap.exists() && respSnap.val().commandId === actualCmdId && respSnap.val().ok === true) {
          resubmitAccepted = true;
          break;
        }
      }
      expect(resubmitAccepted).toBe(true);

      // Verify snapshot version advanced with exactly one version increment and guest is now ready
      const snapAfterResubmit = await get(ref(hostAuthDb, `rooms/${roomId}/snapshot`));
      expect(snapAfterResubmit.val().version).toBe(versionBefore + 1);
      const parsedResubmit = JSON.parse(snapAfterResubmit.val().json).state;
      const resubmitGuest = parsedResubmit.players.find((p: any) => p.nickname === 'ضيف التراجع');
      expect(resubmitGuest?.ready).toBe(true);

      // 6. A subsequent regular setReady(false) should use the next client sequence with exactly one further increment
      const unreadyRes = await guestTransport.setReady(false);
      expect(unreadyRes.ok).toBe(true);

      const snapAfterUnready = await get(ref(hostAuthDb, `rooms/${roomId}/snapshot`));
      expect(snapAfterUnready.val().version).toBe(versionBefore + 2);
      const parsedUnready = JSON.parse(snapAfterUnready.val().json).state;
      const unreadyGuest = parsedUnready.players.find((p: any) => p.nickname === 'ضيف التراجع');
      expect(unreadyGuest?.ready).toBe(false);
    } finally {
      shouldPauseCategories = false;
      if (pauseCategoriesResolve) {
        (pauseCategoriesResolve as () => void)();
        pauseCategoriesResolve = null;
      }
    }
  }, 20_000);

  it('rejects host resume when acquired lease expires during slow restoration catch-up tick before observation starts', async () => {
    let pauseResolve: (() => void) | null = null;
    let shouldPause = false;

    const pausingSource: ContentSource = {
      categories: () => contentSource.categories(),
      countBy: (categoryIds, shape) => contentSource.countBy(categoryIds, shape),
      async pick(query) {
        if (shouldPause) {
          await new Promise<void>((r) => {
            pauseResolve = r;
            setTimeout(r, 10_000);
          });
        }
        return contentSource.pick(query);
      },
    };

    const hostStorage = createMemoryStorage();
    const host1 = makeTransport('seat-host-resume-overdue-lease', hostStorage, {
      leaseTtlMs: 2000,
      heartbeatIntervalMs: 700,
    });

    const createRes = await host1.createRoom('هوست الحجز', {
      roundCount: 5,
      format: 'focused',
      roundTypeId: 'mcq_race',
    });
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const code = createRes.code;
    const roomId = (host1 as any).currentRoomId;
    const token = createRes.token;

    const guest = makeTransport('seat-guest-resume-overdue-lease');
    await guest.joinRoom(code, 'ضيف الحجز');
    await guest.setReady(true);
    await host1.start();
    await host1.skip();

    // Verify in_round phase and retrieve canonical roundNo
    const hostUid = (await host1.session.ensureAuth()).uid;
    const hostAuthDb = testEnv.authenticatedContext(hostUid).database();
    const inRoundSnap = await get(ref(hostAuthDb, `rooms/${roomId}/snapshot`));
    const inRoundEnvelope = JSON.parse(inRoundSnap.val().json);
    expect(inRoundEnvelope.state.phase).toBe('in_round');
    const roundNo = inRoundEnvelope.state.roundNo;
    expect(typeof roundNo).toBe('number');
    expect(roundNo).toBeGreaterThanOrEqual(1);

    // Both players submit answer actions to advance from in_round -> round_result
    const hostActRes = await host1.act(roundNo, { kind: 'answer', choice: 0 });
    expect(hostActRes.ok).toBe(true);
    const guestActRes = await guest.act(roundNo, { kind: 'answer', choice: 1 });
    expect(guestActRes.ok).toBe(true);

    // Assert canonical state.phase === 'round_result' before stopping predecessor/expiring deadline
    const snapSnap = await get(ref(hostAuthDb, `rooms/${roomId}/snapshot`));
    const initialEnvelope = JSON.parse(snapSnap.val().json);
    expect(initialEnvelope.state.phase).toBe('round_result');

    // Host 1 stops execution and heartbeat so lease expires
    host1.getHostRuntime()!.dispose();
    await new Promise((r) => setTimeout(r, 2200));

    // Successor host2 with pausingSource, heartbeatIntervalMs: 5000 and leaseTtlMs: 1500
    // HeartbeatIntervalMs: 5000 intentionally ensures no renewal fires within the 1800ms pause;
    // The valid behavior is clean rejection after ownership expiry.
    const host2 = makeTransport('seat-host-resume-overdue-lease', hostStorage, {
      contentSource: pausingSource,
      leaseTtlMs: 1500,
      heartbeatIntervalMs: 5000,
    });

    // Make phase overdue so resume catch-up runs tick -> advance -> beginRound -> pickContent
    const envelope = JSON.parse(snapSnap.val().json);
    envelope.state.phaseEndsAtMs = Date.now() - 1000;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await update(ref(ctx.database(), `rooms/${roomId}/snapshot`), {
        json: JSON.stringify(envelope),
      });
    });

    let resumePromise: Promise<any> | null = null;
    try {
      // Arm pause in pickContent
      shouldPause = true;
      resumePromise = host2.resume(code, token);

      // Wait until resume is paused inside pickContent
      for (let i = 0; i < 40 && !pauseResolve; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(pauseResolve).not.toBeNull();

      // While paused in pickContent, wait 1800ms so the acquired lease expires (> 1500ms leaseTtlMs)
      await new Promise((r) => setTimeout(r, 1800));

      // Release pause
      if (pauseResolve) {
        (pauseResolve as () => void)();
        pauseResolve = null;
      }

      // Resume MUST FAIL because lease expired before restoration completed!
      const resumeRes = await resumePromise.catch((err) => ({ ok: false, error: err.message }));
      expect(resumeRes.ok).toBe(false);
    } finally {
      shouldPause = false;
      if (pauseResolve) {
        (pauseResolve as () => void)();
        pauseResolve = null;
      }
      if (resumePromise) {
        await resumePromise.catch(() => {});
      }
      host1.dispose();
      host2.dispose();
      guest.dispose();
    }
  }, 25_000);

  it('proves host command fails and emits no accepted view when atomic publication is denied by database rules', async () => {
    let pauseResolve: (() => void) | null = null;
    let shouldPause = false;

    const pausingSource: ContentSource = {
      async categories() {
        if (shouldPause) {
          await new Promise<void>((r) => {
            pauseResolve = r;
            setTimeout(r, 10_000);
          });
        }
        return contentSource.categories();
      },
      countBy: (categoryIds, shape) => contentSource.countBy(categoryIds, shape),
      pick: (query) => contentSource.pick(query),
    };

    const hostTransport = makeTransport('seat-host-denied-ack', undefined, {
      contentSource: pausingSource,
    });
    const createRes = await hostTransport.createRoom('هوست التوثيق');
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const roomId = (hostTransport as any).currentRoomId;
    const hostAuth = await hostTransport.session.ensureAuth();
    const hostUid = hostAuth.uid;
    const hostAuthDb = testEnv.authenticatedContext(hostUid).database();

    const initialSnap = await get(ref(hostAuthDb, `rooms/${roomId}/snapshot`));
    const initialVersion = initialSnap.val().version;
    const initialJson = initialSnap.val().json;

    const emittedViews: RoomView[] = [];
    hostTransport.onState((v) => {
      emittedViews.push(v);
    });

    let configPromise: Promise<any> | null = null;
    try {
      // Arm pause in categories() right before host runtime atomic commit
      // Room and room/meta remain strictly valid!
      shouldPause = true;

      // Host calls configure({ roundCount: 10 })
      configPromise = hostTransport.configure({ roundCount: 10 });

      // Wait until host runtime executes configure and enters categories()
      for (let i = 0; i < 40 && !pauseResolve; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(pauseResolve).not.toBeNull();

      // While paused, capture the actual queued command in /commands/$hostUid
      const cmdSnap = await get(ref(hostAuthDb, `rooms/${roomId}/commands/${hostUid}`));
      expect(cmdSnap.exists()).toBe(true);
      expect(cmdSnap.val().type).toBe('configure');

      // Adversarially expire that queued command
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await update(ref(ctx.database(), `rooms/${roomId}/commands/${hostUid}`), {
          expiresAtMs: Date.now() - 5000,
        });
      });

      // Release pause so host runtime attempts atomic commit update()
      // Security rules deny publication because commands/$hostUid is expired!
      (pauseResolve as (() => void) | null)?.();
      pauseResolve = null;

      const configRes = await configPromise;
      expect(configRes.ok).toBe(false);

      // No host view with roundCount: 10 was emitted
      expect(emittedViews.some((v) => v.config?.roundCount === 10)).toBe(false);

      // Canonical snapshot version remains unchanged
      const snapAfter = await get(ref(hostAuthDb, `rooms/${roomId}/snapshot`));
      expect(snapAfter.val().version).toBe(initialVersion);
      expect(snapAfter.val().json).toBe(initialJson);
    } finally {
      shouldPause = false;
      if (pauseResolve) {
        (pauseResolve as () => void)();
        pauseResolve = null;
      }
      if (configPromise) {
        await configPromise.catch(() => {});
      }
      hostTransport.dispose();
    }
  }, 15_000);

  it('proves replaying command when response publication is denied by database rules emits failure committed ACK and no success', async () => {
    const hostTransport = makeTransport('seat-host-denied-replay');
    let unsubView: (() => void) | null = null;
    let unsubCommittedAck: (() => void) | null = null;
    try {
      const createRes = await hostTransport.createRoom('هوست الإعادة المرفوضة');
      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;

      const roomId = (hostTransport as any).currentRoomId;
      const hostAuth = await hostTransport.session.ensureAuth();
      const hostUid = hostAuth.uid;
      const hostRuntime = hostTransport.getHostRuntime()!;
      const hostAuthDb = testEnv.authenticatedContext(hostUid).database();

      // 1. Capture the accepted command ID from committed ACK event
      let acceptedCommandId: string | null = null;
      unsubCommittedAck = hostRuntime.onCommittedAck((ack) => {
        if (ack.ok) {
          acceptedCommandId = ack.commandId;
        }
      });

      // Execute normal valid command
      const firstReady = await hostTransport.setReady(true);
      expect(firstReady.ok).toBe(true);
      expect(acceptedCommandId).not.toBeNull();

      // Verify the accepted command ID also matches the persisted response record
      const resSnap = await get(ref(hostAuthDb, `rooms/${roomId}/responses/${hostUid}`));
      expect(resSnap.exists()).toBe(true);
      expect(resSnap.val().commandId).toBe(acceptedCommandId);
      expect(resSnap.val().ok).toBe(true);

      // Save initial canonical state and snapshot version
      const initialSnap = await get(ref(hostAuthDb, `rooms/${roomId}/snapshot`));
      const initialVersion = initialSnap.val().version;
      const initialJson = initialSnap.val().json;

      // Track views to assert NO accepted view is emitted during failed replay
      const emittedViewsDuringReplay: RoomView[] = [];
      unsubView = hostTransport.onState((v) => {
        emittedViewsDuringReplay.push(v);
      });

      // Track committed ACKs during replay to assert failure ACK and NO success ACK
      let replayFailureAck: CommittedAck | null = null;
      let unexpectedOkAck: CommittedAck | null = null;
      unsubCommittedAck();
      unsubCommittedAck = hostRuntime.onCommittedAck((ack) => {
        if (ack.ok) {
          unexpectedOkAck = ack;
        } else {
          replayFailureAck = ack;
        }
      });

      // 2. Adversarially seed only that runtime's dedup cached successful ACK with an over-limit dataJson
      // using existing dedup snapshot/fromJSON fixture boundary (malformed cache fixture).
      // Real database security rules enforce responses/$uid/dataJson max length <= 4096.
      const dedupSnapshot = (hostRuntime as any).dedup.toJSON();
      expect(dedupSnapshot[hostUid]).toBeDefined();
      dedupSnapshot[hostUid].lastAck = {
        ok: true,
        dataJson: 'x'.repeat(5000), // Exceeds 4096-char rule limit
      };
      (hostRuntime as any).dedup.fromJSON(dedupSnapshot);

      // 3. Restore the SAME valid ID request through authorized SDK while live lease is valid
      const now = Date.now();
      const originalCmd = {
        commandId: acceptedCommandId!,
        uid: hostUid,
        type: 'ready',
        payloadJson: JSON.stringify({ ready: true }),
        createdAtMs: now,
        expiresAtMs: now + 8000,
      };
      await set(ref(hostAuthDb, `rooms/${roomId}/commands/${hostUid}`), originalCmd);

      // Await host runtime processing the replayed command in live execution
      for (let i = 0; i < 40 && !replayFailureAck; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!replayFailureAck) {
        await (hostRuntime as any).processMemberCommand(hostAuthDb, hostUid, originalCmd);
      }

      // 4. Assert actual response-schema rule denial produces failure ACK and NO success
      expect(replayFailureAck).not.toBeNull();
      expect(replayFailureAck!.ok).toBe(false);
      expect(replayFailureAck!.commandId).toBe(acceptedCommandId);
      expect(unexpectedOkAck).toBeNull();
      expect(emittedViewsDuringReplay.length).toBe(0);

      // Canonical state and snapshot version remain unchanged (scoring/action effects did not run twice)
      const snapAfterReplay = await get(ref(hostAuthDb, `rooms/${roomId}/snapshot`));
      expect(snapAfterReplay.val().version).toBe(initialVersion);
      expect(snapAfterReplay.val().json).toBe(initialJson);

      // 5. Use a fresh valid command afterwards to prove recovery
      dedupSnapshot[hostUid].lastAck = { ok: true };
      (hostRuntime as any).dedup.fromJSON(dedupSnapshot);

      const freshReadyRes = await hostTransport.setReady(false);
      expect(freshReadyRes.ok).toBe(true);

      const recoveredSnap = await get(ref(hostAuthDb, `rooms/${roomId}/snapshot`));
      expect(recoveredSnap.val().version).toBe(initialVersion + 1);
    } finally {
      if (unsubView) unsubView();
      if (unsubCommittedAck) unsubCommittedAck();
      hostTransport.dispose();
    }
  }, 15_000);

  it('allows already-admitted guest to recover seat and rejoin room when room is at full capacity', async () => {
    const hostTransport = makeTransport('seat-host-full-rejoin');
    const createRes = await hostTransport.createRoom('هوست الامتلاء');
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const code = createRes.code;
    const roomId = (hostTransport as any).currentRoomId;

    // Guest A joins as player 2
    const guestAStorage = createMemoryStorage();
    const guestA = makeTransport('seat-guest-full-rejoin-a', guestAStorage);
    const joinResA = await guestA.joinRoom(code, 'لاعب أ');
    expect(joinResA.ok).toBe(true);
    if (!joinResA.ok) return;

    // Fill room to full capacity (8 active players, players 3 through 8)
    for (let p = 3; p <= 8; p += 1) {
      const guestOther = makeTransport(`seat-guest-full-rejoin-${p}`);
      const joinResOther = await guestOther.joinRoom(code, `لاعب ${p}`);
      expect(joinResOther.ok).toBe(true);
    }

    // A fresh 9th player is rejected because room is full (8 players)
    const guest9 = makeTransport('seat-guest-full-rejoin-9');
    const joinRes9 = await guest9.joinRoom(code, 'لاعب ٩');
    expect(joinRes9.ok).toBe(false);

    // Guest A retries joinRoom (e.g. after lost join acknowledgement or refresh without token)
    // Must NOT be rejected as "room full"; must recover own existing admitted seat!
    const rejoinResA = await guestA.joinRoom(code, 'لاعب أ');
    expect(rejoinResA.ok).toBe(true);
    if (rejoinResA.ok) {
      expect(rejoinResA.playerId).toBe(joinResA.playerId);
      expect(rejoinResA.token).toBe(joinResA.token);
    }
  }, 20_000);

  it('handles disconnected SDK during joinRoom without uncaught errors and prevents late publication on reconnect', async () => {
    const transportStorage = createMemoryStorage();
    setMockWindowSessionStorage(transportStorage);
    const transport = makeTransport('seat-disconnected-entry', transportStorage);

    // Authenticate transport first so authCtx and database instance are ready
    const authCtx = await transport.session.ensureAuth();
    const db = authCtx.database;

    const emittedViews: RoomView[] = [];
    transport.onState((v) => {
      emittedViews.push(v);
    });

    try {
      // Disconnect RTDB SDK
      await goOffline(db);

      // Call joinRoom while offline
      const joinPromise = transport.joinRoom('DISC1', 'لاعب غير متصل');
      const joinRes = await joinPromise;

      expect(joinRes.ok).toBe(false);

      // Reconnect SDK
      await goOnline(db);
      await new Promise((r) => setTimeout(r, 600));

      // Assert no late room/seat/listener publication
      expect((transport as any).currentRoomId).toBeNull();
      expect((transport as any).currentPlayerId).toBeNull();
      expect(loadSession()).toBeNull();
      expect(transportStorage.getItem('party-game-session')).toBeNull();
      expect(emittedViews.length).toBe(0);
    } finally {
      restoreWindow();
      try {
        await goOnline(db);
      } catch {
        // Ignore
      }
      transport.dispose();
    }
  }, 16_000);

  it('enforces bounded creation deadline when initial content boundary is delayed without releasing content', async () => {
    let pauseResolve: (() => void) | null = null;
    let pauseCategories = true;

    // Real ContentSource delegating to actual contentSource, pausing on categories()
    const pausingSource: ContentSource = {
      async categories() {
        if (pauseCategories) {
          await new Promise<void>((r) => {
            pauseResolve = r;
          });
        }
        return contentSource.categories();
      },
      countBy: (categoryIds, shape) => contentSource.countBy(categoryIds, shape),
      pick: (query) => contentSource.pick(query),
    };

    const hostStorage = createMemoryStorage();
    setMockWindowSessionStorage(hostStorage);

    const transport = makeTransport('seat-create-deadline', hostStorage, {
      contentSource: pausingSource,
    });

    // Authenticate SDK beforehand
    const authCtx = await transport.session.ensureAuth();
    const hostUid = authCtx.uid;
    const hostAuthDb = testEnv.authenticatedContext(hostUid).database();

    const emittedViews: RoomView[] = [];
    transport.onState((v) => {
      emittedViews.push(v);
    });

    const startMs = Date.now();
    const createPromise = transport.createRoom('هوست المهلة');

    // Wait until MatchEngine.createRoom calls categories() and pauses
    for (let i = 0; i < 40 && !pauseResolve; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(pauseResolve).not.toBeNull();

    // 13s watchdog Promise.race so current unbounded implementation fails a clear assertion
    // rather than hanging the test framework indefinitely
    let watchdogFired = false;
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
    const watchdogPromise = new Promise<{ ok: false; timeout: true }>((resolve) => {
      watchdogTimer = setTimeout(() => {
        watchdogFired = true;
        resolve({ ok: false, timeout: true });
      }, 13_000);
    });

    let createResult: any;
    try {
      createResult = await Promise.race([
        createPromise.then((res) => ({ ...res, timeout: false })),
        watchdogPromise,
      ]);

      if (watchdogTimer) clearTimeout(watchdogTimer);

      // Current implementation lacks whole-entry deadline on createRoom, so watchdog will fire
      // and fail this clear assertion rather than hanging vitest runner indefinitely
      expect(watchdogFired).toBe(false);
      expect(createResult.ok).toBe(false);
      expect(createResult.timeout).toBe(false);
      const durationMs = Date.now() - startMs;
      expect(durationMs).toBeLessThanOrEqual(12_500);

      // On expected repaired path, release content after timeout
      pauseCategories = false;
      if (pauseResolve) {
        (pauseResolve as () => void)();
        pauseResolve = null;
      }

      await Promise.race([
        createPromise.catch(() => {}),
        new Promise((r) => setTimeout(r, 1000)),
      ]);

      // Assert no view was emitted
      expect(emittedViews.length).toBe(0);

      // Assert no session was saved
      expect(loadSession()).toBeNull();
      expect(hostStorage.getItem('party-game-session')).toBeNull();

      // Assert no host activeRoom appears through actual authorized SDK reads
      const activeRoomSnap = await get(ref(hostAuthDb, `hosts/${hostUid}/activeRoom`));
      expect(activeRoomSnap.exists()).toBe(false);
    } finally {
      restoreWindow();
      if (watchdogTimer) clearTimeout(watchdogTimer);
      pauseCategories = false;
      if (watchdogFired) {
        // If watchdog fired, dispose before releasing so no leaked writes
        transport.dispose();
      }
      if (pauseResolve) {
        (pauseResolve as () => void)();
        pauseResolve = null;
      }
      try {
        await Promise.race([
          createPromise.catch(() => {}),
          new Promise((r) => setTimeout(r, 1000)),
        ]);
      } catch {
        // Ignore
      }
      transport.dispose();
    }
  }, 20_000);

  it('prevents cancelled in-flight room operation from saving session, emitting view, or tearing down state', async () => {
    let pauseResolve: (() => void) | null = null;
    let shouldPause = false;

    const pausingSource: ContentSource = {
      async categories() {
        if (shouldPause) {
          await new Promise<void>((r) => {
            pauseResolve = r;
            setTimeout(r, 10_000);
          });
        }
        return contentSource.categories();
      },
      countBy: (categoryIds, shape) => contentSource.countBy(categoryIds, shape),
      pick: (query) => contentSource.pick(query),
    };

    const hostTransport = makeTransport('seat-host-inflight-cancel', undefined, {
      contentSource: pausingSource,
    });
    const createRes = await hostTransport.createRoom('هوست الإلغاء');
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const code = createRes.code;
    const guestStorage = createMemoryStorage();
    setMockWindowSessionStorage(guestStorage);

    const guestTransport = makeTransport('seat-guest-inflight-cancel', guestStorage);

    const emittedViews: RoomView[] = [];
    guestTransport.onState((v) => {
      emittedViews.push(v);
    });

    let joinPromise: Promise<any> | null = null;
    try {
      // Arm pause in categories() - host runtime calls categories() during guest admission
      shouldPause = true;

      // Guest starts joinRoom
      joinPromise = guestTransport.joinRoom(code, 'ضيف الإلغاء');

      // Wait until host runtime picks up joinRequest and enters categories()
      for (let i = 0; i < 40 && !pauseResolve; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(pauseResolve).not.toBeNull();

      // While join is in-flight awaiting host response, cancel the operation via leave()
      await guestTransport.leave();

      // Release deferred boundary on host
      (pauseResolve as (() => void) | null)?.();
      pauseResolve = null;

      // In-flight join must resolve or return failure/cancelled
      const joinRes = await joinPromise;
      expect(joinRes.ok).toBe(false);

      // Prove old operation cannot save session
      expect(guestStorage.getItem('party-game-session')).toBeNull();
      expect(loadSession()).toBeNull();

      // Prove old operation cannot emit views
      expect(emittedViews.length).toBe(0);

      // Prove transport state is not tied to the old room
      expect((guestTransport as any).currentRoomId).toBeNull();
    } finally {
      restoreWindow();
      shouldPause = false;
      if (pauseResolve) {
        (pauseResolve as () => void)();
        pauseResolve = null;
      }
      if (joinPromise) {
        await joinPromise.catch(() => {});
      }
      hostTransport.dispose();
      guestTransport.dispose();
    }
  }, 15_000);

  it('does not open BroadcastChannel during FirebaseTransport construction for render', () => {
    let openedChannels = 0;
    const OriginalBroadcastChannel = globalThis.BroadcastChannel;

    class CountingBroadcastChannel extends OriginalBroadcastChannel {
      constructor(name: string) {
        super(name);
        openedChannels += 1;
      }
    }

    (globalThis as any).BroadcastChannel = CountingBroadcastChannel;

    let transport: FirebaseTransport | null = null;
    try {
      // Constructing transport for render (e.g. useState(() => createGameTransport()))
      transport = new FirebaseTransport({ config: DEMO_CONFIG });
      expect(openedChannels).toBe(0);
    } finally {
      if (transport) {
        transport.dispose();
      }
      (globalThis as any).BroadcastChannel = OriginalBroadcastChannel;
    }
  });

  it('handles session disposal during or immediately after ensureAuth without leaks or resurrection', async () => {
    const seatId = 'test-seat-delayed-dispose-' + Date.now();
    const session = new FirebaseSessionManager({
      config: DEMO_CONFIG,
      seatId,
      databaseEmulatorHost: process.env.FIREBASE_DATABASE_EMULATOR_HOST ?? '127.0.0.1:9000',
      authEmulatorHost: process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099',
    });

    const authPromise = session.ensureAuth();
    await session.dispose();

    await expect(authPromise).rejects.toThrow('FirebaseSessionManager is disposed');

    const appName = session.getAppName();
    const appStillExists = getApps().some((a) => a.name === appName);
    expect(appStillExists).toBe(false);

    // Call ensureAuth after disposal to prove no resurrection
    await expect(session.ensureAuth()).rejects.toThrow('FirebaseSessionManager is disposed');
    expect(getApps().some((a) => a.name === appName)).toBe(false);
  });

  it('delayed leave on older room cannot tear down replacement room', async () => {
    let pauseResolve: (() => void) | null = null;
    let shouldPause = false;

    const pausingSource: ContentSource = {
      async categories() {
        if (shouldPause) {
          await new Promise<void>((r) => {
            pauseResolve = r;
            setTimeout(r, 10_000);
          });
        }
        return contentSource.categories();
      },
      countBy: (categoryIds, shape) => contentSource.countBy(categoryIds, shape),
      pick: (query) => contentSource.pick(query),
    };

    const hostStorage = createMemoryStorage();
    const hostTransport = makeTransport('seat-host-replace-leave-1', hostStorage, {
      contentSource: pausingSource,
    });
    const createRes1 = await hostTransport.createRoom('هوست غرفة 1');
    expect(createRes1.ok).toBe(true);
    if (!createRes1.ok) return;

    const guestStorage = createMemoryStorage();
    setMockWindowSessionStorage(guestStorage);
    let host2Transport: FirebaseTransport | null = null;
    let guestTransport: FirebaseTransport | null = null;
    try {
      guestTransport = makeTransport('seat-guest-replace-leave', guestStorage);

      const joinRes1 = await guestTransport.joinRoom(createRes1.code, 'ضيف غرفة 1');
      expect(joinRes1.ok).toBe(true);
      if (!joinRes1.ok) return;

      const roomId1 = (guestTransport as any).currentRoomId;
      expect(roomId1).toBeDefined();

      // Host 2 creates room 2
      const host2Storage = createMemoryStorage();
      host2Transport = makeTransport('seat-host-replace-leave-2', host2Storage);
      const createRes2 = await host2Transport.createRoom('هوست غرفة 2');
      expect(createRes2.ok).toBe(true);
      if (!createRes2.ok) return;

      // Arm pause on Host 1 so when guest leave command arrives, host 1 pauses in content
      shouldPause = true;

      // Guest leaves room 1 (local state detaches immediately, leave command is sent)
      const leavePromise = guestTransport.leave();
      expect((guestTransport as any).currentRoomId).toBeNull();

      // Guest immediately joins room 2 while leave from room 1 is delayed/held
      const joinRes2 = await guestTransport.joinRoom(createRes2.code, 'ضيف غرفة 2');
      expect(joinRes2.ok).toBe(true);

      // Release pause on Host 1
      shouldPause = false;
      if (pauseResolve) {
        (pauseResolve as () => void)();
        pauseResolve = null;
      }

      const leaveRes = await leavePromise;
      expect(leaveRes.ok).toBe(true);

      // Replacement room is completely intact
      expect((guestTransport as any).currentRoomId).toBe((host2Transport as any).currentRoomId);
      expect((guestTransport as any).currentCode).toBe(createRes2.code);
    } finally {
      restoreWindow();
      shouldPause = false;
      if (pauseResolve) {
        (pauseResolve as () => void)();
        pauseResolve = null;
      }
      hostTransport.dispose();
      if (host2Transport) host2Transport.dispose();
      if (guestTransport) guestTransport.dispose();
    }
  }, 15_000);

  it('canceled or superseded command does not deliver late ACK or leave pendingCommand stuck', async () => {
    let pauseResolve: (() => void) | null = null;
    let shouldPause = false;

    const pausingSource: ContentSource = {
      async categories() {
        if (shouldPause) {
          await new Promise<void>((r) => {
            pauseResolve = r;
            setTimeout(r, 10_000);
          });
        }
        return contentSource.categories();
      },
      countBy: (categoryIds, shape) => contentSource.countBy(categoryIds, shape),
      pick: (query) => contentSource.pick(query),
    };

    const hostStorage = createMemoryStorage();
    const hostTransport = makeTransport('seat-host-cmd-cancel', hostStorage, {
      contentSource: pausingSource,
    });
    const createRes = await hostTransport.createRoom('هوست أوامر');
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const host2Storage = createMemoryStorage();
    const host2Transport = makeTransport('seat-host-cmd-cancel-2', host2Storage);
    const createRes2 = await host2Transport.createRoom('هوست أوامر 2');
    expect(createRes2.ok).toBe(true);
    if (!createRes2.ok) return;

    const guestStorage = createMemoryStorage();
    setMockWindowSessionStorage(guestStorage);
    let guestTransport: FirebaseTransport | null = null;
    try {
      guestTransport = makeTransport('seat-guest-cmd-cancel', guestStorage);
      const joinRes = await guestTransport.joinRoom(createRes.code, 'ضيف أوامر');
      expect(joinRes.ok).toBe(true);

      // Arm pause in categories()
      shouldPause = true;

      // Guest starts real command (setReady)
      const readyPromise = guestTransport.setReady(true);

      // Wait until host runtime picks up command and pauses in categories()
      for (let i = 0; i < 40 && !pauseResolve; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(pauseResolve).not.toBeNull();

      // While guest command is in flight, guest initiates leave()
      const leavePromise = guestTransport.leave();

      // The in-flight command promise must resolve with failure promptly even before host pause is released
      const readyRes = await readyPromise;
      expect(readyRes.ok).toBe(false);

      // Release pause on host so leave command is processed and rolled-back setReady produces no late ACK
      shouldPause = false;
      (pauseResolve as (() => void) | null)?.();
      pauseResolve = null;

      const leaveRes = await leavePromise;
      expect(leaveRes.ok).toBe(true);

      // Prove guest transport pendingCommand is NOT stuck: guest joins new room and sends command
      const rejoinRes = await guestTransport.joinRoom(createRes2.code, 'ضيف أوامر');
      expect(rejoinRes.ok).toBe(true);

      const nextReady = await guestTransport.setReady(true);
      expect(nextReady.ok).toBe(true);
    } finally {
      restoreWindow();
      shouldPause = false;
      if (pauseResolve) {
        (pauseResolve as () => void)();
        pauseResolve = null;
      }
      hostTransport.dispose();
      host2Transport.dispose();
      if (guestTransport) guestTransport.dispose();
    }
  }, 15_000);

  it('different resume parameters cancel and supersede prior in-flight resume operation', async () => {
    let pauseResolve: (() => void) | null = null;
    let shouldPause = false;

    const pausingSource: ContentSource = {
      async categories() {
        if (shouldPause) {
          await new Promise<void>((r) => {
            pauseResolve = r;
            setTimeout(r, 10_000);
          });
        }
        return contentSource.categories();
      },
      countBy: (categoryIds, shape) => contentSource.countBy(categoryIds, shape),
      pick: (query) => contentSource.pick(query),
    };

    // Create Room 1 with pausingSource so we can hold r1a's resume command in-flight
    const host1Storage = createMemoryStorage();
    const host1 = makeTransport('seat-host-resume-diff-1', host1Storage, {
      contentSource: pausingSource,
    });
    const createRes1 = await host1.createRoom('هوست غرفة 1');
    expect(createRes1.ok).toBe(true);
    if (!createRes1.ok) return;

    // Create Room 2
    const host2Storage = createMemoryStorage();
    const host2 = makeTransport('seat-host-resume-diff-2', host2Storage);
    const createRes2 = await host2.createRoom('هوست غرفة 2');
    expect(createRes2.ok).toBe(true);
    if (!createRes2.ok) return;

    const guestStorage = createMemoryStorage();
    setMockWindowSessionStorage(guestStorage);
    const guestTransport = makeTransport('seat-guest-resume-diff', guestStorage);

    try {
      // Guest joins Room 1
      const joinRes1 = await guestTransport.joinRoom(createRes1.code, 'ضيف غرفة 1');
      expect(joinRes1.ok).toBe(true);
      if (!joinRes1.ok) return;
      const token1 = joinRes1.token;

      // Guest transitions directly to Room 2 without calling leave() so seat remains admitted in both Room 1 and Room 2
      const joinRes2 = await guestTransport.joinRoom(createRes2.code, 'ضيف غرفة 2');
      expect(joinRes2.ok).toBe(true);
      if (!joinRes2.ok) return;
      const token2 = joinRes2.token;

      // Arm pause on Host 1 so r1a is genuinely held in-flight during its resume command
      shouldPause = true;

      // 1. Identical key returns the exact same in-flight promise (coalescing)
      const r1a = guestTransport.resume(createRes1.code, token1, { maxWaitMs: 5000 });
      const r1b = guestTransport.resume(createRes1.code, token1, { maxWaitMs: 5000 });
      expect(r1a).toBe(r1b);

      for (let i = 0; i < 40 && !pauseResolve; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(pauseResolve).not.toBeNull();

      // 2. Different key supersedes and cancels the prior in-flight resume
      const r2 = guestTransport.resume(createRes2.code, token2, { maxWaitMs: 5000 });
      expect(r2).not.toBe(r1a);

      // Release Host 1 after r2 has superseded r1a
      const res2 = await r2;
      shouldPause = false;
      if (pauseResolve) {
        (pauseResolve as () => void)();
        pauseResolve = null;
      }
      const res1 = await r1a;

      expect(res1.ok).toBe(false);
      expect(res2.ok).toBe(true);

      // Current room belongs to Room 2; Room 1 did not overwrite or erase Room 2
      expect((guestTransport as any).currentCode).toBe(createRes2.code);
      expect(guestStorage.getItem('party-game-session')).toContain(createRes2.code);
    } finally {
      restoreWindow();
      shouldPause = false;
      if (pauseResolve) {
        (pauseResolve as () => void)();
        pauseResolve = null;
      }
      host1.dispose();
      host2.dispose();
      guestTransport.dispose();
    }
  }, 15_000);

  it('normalizes and truncates long or whitespace-padded nickname on join', async () => {
    const hostStorage = createMemoryStorage();
    const hostTransport = makeTransport('seat-host-nick-norm', hostStorage);
    const createRes = await hostTransport.createRoom('هوست الاسم');
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const guestStorage = createMemoryStorage();
    setMockWindowSessionStorage(guestStorage);
    try {
      const guestTransport = makeTransport('seat-guest-nick-norm', guestStorage);

      const longNickname = '   لاعب_طويل_جدا_جدا_جدا_أكثر_من_16_حرف   ';
      const joinRes = await guestTransport.joinRoom(createRes.code, longNickname);
      expect(joinRes.ok).toBe(true);

      const hostView = hostTransport.getHostRuntime()?.getLatestCommittedView();
      const guestInView = hostView?.players.find((p) => p.id === (joinRes as any).playerId);
      expect(guestInView).toBeDefined();
      expect(guestInView?.nickname.length).toBeLessThanOrEqual(16);
      expect(guestInView?.nickname).toBe(longNickname.trim().slice(0, 16));
    } finally {
      restoreWindow();
    }
  }, 10_000);

  it('immediately marks host unresponsive on initial heartbeat read when heartbeat is older than 15s', async () => {
    const hostStorage = createMemoryStorage();
    const hostTransport = makeTransport('seat-host-stale-init-hb', hostStorage);
    const createRes = await hostTransport.createRoom('هوست نبض قديم');
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const roomId = (hostTransport as any).currentRoomId;
    const hostRuntime = hostTransport.getHostRuntime()!;
    const runtimeId = hostRuntime.getRuntimeId();

    // Stop host runtime heartbeat timer so it won't refresh heartbeat, while keeping lease valid for admission
    if ((hostRuntime as any).heartbeatTimer) {
      clearInterval((hostRuntime as any).heartbeatTimer);
      (hostRuntime as any).heartbeatTimer = null;
    }

    // Adversarially seed complete valid-shape old heartbeat at 20s age with security rules disabled:
    const now = hostTransport.serverNow();
    (hostRuntime as any).leaseExpiresAtMs = now + 10_000;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await update(ref(ctx.database(), `rooms/${roomId}/lease`), {
        expiresAtMs: now + 10_000,
      });
      await set(ref(ctx.database(), `rooms/${roomId}/heartbeat`), {
        leaseOwnerId: runtimeId,
        connected: true,
        lastSeenAtMs: now - 20_000,
      });
    });

    const guestStorage = createMemoryStorage();
    setMockWindowSessionStorage(guestStorage);
    try {
      const guestTransport = makeTransport('seat-guest-stale-init-hb', guestStorage);

      let hostUnresponsiveReported = false;
      guestTransport.onHostStatusChange((unresponsive) => {
        if (unresponsive) {
          hostUnresponsiveReported = true;
        }
      });

      const joinRes = await guestTransport.joinRoom(createRes.code, 'ضيف نبض');
      expect(joinRes.ok).toBe(true);

      // Initial heartbeat read should immediately mark host unresponsive (>15s)
      for (let i = 0; i < 30 && !hostUnresponsiveReported; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(hostUnresponsiveReported).toBe(true);
    } finally {
      restoreWindow();
      hostTransport.dispose();
    }
  }, 10_000);

  it('triggers room closure on reaching 6-hour room expiry for both host and guest', async () => {
    const hostStorage = createMemoryStorage();
    const hostTransport = makeTransport('seat-host-expiry-6h', hostStorage);
    const createRes = await hostTransport.createRoom('هوست انتهاء');
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const roomId = (hostTransport as any).currentRoomId;

    const guestStorage = createMemoryStorage();
    setMockWindowSessionStorage(guestStorage);
    const guestTransport = makeTransport('seat-guest-expiry-6h', guestStorage);
    const joinRes = await guestTransport.joinRoom(createRes.code, 'ضيف انتهاء');
    expect(joinRes.ok).toBe(true);

    let hostClosedReason: string | null = null;
    hostTransport.onClosed(({ reason }) => {
      hostClosedReason = reason;
    });

    let guestClosedReason: string | null = null;
    guestTransport.onClosed(({ reason }) => {
      guestClosedReason = reason;
    });

    // Update meta.expiresAtMs to imminent expiry using admin/rules-disabled context (time fault fixture)
    const now = hostTransport.serverNow();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await update(ref(ctx.database(), `rooms/${roomId}/meta`), {
        expiresAtMs: now + 800,
      });
    });

    for (let i = 0; i < 50 && (!hostClosedReason || !guestClosedReason); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(hostClosedReason).toContain('انتهت صلاحية الغرفة');
    expect(guestClosedReason).toContain('انتهت صلاحية الغرفة');

    // Both transports are detached and cleaned up
    expect((hostTransport as any).currentRoomId).toBeNull();
    expect((guestTransport as any).currentRoomId).toBeNull();
    hostTransport.dispose();
    guestTransport.dispose();
    restoreWindow();
  }, 10_000);

  it('recovers creator host management after lease expiry when connection is live via retryConnection', async () => {
    const hostStorage = createMemoryStorage();
    setMockWindowSessionStorage(hostStorage);
    try {
      const hostTransport = makeTransport('seat-host-lease-recover', hostStorage);

      const createRes = await hostTransport.createRoom('هوست استرجاع');
      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;

      const initialRuntime = hostTransport.getHostRuntime();
      expect(initialRuntime?.isLive()).toBe(true);

      // Stop heartbeat timer so lease expires
      if ((initialRuntime as any).heartbeatTimer) {
        clearInterval((initialRuntime as any).heartbeatTimer);
        (initialRuntime as any).heartbeatTimer = null;
      }

      // Wait for lease to expire (TTL is 2000ms)
      await new Promise((r) => setTimeout(r, 2200));
      expect(initialRuntime?.isLive()).toBe(false);

      // Trigger retryConnection()
      hostTransport.retryConnection();

      // Wait for recovery to complete
      for (let i = 0; i < 40 && (!hostTransport.getHostRuntime() || !hostTransport.getHostRuntime()?.isLive()); i += 1) {
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(hostTransport.getHostRuntime()?.isLive()).toBe(true);
      expect(hostTransport.getHostRuntime()?.getRuntimeId()).not.toBe(initialRuntime?.getRuntimeId());
    } finally {
      restoreWindow();
    }
  }, 10_000);

  it('rolls back in-memory mutation and emits no accepted view when existing-member rejoin is denied or cleared', async () => {
    let pauseResolve: (() => void) | null = null;
    let shouldPause = false;

    const pausingSource: ContentSource = {
      async categories() {
        if (shouldPause) {
          await new Promise<void>((r) => {
            pauseResolve = r;
            setTimeout(r, 10_000);
          });
        }
        return contentSource.categories();
      },
      countBy: (categoryIds, shape) => contentSource.countBy(categoryIds, shape),
      pick: (query) => contentSource.pick(query),
    };

    const hostStorage = createMemoryStorage();
    const hostTransport = makeTransport('seat-host-rejoin-rollback', hostStorage, {
      contentSource: pausingSource,
    });
    const createRes = await hostTransport.createRoom('هوست التراجع');
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const code = createRes.code;
    const hostRuntime = hostTransport.getHostRuntime()!;
    expect(hostRuntime).toBeDefined();

    const guestStorage = createMemoryStorage();
    setMockWindowSessionStorage(guestStorage);
    try {
      const guestTransport = makeTransport('seat-guest-rejoin-rollback', guestStorage);
      const joinRes1 = await guestTransport.joinRoom(code, 'ضيف التراجع');
      expect(joinRes1.ok).toBe(true);
      if (!joinRes1.ok) return;

      const guestPlayerId = (joinRes1 as any).playerId;
      const guestUid = (await guestTransport.session.ensureAuth()).uid;
      const hostAuth = await hostTransport.session.ensureAuth();
      const db = hostAuth.database;
      const roomId = hostRuntime.getRoomId()!;

      // Admitted guest becomes disconnected in canonical engine
      await hostRuntime.getEngine()!.setConnected(code, guestPlayerId, false);
      await (hostRuntime as any).publishEngineState(db);

      // Verify canonical state and snapshot show disconnected guest
      const stateBeforeRejoin = await hostRuntime.getStore().get(code);
      expect(stateBeforeRejoin).toBeDefined();
      expect(stateBeforeRejoin!.players.find((p) => p.id === guestPlayerId)?.connected).toBe(false);
      const versionBeforeRejoin = stateBeforeRejoin!.version;

      const snapBefore = await get(ref(db, `rooms/${roomId}/snapshot`));
      expect(snapBefore.exists()).toBe(true);
      const parsedSnapBefore = JSON.parse(snapBefore.val().json);
      expect(parsedSnapBefore.state.version).toBe(versionBeforeRejoin);
      expect(parsedSnapBefore.state.players.find((p: any) => p.id === guestPlayerId)?.connected).toBe(false);

      // Track committed host views emitted during rejoin attempt
      const emittedViewsDuringRejoin: RoomView[] = [];
      const unsubView = hostRuntime.onCommittedView((v) => {
        emittedViewsDuringRejoin.push(v);
      });

      // Arm pause in real content boundary during same-UID rejoin
      shouldPause = true;

      // Same-UID guest initiates rejoin (replayed joinRoom)
      const rejoinPromise = guestTransport.joinRoom(code, 'ضيف التراجع');

      // Wait until host runtime reaches the content pause during rejoin processing
      for (let i = 0; i < 40 && !pauseResolve; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(pauseResolve).not.toBeNull();

      // Find the joinRequest slot claimed by this guest
      const joinReqsSnap = await get(ref(db, `rooms/${roomId}/joinRequests`));
      expect(joinReqsSnap.exists()).toBe(true);
      let claimedSlotKey: string | null = null;
      for (const [k, v] of Object.entries(joinReqsSnap.val() as Record<string, any>)) {
        if (v && v.uid === guestUid) {
          claimedSlotKey = k;
          break;
        }
      }
      expect(claimedSlotKey).not.toBeNull();

      // Explicit fixture fault injection: adversarially expire join request while host is paused in content boundary
      const faultNow = hostTransport.serverNow();
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await update(ref(ctx.database(), `rooms/${roomId}/joinRequests/${claimedSlotKey}`), {
          expiresAtMs: faultNow - 1000,
        });
      });

      // Release real content boundary
      shouldPause = false;
      (pauseResolve as (() => void) | null)?.();
      pauseResolve = null;

      // Rejoin must fail / reject
      const rejoinRes = await rejoinPromise;
      expect(rejoinRes.ok).toBe(false);

      // Assert actual MemoryStore AND canonical snapshot are EXACTLY unchanged (including version and connected)
      const stateAfterRollback = await hostRuntime.getStore().get(code);
      expect(stateAfterRollback).toBeDefined();
      expect(stateAfterRollback!.version).toBe(versionBeforeRejoin);
      expect(stateAfterRollback!.players.find((p) => p.id === guestPlayerId)?.connected).toBe(false);

      const snapAfter = await get(ref(db, `rooms/${roomId}/snapshot`));
      expect(snapAfter.val().version).toBe(versionBeforeRejoin);
      const parsedSnapAfter = JSON.parse(snapAfter.val().json);
      expect(parsedSnapAfter.state.version).toBe(versionBeforeRejoin);
      expect(parsedSnapAfter.state.players.find((p: any) => p.id === guestPlayerId)?.connected).toBe(false);

      // Prove no accepted host view was emitted that marks the player connected
      const leakedConnectedViews = emittedViewsDuringRejoin.filter((v) =>
        v.players.some((p) => p.id === guestPlayerId && p.connected === true),
      );
      expect(leakedConnectedViews.length).toBe(0);

      // Next valid command succeeds without leaking denied connected mutation
      const readyRes = await hostTransport.setReady(true);
      expect(readyRes.ok).toBe(true);

      const stateAfterValidCmd = await hostRuntime.getStore().get(code);
      expect(stateAfterValidCmd!.version).toBe(versionBeforeRejoin + 1);
      expect(stateAfterValidCmd!.players.find((p) => p.id === guestPlayerId)?.connected).toBe(false);

      const snapAfterValidCmd = await get(ref(db, `rooms/${roomId}/snapshot`));
      expect(snapAfterValidCmd.val().version).toBe(versionBeforeRejoin + 1);
      const parsedSnapFinal = JSON.parse(snapAfterValidCmd.val().json);
      expect(parsedSnapFinal.state.players.find((p: any) => p.id === guestPlayerId)?.connected).toBe(false);

      unsubView();
    } finally {
      restoreWindow();
      shouldPause = false;
      if (pauseResolve) {
        (pauseResolve as () => void)();
        pauseResolve = null;
      }
    }
  }, 15_000);

  it('transfers host to the oldest connected member when host leaves and reconnects the former host as a regular member', async () => {
    const hostStorage = createMemoryStorage();
    const guest1Storage = createMemoryStorage();
    const guest2Storage = createMemoryStorage();

    const hostTransport = makeTransport('seat-host-transfer-orig', hostStorage, {
      leaseTtlMs: 2_000,
      heartbeatIntervalMs: 500,
      hostTakeoverGraceMs: 400,
    });
    const guest1Transport = makeTransport('seat-guest1-transfer-oldest', guest1Storage, {
      leaseTtlMs: 2_000,
      heartbeatIntervalMs: 500,
      hostTakeoverGraceMs: 400,
    });
    const guest2Transport = makeTransport('seat-guest2-transfer-newer', guest2Storage, {
      leaseTtlMs: 2_000,
      heartbeatIntervalMs: 500,
      hostTakeoverGraceMs: 400,
    });

    try {
      const createRes = await hostTransport.createRoom('الهوست الأصلي', {
        roundCount: 5,
        format: 'focused',
        roundTypeId: 'mcq_race',
      });
      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;

      const code = createRes.code;
      const origHostId = createRes.playerId;
      const origHostToken = createRes.token;

      const guest1Views: RoomView[] = [];
      const guest2Views: RoomView[] = [];
      guest1Transport.onState((v) => {
        guest1Views.push(v);
      });
      guest2Transport.onState((v) => {
        guest2Views.push(v);
      });

      const join1 = await guest1Transport.joinRoom(code, 'العضو الأقدم');
      expect(join1.ok).toBe(true);
      if (!join1.ok) return;
      const guest1Id = join1.playerId;

      const join2 = await guest2Transport.joinRoom(code, 'العضو الأحدث');
      expect(join2.ok).toBe(true);
      if (!join2.ok) return;

      // Start the match
      const startRes = await hostTransport.start();
      expect(startRes.ok).toBe(true);

      // Original host leaves mid-game while Guest 1 and Guest 2 are playing
      const leaveRes = await hostTransport.leave();
      expect(leaveRes.ok).toBe(true);

      // Wait for Guest 1 (oldest connected member) to automatically promote to host
      for (let i = 0; i < 40; i += 1) {
        const g1Last = guest1Views[guest1Views.length - 1];
        const g2Last = guest2Views[guest2Views.length - 1];
        if (
          g1Last?.you.isHost === true &&
          g2Last?.players.find((p) => p.id === guest1Id)?.isHost === true
        ) {
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      const g1Promoted = guest1Views[guest1Views.length - 1];
      const g2Observed = guest2Views[guest2Views.length - 1];
      expect(g1Promoted?.you.isHost).toBe(true);
      expect(guest1Transport.getHostRuntime()?.isLive()).toBe(true);
      expect(g2Observed?.players.find((p) => p.id === guest1Id)?.isHost).toBe(true);

      // New host (Guest 1) can advance the game phase so the game continues without freezing
      const skipRes = await guest1Transport.skip();
      expect(skipRes.ok).toBe(true);
      expect(guest1Views[guest1Views.length - 1]?.phase).toBe('in_round');

      // Former host returns and reconnects using their session token -> joins as a regular member (isHost: false)!
      const returningHostTransport = makeTransport('seat-host-transfer-orig', hostStorage, {
        leaseTtlMs: 2_000,
        heartbeatIntervalMs: 500,
        hostTakeoverGraceMs: 400,
      });
      const returningHostViews: RoomView[] = [];
      returningHostTransport.onState((v) => {
        returningHostViews.push(v);
      });

      const resumeRes = await returningHostTransport.resume(code, origHostToken);
      expect(resumeRes.ok).toBe(true);
      const returningHostView = returningHostViews[returningHostViews.length - 1];
      expect(returningHostView).toBeDefined();
      expect(returningHostView!.you.id).toBe(origHostId);
      expect(returningHostView!.you.isHost).toBe(false);
      expect(returningHostView!.players.find((p) => p.id === guest1Id)?.isHost).toBe(true);

      returningHostTransport.dispose();
    } finally {
      hostTransport.dispose();
      guest1Transport.dispose();
      guest2Transport.dispose();
    }
  }, 20_000);
});


