import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { type Database, get, ref, remove, set, update } from 'firebase/database';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { JsonSource } from '../../../../apps/server/src/content/json-source.js';
import { clearSession } from './client.js';
import { FirebaseTransport, type FirebaseTransportOptions } from './firebase-transport.js';
import type { FirebaseWebConfig } from './transport.js';

const SEED_DIR = fileURLToPath(new URL('../../../../content/seed', import.meta.url));
const contentSource = new JsonSource(SEED_DIR);

const RULES_PATH = fileURLToPath(new URL('../../../../database.rules.json', import.meta.url));
const RULES_JSON = readFileSync(RULES_PATH, 'utf8');

const PROJECT_ID = 'demo-yalla-nelaab';
const SIX_HOURS_MS = 6 * 60 * 60 * 1_000;

function parseHostAndPort(): { host: string; port: number } {
  const raw = process.env.FIREBASE_DATABASE_EMULATOR_HOST ?? '127.0.0.1:9000';
  const [host, portStr] = raw.split(':');
  return {
    host: host || '127.0.0.1',
    port: Number(portStr || 9000),
  };
}

const dbConfig = parseHostAndPort();
const DEMO_CONFIG: Readonly<FirebaseWebConfig> = Object.freeze({
  apiKey: 'fake-api-key-demo',
  authDomain: 'demo-yalla-nelaab.firebaseapp.com',
  databaseURL: `http://${dbConfig.host}:${dbConfig.port}?ns=demo-yalla-nelaab`,
  projectId: PROJECT_ID,
  appId: '1:123456789:web:abcdef123456',
});

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

let idCounter = 0;
function uniqueSuffix(): string {
  idCounter += 1;
  return `${Date.now().toString(36)}_${idCounter}_${Math.random().toString(36).slice(2, 6)}`;
}

function uniqueRoomId(tag = 'room'): string {
  const id = `${tag}_${uniqueSuffix()}`.replace(/[^A-Za-z0-9_-]/g, '_');
  return id.length < 10 ? `${id}_pad12345` : id.slice(0, 60);
}

function uniqueCode(): string {
  idCounter += 1;
  const chars = 'ACDEFGHJKMNPQRTUVWXY34679';
  let code = '';
  let n = (Date.now() + idCounter) % (chars.length ** 5);
  for (let i = 0; i < 5; i += 1) {
    code += chars[n % chars.length];
    n = Math.floor(n / chars.length);
  }
  return code.padEnd(5, 'A');
}

interface ValidMetaOptions {
  status?: 'open' | 'closed';
  phase?: 'lobby' | 'round_intro' | 'in_round' | 'round_result' | 'podium';
  expiresAtMs?: number;
  memberCount?: number;
  admittedCount?: number;
  leaseOwnerId?: string;
}

function createValidMetadataRecord(
  code: string,
  hostUid: string,
  nowMs: number,
  opts: ValidMetaOptions = {},
) {
  return {
    code,
    hostUid,
    createdAtMs: nowMs,
    expiresAtMs: opts.expiresAtMs ?? nowMs + SIX_HOURS_MS - 5_000,
    phase: opts.phase ?? 'lobby',
    status: opts.status ?? 'open',
    memberCount: opts.memberCount ?? 1,
    admittedCount: opts.admittedCount ?? 1,
    updatedAtMs: nowMs,
    leaseOwnerId: opts.leaseOwnerId ?? 'rt_intent_1',
  };
}

