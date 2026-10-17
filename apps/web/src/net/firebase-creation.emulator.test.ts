import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { get, ref, remove, set, update } from 'firebase/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const RULES_PATH = fileURLToPath(new URL('../../../../database.rules.json', import.meta.url));
const RULES_JSON = readFileSync(RULES_PATH, 'utf8');

const PROJECT_ID = 'demo-yalla-nelaab';
const SIX_HOURS_MS = 6 * 60 * 60 * 1_000;

let testEnv: RulesTestEnvironment;

function parseHostAndPort(): { host: string; port: number } {
  const raw = process.env.FIREBASE_DATABASE_EMULATOR_HOST ?? '127.0.0.1:9000';
  const [host, portStr] = raw.split(':');
  return {
    host: host || '127.0.0.1',
    port: Number(portStr || 9000),
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
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  let n = (Date.now() + idCounter) % (chars.length ** 5);
  for (let i = 0; i < 5; i += 1) {
    code += chars[n % chars.length];
    n = Math.floor(n / chars.length);
  }
  return code.padEnd(5, 'X');
}

function uniqueUid(role = 'user'): string {
  return `${role}_${uniqueSuffix()}`;
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

async function setIntentPointer(
  hostDb: ReturnType<ReturnType<RulesTestEnvironment['authenticatedContext']>['database']>,
  hostUid: string,
  roomId: string,
  code: string,
  nowMs = Date.now(),
) {
  return set(ref(hostDb, `hosts/${hostUid}/activeRoom`), {
    roomId,
    code,
    updatedAtMs: nowMs,
  });
}

/**
 * Creates initial open metadata, acquires a valid matching live execution lease,
 * and updates status to 'closed' using standard authorized client SDK calls.
 */
async function createAndCloseRoomViaAuthorizedSdk(
  hostDb: ReturnType<ReturnType<RulesTestEnvironment['authenticatedContext']>['database']>,
  hostUid: string,
  roomId: string,
  code: string,
  nowMs = Date.now(),
  leaseOwnerId = 'rt_intent_1',
) {
  // 1. Initial metadata must be created with status: 'open'
  const openMeta = createValidMetadataRecord(code, hostUid, nowMs, {
    status: 'open',
    leaseOwnerId,
  });
  await assertSucceeds(set(ref(hostDb, `rooms/${roomId}/meta`), openMeta));

  // 2. Acquire valid initial execution lease (epoch 1)
  await assertSucceeds(
    set(ref(hostDb, `rooms/${roomId}/lease`), {
      ownerId: leaseOwnerId,
      hostUid,
      epoch: 1,
      acquiredAtMs: nowMs,
      expiresAtMs: nowMs + 15_000,
    }),
  );

  // 3. Authorized close using matching live lease
  await assertSucceeds(
    update(ref(hostDb, `rooms/${roomId}/meta`), {
      status: 'closed',
      updatedAtMs: nowMs,
      leaseOwnerId,
    }),
  );
}

describe('Creator intent rule fences and room replacement (emulator)', () => {
  beforeAll(async () => {
    const { host, port } = parseHostAndPort();
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      database: {
        host,
        port,
        rules: RULES_JSON,
      },
    });
  });

  afterAll(async () => {
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  describe('Initial metadata creation requires matching private intent pointer', () => {
    it('allows metadata create when matching private pointer roomId and code exists', async () => {
      const now = Date.now();
      const hostUid = uniqueUid('host');
      const roomId = uniqueRoomId('c1_match');
      const code = uniqueCode();
      const hostDb = testEnv.authenticatedContext(hostUid).database();

      // Step 1: Write matching private intent pointer
      await assertSucceeds(setIntentPointer(hostDb, hostUid, roomId, code, now));

      // Step 2: Write metadata with matching code and hostUid
      const meta = createValidMetadataRecord(code, hostUid, now);
      await assertSucceeds(set(ref(hostDb, `rooms/${roomId}/meta`), meta));
    });

    it('rejects metadata create when private intent pointer is missing (with passing control)', async () => {
      const now = Date.now();
      const hostUid = uniqueUid('host');
      const roomId = uniqueRoomId('c1_noptr');
      const code = uniqueCode();
      const hostDb = testEnv.authenticatedContext(hostUid).database();

      // Host has NO pointer at hosts/$hostUid/activeRoom
      const meta = createValidMetadataRecord(code, hostUid, now);

      // Must fail without pointer
      await assertFails(set(ref(hostDb, `rooms/${roomId}/meta`), meta));

      // Control: write matching pointer, then retry the same metadata creation
      await assertSucceeds(setIntentPointer(hostDb, hostUid, roomId, code, now));
      await assertSucceeds(set(ref(hostDb, `rooms/${roomId}/meta`), meta));
    });

    it('rejects metadata create when pointer has wrong roomId or wrong code', async () => {
      const now = Date.now();
      const hostUid = uniqueUid('host');
      const targetRoomId = uniqueRoomId('c1_target');
      const wrongRoomId = uniqueRoomId('c1_wrong');
      const targetCode = uniqueCode();
      const wrongCode = uniqueCode();
      const hostDb = testEnv.authenticatedContext(hostUid).database();
      const meta = createValidMetadataRecord(targetCode, hostUid, now);

      // 1. Pointer has wrong roomId
      await assertSucceeds(setIntentPointer(hostDb, hostUid, wrongRoomId, targetCode, now));
      await assertFails(set(ref(hostDb, `rooms/${targetRoomId}/meta`), meta));

      // 2. Pointer has wrong code
      await assertSucceeds(setIntentPointer(hostDb, hostUid, targetRoomId, wrongCode, now));
      await assertFails(set(ref(hostDb, `rooms/${targetRoomId}/meta`), meta));

      // 3. Pointer matches both roomId and code -> succeeds
      await assertSucceeds(setIntentPointer(hostDb, hostUid, targetRoomId, targetCode, now));
      await assertSucceeds(set(ref(hostDb, `rooms/${targetRoomId}/meta`), meta));
    });

    it('rejects metadata create when matching intent belongs to another UID or metadata specifies foreign hostUid', async () => {
      const now = Date.now();
      const host1Uid = uniqueUid('host1');
      const host2Uid = uniqueUid('host2');
      const roomId = uniqueRoomId('c1_foreign');
      const code = uniqueCode();

      const host1Db = testEnv.authenticatedContext(host1Uid).database();
      const host2Db = testEnv.authenticatedContext(host2Uid).database();

      // Host 2 writes intent pointer for roomId and code
      await assertSucceeds(setIntentPointer(host2Db, host2Uid, roomId, code, now));

      // Case A: Host 1 (who has no pointer) tries to create room with hostUid: host1
      const meta1 = createValidMetadataRecord(code, host1Uid, now);
      await assertFails(set(ref(host1Db, `rooms/${roomId}/meta`), meta1));

      // Case B: Host 1 writes own pointer for roomId and code, but sets hostUid to host2
      await assertSucceeds(setIntentPointer(host1Db, host1Uid, roomId, code, now));
      const foreignMeta = createValidMetadataRecord(code, host2Uid, now);
      await assertFails(set(ref(host1Db, `rooms/${roomId}/meta`), foreignMeta));
    });
  });

  describe('Metadata read permissions and absent metadata probe fencing', () => {
    it('allows host to read owned existing expired metadata with or without pointer', async () => {
      const now = Date.now();
      const hostUid = uniqueUid('host');
      const roomId = uniqueRoomId('c2_expired_read');
      const code = uniqueCode();
      const hostDb = testEnv.authenticatedContext(hostUid).database();

      // Seed expired room owned by hostUid
      const expiredMeta = createValidMetadataRecord(code, hostUid, now - 100_000, {
        expiresAtMs: now - 1_000,
      });
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await set(ref(ctx.database(), `rooms/${roomId}/meta`), expiredMeta);
      });

      // Part A: Read with matching pointer
      await assertSucceeds(setIntentPointer(hostDb, hostUid, roomId, code, now));
      const snapWithPointer = await assertSucceeds(get(ref(hostDb, `rooms/${roomId}/meta`)));
      expect(snapWithPointer.exists()).toBe(true);

      // Part B: Read without pointer (pointer removed)
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await remove(ref(ctx.database(), `hosts/${hostUid}/activeRoom`));
      });
      const snapWithoutPointer = await assertSucceeds(get(ref(hostDb, `rooms/${roomId}/meta`)));
      expect(snapWithoutPointer.exists()).toBe(true);
    });

    it('denies foreign expired metadata read even if attacker crafts a matching pointer', async () => {
      const now = Date.now();
      const hostUid = uniqueUid('victim_host');
      const attackerUid = uniqueUid('attacker');
      const roomId = uniqueRoomId('c2_foreign_exp');
      const code = uniqueCode();

      // Seed expired room owned by victim_host
      const expiredMeta = createValidMetadataRecord(code, hostUid, now - 100_000, {
        expiresAtMs: now - 1_000,
      });
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await set(ref(ctx.database(), `rooms/${roomId}/meta`), expiredMeta);
      });

      const attackerDb = testEnv.authenticatedContext(attackerUid).database();

      // Attacker writes own pointer pointing to victim's roomId and code
      await assertSucceeds(setIntentPointer(attackerDb, attackerUid, roomId, code, now));

      // Attacker must still be denied read of foreign expired metadata
      await assertFails(get(ref(attackerDb, `rooms/${roomId}/meta`)));
    });

    it('preserves authenticated read of existing unexpired metadata for any player', async () => {
      const now = Date.now();
      const hostUid = uniqueUid('host');
      const guestUid = uniqueUid('guest');
      const roomId = uniqueRoomId('c2_unexpired_read');
      const code = uniqueCode();

      const hostDb = testEnv.authenticatedContext(hostUid).database();
      await assertSucceeds(setIntentPointer(hostDb, hostUid, roomId, code, now));
      const meta = createValidMetadataRecord(code, hostUid, now);
      await assertSucceeds(set(ref(hostDb, `rooms/${roomId}/meta`), meta));

      // Guest reads existing unexpired room metadata
      const guestDb = testEnv.authenticatedContext(guestUid).database();
      const snap = await assertSucceeds(get(ref(guestDb, `rooms/${roomId}/meta`)));
      expect(snap.exists()).toBe(true);
      expect(snap.val()?.code).toBe(code);
    });

    it('allows reading absent metadata ONLY when authenticated user has matching private pointer, returning exists: false', async () => {
      const now = Date.now();
      const hostUid = uniqueUid('host');
      const absentRoomId = uniqueRoomId('c2_absent_match');
      const code = uniqueCode();
      const hostDb = testEnv.authenticatedContext(hostUid).database();

      // Host sets pointer for absent room
      await assertSucceeds(setIntentPointer(hostDb, hostUid, absentRoomId, code, now));

      // Reading absent metadata with matching pointer succeeds and returns exists: false
      const snap = await assertSucceeds(get(ref(hostDb, `rooms/${absentRoomId}/meta`)));
      expect(snap.exists()).toBe(false);
    });

    it('denies absent metadata read with no pointer, wrong roomId, other UID pointer, or unauthenticated', async () => {
      const now = Date.now();
      const user1Uid = uniqueUid('user1');
      const user2Uid = uniqueUid('user2');
      const absentRoomId = uniqueRoomId('c2_absent_denied');
      const otherRoomId = uniqueRoomId('c2_other');
      const code = uniqueCode();

      const user1Db = testEnv.authenticatedContext(user1Uid).database();
      const user2Db = testEnv.authenticatedContext(user2Uid).database();
      const unauthDb = testEnv.unauthenticatedContext().database();

      // Case 1: Authenticated user with no pointer
      await assertFails(get(ref(user1Db, `rooms/${absentRoomId}/meta`)));

      // Case 2: Authenticated user with pointer to a different room
      await assertSucceeds(setIntentPointer(user1Db, user1Uid, otherRoomId, code, now));
      await assertFails(get(ref(user1Db, `rooms/${absentRoomId}/meta`)));

      // Case 3: User 2 has pointer to absentRoomId, but User 1 reads it
      await assertSucceeds(setIntentPointer(user2Db, user2Uid, absentRoomId, code, now));
      await assertFails(get(ref(user1Db, `rooms/${absentRoomId}/meta`)));

      // Case 4: Unauthenticated read
      await assertFails(get(ref(unauthDb, `rooms/${absentRoomId}/meta`)));
    });

    it('revokes missing-meta read authorization immediately when pointer is removed or replaced', async () => {
      const now = Date.now();
      const hostUid = uniqueUid('host');
      const absentRoomA = uniqueRoomId('c2_revoke_a');
      const absentRoomB = uniqueRoomId('c2_revoke_b');
      const code = uniqueCode();
      const hostDb = testEnv.authenticatedContext(hostUid).database();

      // Host has pointer to Room A
      await assertSucceeds(setIntentPointer(hostDb, hostUid, absentRoomA, code, now));
      const snapA = await assertSucceeds(get(ref(hostDb, `rooms/${absentRoomA}/meta`)));
      expect(snapA.exists()).toBe(false);

      // Part 1: Remove pointer -> fresh server-authorized read of Room A must be denied (no retained cache)
      await assertSucceeds(remove(ref(hostDb, `hosts/${hostUid}/activeRoom`)));
      const freshHostDb1 = testEnv.authenticatedContext(hostUid).database();
      await assertFails(get(ref(freshHostDb1, `rooms/${absentRoomA}/meta`)));

      // Part 2: Replace pointer with Room B -> fresh server-authorized read of Room A is denied, Room B is allowed
      await assertSucceeds(setIntentPointer(hostDb, hostUid, absentRoomB, code, now));
      const freshHostDb2 = testEnv.authenticatedContext(hostUid).database();
      await assertFails(get(ref(freshHostDb2, `rooms/${absentRoomA}/meta`)));
      const snapB = await assertSucceeds(get(ref(freshHostDb2, `rooms/${absentRoomB}/meta`)));
      expect(snapB.exists()).toBe(false);
    });

    it('preserves strict denial of root, room parent, snapshot, lease, members, and views to unauthorized users', async () => {
      const now = Date.now();
      const hostUid = uniqueUid('host');
      const intruderUid = uniqueUid('intruder');
      const roomId = uniqueRoomId('c2_tree_isolation');
      const code = uniqueCode();

      const hostDb = testEnv.authenticatedContext(hostUid).database();
      await assertSucceeds(setIntentPointer(hostDb, hostUid, roomId, code, now));
      const meta = createValidMetadataRecord(code, hostUid, now);
      await assertSucceeds(set(ref(hostDb, `rooms/${roomId}/meta`), meta));

      const intruderDb = testEnv.authenticatedContext(intruderUid).database();

      // Deny root
      await assertFails(get(ref(intruderDb, '/')));

      // Deny parent room
      await assertFails(get(ref(intruderDb, `rooms/${roomId}`)));

      // Deny snapshot
      await assertFails(get(ref(intruderDb, `rooms/${roomId}/snapshot`)));

      // Deny lease
      await assertFails(get(ref(intruderDb, `rooms/${roomId}/lease`)));

      // Deny memberSlots
      await assertFails(get(ref(intruderDb, `rooms/${roomId}/memberSlots/1`)));

      // Deny members
      await assertFails(get(ref(intruderDb, `rooms/${roomId}/members/${hostUid}`)));

      // Deny views
      await assertFails(get(ref(intruderDb, `rooms/${roomId}/views/${hostUid}`)));
    });
  });

  describe('Pointer replacement and removal fences protect active rooms', () => {
    it('denies pointer removal (deletion) while pointer references an owned open unexpired room', async () => {
      const now = Date.now();
      const hostUid = uniqueUid('host');
      const roomId = uniqueRoomId('c3_removal_lock');
      const code = uniqueCode();
      const hostDb = testEnv.authenticatedContext(hostUid).database();

      // Bootstrap open unexpired room
      await assertSucceeds(setIntentPointer(hostDb, hostUid, roomId, code, now));
      const meta = createValidMetadataRecord(code, hostUid, now, { status: 'open' });
      await assertSucceeds(set(ref(hostDb, `rooms/${roomId}/meta`), meta));

      // Deny removal via remove()
      await assertFails(remove(ref(hostDb, `hosts/${hostUid}/activeRoom`)));

      // Deny removal via set(..., null)
      await assertFails(set(ref(hostDb, `hosts/${hostUid}/activeRoom`), null));
    });

    it('denies pointer replacement with a different room while old room is owned, open, and unexpired', async () => {
      const now = Date.now();
      const hostUid = uniqueUid('host');
      const roomA = uniqueRoomId('c3_replace_a');
      const roomB = uniqueRoomId('c3_replace_b');
      const codeA = uniqueCode();
      const codeB = uniqueCode();
      const hostDb = testEnv.authenticatedContext(hostUid).database();

      // Bootstrap Room A
      await assertSucceeds(setIntentPointer(hostDb, hostUid, roomA, codeA, now));
      const metaA = createValidMetadataRecord(codeA, hostUid, now, { status: 'open' });
      await assertSucceeds(set(ref(hostDb, `rooms/${roomA}/meta`), metaA));

      // Attempt replacement with Room B while Room A is open
      await assertFails(
        set(ref(hostDb, `hosts/${hostUid}/activeRoom`), {
          roomId: roomB,
          code: codeB,
          updatedAtMs: now,
        }),
      );
    });

    it('allows pointer updates for the same room and code (heartbeat / timestamp refresh)', async () => {
      const now = Date.now();
      const hostUid = uniqueUid('host');
      const roomId = uniqueRoomId('c3_same_update');
      const code = uniqueCode();
      const hostDb = testEnv.authenticatedContext(hostUid).database();

      await assertSucceeds(setIntentPointer(hostDb, hostUid, roomId, code, now));
      const meta = createValidMetadataRecord(code, hostUid, now);
      await assertSucceeds(set(ref(hostDb, `rooms/${roomId}/meta`), meta));

      // Refresh same room pointer with fresh timestamp
      await assertSucceeds(
        set(ref(hostDb, `hosts/${hostUid}/activeRoom`), {
          roomId,
          code,
          updatedAtMs: now + 500,
        }),
      );
    });

    it('allows pointer replacement and removal after old room is closed or expired', async () => {
      const now = Date.now();
      const hostUid = uniqueUid('host');
      const roomClosed = uniqueRoomId('c3_closed_room');
      const roomExpired = uniqueRoomId('c3_expired_room');
      const roomTarget = uniqueRoomId('c3_target');
      const code1 = uniqueCode();
      const code2 = uniqueCode();
      const hostDb = testEnv.authenticatedContext(hostUid).database();

      // Case 1: Old room is closed
      await assertSucceeds(setIntentPointer(hostDb, hostUid, roomClosed, code1, now));
      await createAndCloseRoomViaAuthorizedSdk(hostDb, hostUid, roomClosed, code1, now);

      // Part 1A: Test deletion directly while pointer references the closed room
      await assertSucceeds(remove(ref(hostDb, `hosts/${hostUid}/activeRoom`)));

      // Re-establish pointer referencing the closed room to test replacement separately
      await assertSucceeds(setIntentPointer(hostDb, hostUid, roomClosed, code1, now));

      // Part 1B: Test replacement directly while pointer references the closed room
      await assertSucceeds(
        set(ref(hostDb, `hosts/${hostUid}/activeRoom`), {
          roomId: roomTarget,
          code: code2,
          updatedAtMs: now,
        }),
      );

      // Case 2: Old room is expired
      const expiredMeta = createValidMetadataRecord(code2, hostUid, now - 50_000, {
        expiresAtMs: now - 1_000,
      });
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await set(ref(ctx.database(), `rooms/${roomExpired}/meta`), expiredMeta);
      });
      await assertSucceeds(setIntentPointer(hostDb, hostUid, roomExpired, code2, now));

      // Part 2A: Test deletion directly while pointer references the expired room
      await assertSucceeds(remove(ref(hostDb, `hosts/${hostUid}/activeRoom`)));

      // Re-establish pointer referencing the expired room to test replacement separately
      await assertSucceeds(setIntentPointer(hostDb, hostUid, roomExpired, code2, now));

      // Part 2B: Test replacement directly while pointer references the expired room
      await assertSucceeds(
        set(ref(hostDb, `hosts/${hostUid}/activeRoom`), {
          roomId: roomTarget,
          code: code1,
          updatedAtMs: now,
        }),
      );
    });

    it('allows pointer replacement and removal when old pointer references non-existent metadata', async () => {
      const now = Date.now();
      const hostUid = uniqueUid('host');
      const missingRoomId = uniqueRoomId('c3_never_created');
      const targetRoomId = uniqueRoomId('c3_next');
      const code1 = uniqueCode();
      const code2 = uniqueCode();
      const hostDb = testEnv.authenticatedContext(hostUid).database();

      // Host writes pointer for room whose meta was never created
      await assertSucceeds(setIntentPointer(hostDb, hostUid, missingRoomId, code1, now));

      // Part A: Deletion directly while pointing to missing room
      await assertSucceeds(remove(ref(hostDb, `hosts/${hostUid}/activeRoom`)));

      // Re-establish pointer to missing room
      await assertSucceeds(setIntentPointer(hostDb, hostUid, missingRoomId, code1, now));

      // Part B: Replacement directly while pointing to missing room
      await assertSucceeds(
        set(ref(hostDb, `hosts/${hostUid}/activeRoom`), {
          roomId: targetRoomId,
          code: code2,
          updatedAtMs: now,
        }),
      );
    });
  });

  describe('Ordered race conditions between probing and creation', () => {
    it('ordered race: probe missing A -> replace pointer with B -> delayed metadata A create is rejected while B is intact', async () => {
      const now = Date.now();
      const hostUid = uniqueUid('host');
      const roomA = uniqueRoomId('c4_race_a');
      const roomB = uniqueRoomId('c4_race_b');
      const codeA = uniqueCode();
      const codeB = uniqueCode();
      const hostDb = testEnv.authenticatedContext(hostUid).database();

      // 1. Host registers intent for Room A
      await assertSucceeds(setIntentPointer(hostDb, hostUid, roomA, codeA, now));

      // 2. Host probes Room A missing (probe succeeds with exists: false)
      const probeSnapA = await assertSucceeds(get(ref(hostDb, `rooms/${roomA}/meta`)));
      expect(probeSnapA.exists()).toBe(false);

      // 3. Host decides to abandon Room A before writing meta and switches pointer to Room B
      await assertSucceeds(
        set(ref(hostDb, `hosts/${hostUid}/activeRoom`), {
          roomId: roomB,
          code: codeB,
          updatedAtMs: now,
        }),
      );

      // 4. Stale/delayed creation of Room A metadata arrives -> must be denied because pointer is now Room B
      const staleMetaA = createValidMetadataRecord(codeA, hostUid, now);
      await assertFails(set(ref(hostDb, `rooms/${roomA}/meta`), staleMetaA));

      // 5. Verify Room B pointer is intact and Room A metadata was not created
      const pointerSnap = await assertSucceeds(get(ref(hostDb, `hosts/${hostUid}/activeRoom`)));
      expect(pointerSnap.val()?.roomId).toBe(roomB);
      expect(pointerSnap.val()?.code).toBe(codeB);

      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const checkRoomA = await get(ref(ctx.database(), `rooms/${roomA}/meta`));
        expect(checkRoomA.exists()).toBe(false);
      });
    });

    it('reverse ordering race: probe missing A -> create metadata A -> pointer B replacement is denied until A is closed', async () => {
      const now = Date.now();
      const hostUid = uniqueUid('host');
      const roomA = uniqueRoomId('c4_rev_a');
      const roomB = uniqueRoomId('c4_rev_b');
      const codeA = uniqueCode();
      const codeB = uniqueCode();
      const leaseOwnerId = 'rt_rev_owner_1';
      const hostDb = testEnv.authenticatedContext(hostUid).database();

      // 1. Host registers intent for Room A
      await assertSucceeds(setIntentPointer(hostDb, hostUid, roomA, codeA, now));

      // 2. Host probes Room A missing
      const probeSnap = await assertSucceeds(get(ref(hostDb, `rooms/${roomA}/meta`)));
      expect(probeSnap.exists()).toBe(false);

      // 3. Host successfully creates metadata for Room A with initial status: 'open'
      const metaA = createValidMetadataRecord(codeA, hostUid, now, {
        status: 'open',
        leaseOwnerId,
      });
      await assertSucceeds(set(ref(hostDb, `rooms/${roomA}/meta`), metaA));

      // Acquire valid initial execution lease for Room A so host has live execution ownership to close it
      await assertSucceeds(
        set(ref(hostDb, `rooms/${roomA}/lease`), {
          ownerId: leaseOwnerId,
          hostUid,
          epoch: 1,
          acquiredAtMs: now,
          expiresAtMs: now + 15_000,
        }),
      );

      // 4. Room A is now open; attempting to switch pointer to Room B must be denied
      await assertFails(
        set(ref(hostDb, `hosts/${hostUid}/activeRoom`), {
          roomId: roomB,
          code: codeB,
          updatedAtMs: now,
        }),
      );

      // 5. Close Room A under live execution lease
      await assertSucceeds(
        update(ref(hostDb, `rooms/${roomA}/meta`), {
          status: 'closed',
          updatedAtMs: now,
          leaseOwnerId,
        }),
      );

      // 6. Replacing pointer with Room B and creating Room B metadata now succeeds
      await assertSucceeds(
        set(ref(hostDb, `hosts/${hostUid}/activeRoom`), {
          roomId: roomB,
          code: codeB,
          updatedAtMs: now,
        }),
      );
      const metaB = createValidMetadataRecord(codeB, hostUid, now, { status: 'open' });
      await assertSucceeds(set(ref(hostDb, `rooms/${roomB}/meta`), metaB));
    });
  });

  describe('Atomic multipath update fence against concurrent create and pointer replacement', () => {
    it('denies atomic multipath update creating metadata A while replacing pointer with B, leaving no partial mutation', async () => {
      const now = Date.now();
      const hostUid = uniqueUid('host');
      const roomA = uniqueRoomId('c5_atomic_a');
      const roomB = uniqueRoomId('c5_atomic_b');
      const codeA = uniqueCode();
      const codeB = uniqueCode();
      const hostDb = testEnv.authenticatedContext(hostUid).database();

      // Host establishes intent pointer for Room A
      await assertSucceeds(setIntentPointer(hostDb, hostUid, roomA, codeA, now));

      // Prepare adversarial multipath update attempting to commit metadata A while pointing activeRoom to B
      const metaA = createValidMetadataRecord(codeA, hostUid, now);
      const multipathPayload: Record<string, unknown> = {
        [`rooms/${roomA}/meta`]: metaA,
        [`hosts/${hostUid}/activeRoom`]: {
          roomId: roomB,
          code: codeB,
          updatedAtMs: now,
        },
      };

      // Atomic update at root must be rejected
      await assertFails(update(ref(hostDb), multipathPayload));

      // Verify NO partial mutation occurred:
      // 1. Room A metadata was NOT created (verified via authorized read under own matching active pointer)
      const checkMetaA = await assertSucceeds(get(ref(hostDb, `rooms/${roomA}/meta`)));
      expect(checkMetaA.exists()).toBe(false);

      // 2. Active pointer remains Room A
      const pointerSnap = await assertSucceeds(get(ref(hostDb, `hosts/${hostUid}/activeRoom`)));
      expect(pointerSnap.val()?.roomId).toBe(roomA);
      expect(pointerSnap.val()?.code).toBe(codeA);
    });
  });
});