async function bootstrapValidRoomViaAuthorizedSdk(
  hostDb: Database,
  hostUid: string,
  roomId: string,
  code: string,
  nowMs = Date.now(),
  leaseOwnerId = 'rt_bootstrap_1',
) {
  const expiresAtMs = nowMs + SIX_HOURS_MS - 5_000;

  // Stage 0: Intent pointer
  await assertSucceeds(
    set(ref(hostDb, `hosts/${hostUid}/activeRoom`), {
      roomId,
      code,
      updatedAtMs: nowMs,
    }),
  );

  // Stage 1: Meta
  await assertSucceeds(
    set(ref(hostDb, `rooms/${roomId}/meta`), {
      code,
      hostUid,
      createdAtMs: nowMs,
      expiresAtMs,
      phase: 'lobby',
      status: 'open',
      memberCount: 1,
      admittedCount: 1,
      updatedAtMs: nowMs,
      leaseOwnerId,
    }),
  );

  // Stage 2: Lease (epoch 1, valid bounded duration: 15s <= 20s max)
  await assertSucceeds(
    set(ref(hostDb, `rooms/${roomId}/lease`), {
      ownerId: leaseOwnerId,
      hostUid,
      epoch: 1,
      acquiredAtMs: nowMs,
      expiresAtMs: nowMs + 15_000,
    }),
  );

  // Stage 2b: Member slot 1
  await assertSucceeds(
    set(ref(hostDb, `rooms/${roomId}/memberSlots/1`), {
      slot: '1',
      uid: hostUid,
      assignedAtMs: nowMs,
      leaseOwnerId,
    }),
  );

  // Stage 3: Snapshot, member, view, heartbeat
  await assertSucceeds(
    update(ref(hostDb, `rooms/${roomId}`), {
      heartbeat: {
        lastSeenAtMs: nowMs,
        connected: true,
        leaseOwnerId,
      },
      [`members/${hostUid}`]: {
        uid: hostUid,
        slot: '1',
        playerId: 'player_host',
        nickname: 'هوست',
        role: 'host',
        joinedAtMs: nowMs,
        leaseOwnerId,
      },
      snapshot: {
        json: JSON.stringify({ code, version: 0, phase: 'lobby' }),
        version: 0,
        updatedAtMs: nowMs,
        leaseOwnerId,
      },
      [`views/${hostUid}`]: {
        slot: '1',
        json: JSON.stringify({ code, phase: 'lobby', you: { id: 'player_host', isHost: true } }),
        version: 0,
        updatedAtMs: nowMs,
        leaseOwnerId,
      },
    }),
  );

  // Stage 4: Public code mapping
  await assertSucceeds(
    set(ref(hostDb, `codes/${code}`), {
      roomId,
      hostUid,
      createdAtMs: nowMs,
      expiresAtMs,
    }),
  );
}

describe('Firebase creator protocol integration (emulator)', () => {
  let testEnv: RulesTestEnvironment;
  const openTransports: FirebaseTransport[] = [];

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      database: {
        host: dbConfig.host,
        port: dbConfig.port,
        rules: RULES_JSON,
      },
    });
  });

  afterEach(async () => {
    for (const t of openTransports) {
      try {
        t.dispose();
      } catch {
        // Ignore errors during per-test teardown
      }
    }
    openTransports.length = 0;
    clearSession();
  });

  afterAll(async () => {
    for (const t of openTransports) {
      try {
        t.dispose();
      } catch {
        // Ignore errors during final teardown
      }
    }
    openTransports.length = 0;
    clearSession();
    if (testEnv) {
      await testEnv.cleanup();
    }
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

  // ---------------------------------------------------------------------------
  // Scenario 1: Successful actual room creation under matching-intent-before-metadata rules
  // ---------------------------------------------------------------------------
  it('1. succeeds room creation under matching-intent-before-metadata rules with agreeing pointer, code, and snapshot', async () => {
    const seatId = `seat_create_success_${uniqueSuffix()}`;
    const transport = makeTransport(seatId);

    const createResult = await transport.createRoom('الهوست_الناجح');
    expect(createResult.ok).toBe(true);

    if (createResult.ok) {
      const authCtx = await transport.session.ensureAuth();
      const hostDb = authCtx.database;
      const hostUid = authCtx.uid;
      const code = createResult.code;

      // 1. Private intent pointer matches returned code and roomId
      const activeSnap = await assertSucceeds(get(ref(hostDb, `hosts/${hostUid}/activeRoom`)));
      expect(activeSnap.exists()).toBe(true);
      expect(activeSnap.val()?.code).toBe(code);
      const roomId = activeSnap.val()?.roomId;
      expect(typeof roomId).toBe('string');
      expect(roomId.length).toBeGreaterThanOrEqual(10);

      // 2. Room metadata exists, is open, matches code and hostUid
      const metaSnap = await assertSucceeds(get(ref(hostDb, `rooms/${roomId}/meta`)));
      expect(metaSnap.exists()).toBe(true);
      expect(metaSnap.val()?.status).toBe('open');
      expect(metaSnap.val()?.code).toBe(code);
      expect(metaSnap.val()?.hostUid).toBe(hostUid);

      // 3. Public code mapping points to roomId and hostUid
      const codeSnap = await assertSucceeds(get(ref(hostDb, `codes/${code}`)));
      expect(codeSnap.exists()).toBe(true);
      expect(codeSnap.val()?.roomId).toBe(roomId);
      expect(codeSnap.val()?.hostUid).toBe(hostUid);

      // 4. Committed snapshot is initialized
      const snapshotSnap = await assertSucceeds(get(ref(hostDb, `rooms/${roomId}/snapshot`)));
      expect(snapshotSnap.exists()).toBe(true);
      expect(snapshotSnap.val()?.version).toBe(0);
    }
  });

  // ---------------------------------------------------------------------------
  // Scenario 2: Lost final saved session / ACK after public code publication
  // ---------------------------------------------------------------------------
  it('2. reconciles same creation or closes it before publishing replacement when saved session/ACK is lost', async () => {
    const seatId = `seat_lost_ack_${uniqueSuffix()}`;
    const initialTransport = makeTransport(seatId);

    // Complete actual real-engine creation with full envelope and runtime
    const initialResult = await initialTransport.createRoom('الهوست_الأصلي');
    expect(initialResult.ok).toBe(true);

    if (initialResult.ok) {
      const initialCode = initialResult.code;
      const predecessorAuth = await initialTransport.session.ensureAuth();
      const hostUid = predecessorAuth.uid;
      const hostDb = predecessorAuth.database;

      const activeSnap = await assertSucceeds(get(ref(hostDb, `hosts/${hostUid}/activeRoom`)));
      expect(activeSnap.exists()).toBe(true);
      const initialRoomId = activeSnap.val()?.roomId;

      // Discard saved game session token while retaining Auth UID/seat across refresh:
      clearSession();

      // Construct and authenticate successor BEFORE disposing predecessor to preserve anonymous UID in Node
      const retryTransport = makeTransport(seatId);
      const successorAuth = await retryTransport.session.ensureAuth();
      expect(successorAuth.uid).toBe(hostUid);

      // Stop predecessor runtime
      initialTransport.dispose();

      // Fresh transport with same seatId / Auth UID retries createRoom
      const retryResult = await retryTransport.createRoom('هوست_إعادة_المحاولة');
      expect(retryResult.ok).toBe(true);

      if (retryResult.ok) {
        const retryActiveSnap = await assertSucceeds(get(ref(hostDb, `hosts/${hostUid}/activeRoom`)));
        expect(retryActiveSnap.exists()).toBe(true);
        const activeRoomId = retryActiveSnap.val()?.roomId;
        const activeCode = retryActiveSnap.val()?.code;

        expect(activeCode).toBe(retryResult.code);

        if (activeRoomId === initialRoomId) {
          // Reconciled the SAME creation
          expect(retryResult.code).toBe(initialCode);
          const metaSnap = await assertSucceeds(get(ref(hostDb, `rooms/${initialRoomId}/meta`)));
          expect(metaSnap.val()?.status).toBe('open');
        } else {
          // Created a replacement room: old room MUST be positively closed
          const oldMetaSnap = await assertSucceeds(get(ref(hostDb, `rooms/${initialRoomId}/meta`)));
          expect(oldMetaSnap.val()?.status).toBe('closed');

          // New room is open and published
          const newMetaSnap = await assertSucceeds(get(ref(hostDb, `rooms/${activeRoomId}/meta`)));
          expect(newMetaSnap.val()?.status).toBe('open');
        }

        // Assert at most one owned room is open
        const initialMeta = await assertSucceeds(get(ref(hostDb, `rooms/${initialRoomId}/meta`)));
        const activeMeta = await assertSucceeds(get(ref(hostDb, `rooms/${activeRoomId}/meta`)));
        const openCount =
          (initialMeta.val()?.status === 'open' ? 1 : 0) +
          (activeRoomId !== initialRoomId && activeMeta.val()?.status === 'open' ? 1 : 0);
        expect(openCount).toBe(1);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Scenario 3: Metadata-only / no-lease interrupted bootstrap
  // ---------------------------------------------------------------------------
  it('3. completes same room or cleanly closes it before new intent when interrupted at metadata-only state', async () => {
    const seatId = `seat_metaonly_${uniqueSuffix()}`;
    const setupTransport = makeTransport(seatId);

    const predecessorAuth = await setupTransport.session.ensureAuth();
    const hostUid = predecessorAuth.uid;
    const hostDb = predecessorAuth.database;

    const partialRoomId = uniqueRoomId('c_metaonly');
    const partialCode = uniqueCode();
    const now = Date.now();
    const originalLeaseOwnerId = 'rt_metaonly_orig_1';

    // Seed valid private intent THEN valid initial open metadata (no lease, no snapshot, no public code)
    await assertSucceeds(
      set(ref(hostDb, `hosts/${hostUid}/activeRoom`), {
        roomId: partialRoomId,
        code: partialCode,
        updatedAtMs: now,
      }),
    );
    await assertSucceeds(
      set(ref(hostDb, `rooms/${partialRoomId}/meta`), {
        code: partialCode,
        hostUid,
        createdAtMs: now,
        expiresAtMs: now + SIX_HOURS_MS - 5_000,
        phase: 'lobby',
        status: 'open',
        memberCount: 1,
        admittedCount: 1,
        updatedAtMs: now,
        leaseOwnerId: originalLeaseOwnerId,
      }),
    );

    // Construct freshTransport and authenticate BEFORE disposing setupTransport to preserve UID in Node
    const freshTransport = makeTransport(seatId);
    const successorAuth = await freshTransport.session.ensureAuth();
    expect(successorAuth.uid).toBe(hostUid);

    setupTransport.dispose();

    // Fresh transport creates room under same creator identity
    const result = await freshTransport.createRoom('هوست_استكمال_ميتا');

    // The outcome must be bounded and valid
    if (result.ok) {
      const activeSnap = await assertSucceeds(get(ref(hostDb, `hosts/${hostUid}/activeRoom`)));
      expect(activeSnap.exists()).toBe(true);
      const resultingRoomId = activeSnap.val()?.roomId;

      if (resultingRoomId === partialRoomId) {
        // Completed the same room
        expect(result.code).toBe(partialCode);
        const leaseSnap = await assertSucceeds(get(ref(hostDb, `rooms/${partialRoomId}/lease`)));
        expect(leaseSnap.exists()).toBe(true);
      } else {
        // Replaced room: partialRoomId must have been closed, not abandoned open
        const oldMetaSnap = await assertSucceeds(get(ref(hostDb, `rooms/${partialRoomId}/meta`)));
        expect(oldMetaSnap.val()?.status).toBe('closed');
      }
    } else {
      // If recovery fails within bounded budget, original pointer must be preserved (no random orphan replacement)
      const pointerSnap = await assertSucceeds(get(ref(hostDb, `hosts/${hostUid}/activeRoom`)));
      expect(pointerSnap.val()?.roomId).toBe(partialRoomId);

      // No new public orphan code mapping was published
      const checkCodeSnap = await assertSucceeds(get(ref(hostDb, `codes/${partialCode}`)));
      expect(checkCodeSnap.exists()).toBe(false);
    }
  });

  // ---------------------------------------------------------------------------
  // Scenario 4: A different still-live execution owner prevents opening replacement room
  // ---------------------------------------------------------------------------
  it('4. prevents opening replacement room while previous room has a still-live execution owner', async () => {
    const seatId = `seat_live_owner_${uniqueSuffix()}`;
    const transport1 = makeTransport(seatId);

    // Use normal firstTransport.createRoom with real runtime and renewing heartbeat
    const firstResult = await transport1.createRoom('هوست_1_النشط');
    expect(firstResult.ok).toBe(true);

    if (firstResult.ok) {
      const authCtx = await transport1.session.ensureAuth();
      const hostUid = authCtx.uid;
      const hostDb = authCtx.database;

      const activeSnap = await assertSucceeds(get(ref(hostDb, `hosts/${hostUid}/activeRoom`)));
      expect(activeSnap.exists()).toBe(true);
      const liveRoomId = activeSnap.val()?.roomId;
      const liveCode = firstResult.code;

      // Ensure transport1 runtime is actively live with renewing heartbeat
      const runtime1 = transport1.getHostRuntime();
      expect(runtime1).not.toBeNull();
      expect(runtime1?.isLive()).toBe(true);

      // Second transport with the SAME explicit seat / Auth UID attempts createRoom
      const transport2 = makeTransport(seatId);
      const auth2 = await transport2.session.ensureAuth();
      expect(auth2.uid).toBe(hostUid);

      const result2 = await transport2.createRoom('هوست_2_منافس');

      // Replacement creation must fail because live owner cannot be preempted and room cannot be abandoned
      expect(result2.ok).toBe(false);

      // Assert room 1 remains open and intact
      const meta1Snap = await assertSucceeds(get(ref(hostDb, `rooms/${liveRoomId}/meta`)));
      expect(meta1Snap.val()?.status).toBe('open');

      // Assert codes mapping still points to room 1
      const codeSnap = await assertSucceeds(get(ref(hostDb, `codes/${liveCode}`)));
      expect(codeSnap.val()?.roomId).toBe(liveRoomId);
      expect(codeSnap.val()?.hostUid).toBe(hostUid);

      // Assert active intent pointer still references room 1
      const ptrSnap = await assertSucceeds(get(ref(hostDb, `hosts/${hostUid}/activeRoom`)));
      expect(ptrSnap.val()?.roomId).toBe(liveRoomId);
    }
  });

  // ---------------------------------------------------------------------------
  // Scenario 5: Actual code collision exhaustion preserves other room mapping
  // ---------------------------------------------------------------------------
  it('5. preserves existing room mapping and leaves no public orphan when all code candidate attempts collide', async () => {
    // Creator A creates Room A with code 'AAAAA'
    const seatA = `seat_coll_a_${uniqueSuffix()}`;
    const transportA = makeTransport(seatA);
    const authA = await transportA.session.ensureAuth();
    const hostAUid = authA.uid;
    const hostADb = authA.database;

    const roomA = uniqueRoomId('c_coll_a');
    const occupiedCode = 'AAAAA';
    const now = Date.now();

    await bootstrapValidRoomViaAuthorizedSdk(
      hostADb,
      hostAUid,
      roomA,
      occupiedCode,
      now,
      'rt_owner_a_1',
    );

    // Creator B attempts to create a room, but Math.random is forced to return 0,
    // which generates 'AAAAA' on every attempt
    const seatB = `seat_coll_b_${uniqueSuffix()}`;
    const transportB = makeTransport(seatB);

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    try {
      const resultB = await transportB.createRoom('هوست_ب_تصادم');

      // All 5 candidate attempts collide with occupiedCode -> must fail honestly, not overwrite
      expect(resultB.ok).toBe(false);

      // Creator A's mapping for occupiedCode is intact and still points to roomA
      const codeSnap = await assertSucceeds(get(ref(hostADb, `codes/${occupiedCode}`)));
      expect(codeSnap.exists()).toBe(true);
      expect(codeSnap.val()?.roomId).toBe(roomA);
      expect(codeSnap.val()?.hostUid).toBe(hostAUid);

      // Creator A's room metadata is still open
      const metaASnap = await assertSucceeds(get(ref(hostADb, `rooms/${roomA}/meta`)));
      expect(metaASnap.val()?.status).toBe('open');

      // Creator B did not leave an activeRoom pointer claiming occupiedCode
      const authB = await transportB.session.ensureAuth();
      const hostBDb = authB.database;
      const hostBUid = authB.uid;
      const bPointer = await assertSucceeds(get(ref(hostBDb, `hosts/${hostBUid}/activeRoom`)));
      if (bPointer.exists()) {
        expect(bPointer.val()?.code).not.toBe(occupiedCode);
      }
    } finally {
      randomSpy.mockRestore();
    }
  });

  // ---------------------------------------------------------------------------
  // Scenario 6: Creator reconciliation cleanup preserves reassigned public code
  // ---------------------------------------------------------------------------
  it('6. preserves foreign mapping and open room when cleaning up an old room whose code was reassigned', async () => {
    // Creator A had an old room that used code 'REUSE'
    const seatA = `seat_reuse_a_${uniqueSuffix()}`;
    const transportA = makeTransport(seatA);
    const authA = await transportA.session.ensureAuth();
    const hostAUid = authA.uid;
    const hostADb = authA.database;

    const oldRoomA = uniqueRoomId('c_reuse_old_a');
    const reusedCode = 'REUSE';
    const now = Date.now();

    // 1. Establish Creator A's intent pointer to oldRoomA with current valid timestamp
    await assertSucceeds(
      set(ref(hostADb, `hosts/${hostAUid}/activeRoom`), {
        roomId: oldRoomA,
        code: reusedCode,
        updatedAtMs: now,
      }),
    );

    // 2. oldRoomA is closed via valid authorized SDK flow with current valid timestamps (<30s) and valid lease (15s <= 20s)
    const oldMeta = createValidMetadataRecord(reusedCode, hostAUid, now, {
      status: 'open',
      leaseOwnerId: 'rt_old_a_1',
    });
    await assertSucceeds(set(ref(hostADb, `rooms/${oldRoomA}/meta`), oldMeta));
    await assertSucceeds(
      set(ref(hostADb, `rooms/${oldRoomA}/lease`), {
        ownerId: 'rt_old_a_1',
        hostUid: hostAUid,
        epoch: 1,
        acquiredAtMs: now,
        expiresAtMs: now + 15_000,
      }),
    );
    await assertSucceeds(
      update(ref(hostADb, `rooms/${oldRoomA}/meta`), {
        status: 'closed',
        updatedAtMs: now,
        leaseOwnerId: 'rt_old_a_1',
      }),
    );

    // 3. Creator B legitimately bootstraps a new active room using that same code 'REUSE'
    const seatB = `seat_reuse_b_${uniqueSuffix()}`;
    const transportB = makeTransport(seatB);
    const authB = await transportB.session.ensureAuth();
    const hostBUid = authB.uid;
    const hostBDb = authB.database;

    const activeRoomB = uniqueRoomId('c_reuse_active_b');
    await bootstrapValidRoomViaAuthorizedSdk(
      hostBDb,
      hostBUid,
      activeRoomB,
      reusedCode,
      now,
      'rt_owner_b_1',
    );

    // 4. Creator A now retries createRoom, triggering previous intent reconciliation/cleanup:
    clearSession();

    // Construct and authenticate successor BEFORE disposing predecessor to preserve anonymous UID in Node
    const freshTransportA = makeTransport(seatA);
    const freshAuthA = await freshTransportA.session.ensureAuth();
    expect(freshAuthA.uid).toBe(hostAUid);

    transportA.dispose();

    // Assert that Creator A's retry successfully creates/reconciles a new valid room
    const createResultA = await freshTransportA.createRoom('هوست_أ_جديد');
    expect(createResultA.ok).toBe(true);

    if (createResultA.ok) {
      const codeA = createResultA.code;
      expect(codeA).not.toBe(reusedCode); // Creator A gets a fresh code, not Creator B's reusedCode

      // Creator A's intent pointer matches new room
      const ptrSnapA = await assertSucceeds(get(ref(hostADb, `hosts/${hostAUid}/activeRoom`)));
      expect(ptrSnapA.exists()).toBe(true);
      expect(ptrSnapA.val()?.code).toBe(codeA);
      const newRoomIdA = ptrSnapA.val()?.roomId;
      expect(newRoomIdA).not.toBe(oldRoomA);

      // Creator A's new room meta is open
      const metaSnapA = await assertSucceeds(get(ref(hostADb, `rooms/${newRoomIdA}/meta`)));
      expect(metaSnapA.val()?.status).toBe('open');
      expect(metaSnapA.val()?.hostUid).toBe(hostAUid);
      expect(metaSnapA.val()?.code).toBe(codeA);

      // Creator A's new public code mapping is published
      const codeSnapA = await assertSucceeds(get(ref(hostADb, `codes/${codeA}`)));
      expect(codeSnapA.val()?.roomId).toBe(newRoomIdA);
      expect(codeSnapA.val()?.hostUid).toBe(hostAUid);
    }

    // 5. Creator B's mapping for 'REUSE' MUST remain intact and pointing to activeRoomB
    const codeSnapB = await assertSucceeds(get(ref(hostBDb, `codes/${reusedCode}`)));
    expect(codeSnapB.exists()).toBe(true);
    expect(codeSnapB.val()?.roomId).toBe(activeRoomB);
    expect(codeSnapB.val()?.hostUid).toBe(hostBUid);

    // Creator B's room remains open
    const roomBSnap = await assertSucceeds(get(ref(hostBDb, `rooms/${activeRoomB}/meta`)));
    expect(roomBSnap.val()?.status).toBe('open');
  });
});
