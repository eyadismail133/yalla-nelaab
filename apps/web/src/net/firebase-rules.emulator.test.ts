import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { get, ref, remove, set, update } from 'firebase/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const RULES_PATH = fileURLToPath(new URL('../../../../database.rules.json', import.meta.url));
const RULES_JSON = readFileSync(RULES_PATH, 'utf8');

const PROJECT_ID = 'demo-yalla-nelaab';
const HOST_UID = 'host-uid-1';
const GUEST_1_UID = 'guest-uid-1';
const GUEST_2_UID = 'guest-uid-2';
const INTRUDER_UID = 'intruder-uid-9';

const ROOM_ID = 'room_valid_1234567890';
const CODE = 'ABCDE';
const RUNTIME_1 = 'runtime_owner_1';
const RUNTIME_2 = 'runtime_owner_2';
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

/**
 * Performs the supported staged host room bootstrap using ONLY normal client rules
 * (no `withSecurityRulesDisabled`).
 */
async function bootstrapOpenRoom(
  nowMs = Date.now(),
  opts: {
    roomId?: string;
    code?: string;
    hostUid?: string;
    runtimeId?: string;
    skipCodeExposure?: boolean;
  } = {},
) {
  const roomId = opts.roomId ?? ROOM_ID;
  const code = opts.code ?? CODE;
  const hostUid = opts.hostUid ?? HOST_UID;
  const runtimeId = opts.runtimeId ?? RUNTIME_1;
  const hostDb = testEnv.authenticatedContext(hostUid).database();

  const expiresAtMs = nowMs + SIX_HOURS_MS - 5_000;

  // Stage 0: Install matching private intent pointer before metadata creation
  await assertSucceeds(
    set(ref(hostDb, `hosts/${hostUid}/activeRoom`), {
      roomId,
      code,
      updatedAtMs: nowMs,
    }),
  );

  // Stage 1: Create validated host-owned room meta (memberCount: 1, admittedCount: 1)
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
      leaseOwnerId: runtimeId,
    }),
  );

  // Stage 2: Acquire bounded host execution lease (epoch 1)
  await assertSucceeds(
    set(ref(hostDb, `rooms/${roomId}/lease`), {
      ownerId: runtimeId,
      hostUid,
      epoch: 1,
      acquiredAtMs: nowMs,
      expiresAtMs: nowMs + 15_000,
    }),
  );

  // Stage 2b: Reserve host admission slot '1' under live lease
  await assertSucceeds(
    set(ref(hostDb, `rooms/${roomId}/memberSlots/1`), {
      slot: '1',
      uid: hostUid,
      assignedAtMs: nowMs,
      leaseOwnerId: runtimeId,
    }),
  );

  // Stage 3: Atomically publish initial snapshot, host member binding (slot '1'), host view (slot '1'), and heartbeat
  await assertSucceeds(
    update(ref(hostDb, `rooms/${roomId}`), {
      heartbeat: {
        lastSeenAtMs: nowMs,
        connected: true,
        leaseOwnerId: runtimeId,
      },
      [`members/${hostUid}`]: {
        uid: hostUid,
        slot: '1',
        playerId: 'player_host',
        nickname: 'يوسف',
        role: 'host',
        joinedAtMs: nowMs,
        leaseOwnerId: runtimeId,
      },
      snapshot: {
        json: JSON.stringify({ code, version: 0, phase: 'lobby' }),
        version: 0,
        updatedAtMs: nowMs,
        leaseOwnerId: runtimeId,
      },
      [`views/${hostUid}`]: {
        slot: '1',
        json: JSON.stringify({ code, phase: 'lobby', you: { id: 'player_host', isHost: true } }),
        version: 0,
        updatedAtMs: nowMs,
        leaseOwnerId: runtimeId,
      },
    }),
  );

  if (!opts.skipCodeExposure) {
    // Stage 4: Expose room code mapping and host activeRoom pointer once room is ready for guests
    await assertSucceeds(
      set(ref(hostDb, `codes/${code}`), {
        roomId,
        hostUid,
        createdAtMs: nowMs,
        expiresAtMs,
      }),
    );

    await assertSucceeds(
      set(ref(hostDb, `hosts/${hostUid}/activeRoom`), {
        roomId,
        code,
        updatedAtMs: nowMs,
      }),
    );
  }

  return { hostDb, roomId, code, hostUid, runtimeId, nowMs, expiresAtMs };
}

/**
 * Helper to admit a new guest into slot `slot` ('2'..'32') using the normal client rules protocol:
 * 1. Allocate `/rooms/$roomId/memberSlots/$slot`
 * 2. Atomically publish `meta`, `members/$guestUid`, `snapshot`, `views`, and `responses/$guestUid`
 */
async function admitGuestViaHost(opts: {
  hostDb: ReturnType<ReturnType<RulesTestEnvironment['authenticatedContext']>['database']>;
  roomId?: string;
  code?: string;
  hostUid?: string;
  runtimeId?: string;
  guestUid: string;
  slot: string;
  memberCount: number;
  admittedCount: number;
  nickname: string;
  playerId: string;
  nowMs: number;
  expiresAtMs: number;
  commandId?: string;
  reqSlot?: string;
}) {
  const roomId = opts.roomId ?? ROOM_ID;
  const code = opts.code ?? CODE;
  const hostUid = opts.hostUid ?? HOST_UID;
  const runtimeId = opts.runtimeId ?? RUNTIME_1;
  const version = Number(opts.slot);
  const reqSlot = opts.reqSlot ?? '1';
  const commandId = opts.commandId ?? `cmd_join_${opts.guestUid}`;

  // Ensure matching unexpired joinRequest exists before host acknowledges it
  const guestDb = testEnv.authenticatedContext(opts.guestUid).database();
  const reqRef = ref(guestDb, `rooms/${roomId}/joinRequests/${reqSlot}`);
  const existingReq = await get(reqRef);
  if (!existingReq.exists() || existingReq.val()?.commandId !== commandId) {
    await assertSucceeds(
      set(reqRef, {
        commandId,
        uid: opts.guestUid,
        nickname: opts.nickname,
        createdAtMs: opts.nowMs,
        expiresAtMs: opts.nowMs + 10_000,
      }),
    );
  }

  // Step A: Reserve the guest's immutable admission slot
  await assertSucceeds(
    set(ref(opts.hostDb, `rooms/${roomId}/memberSlots/${opts.slot}`), {
      slot: opts.slot,
      uid: opts.guestUid,
      assignedAtMs: opts.nowMs,
      leaseOwnerId: runtimeId,
    }),
  );

  // Step B: Atomically publish updated meta, member record, snapshot, views, and joinResponses
  const updates: Record<string, unknown> = {
    meta: {
      code,
      hostUid,
      createdAtMs: opts.nowMs,
      expiresAtMs: opts.expiresAtMs,
      phase: 'lobby',
      status: 'open',
      memberCount: opts.memberCount,
      admittedCount: opts.admittedCount,
      updatedAtMs: opts.nowMs,
      leaseOwnerId: runtimeId,
    },
    [`members/${opts.guestUid}`]: {
      uid: opts.guestUid,
      slot: opts.slot,
      playerId: opts.playerId,
      nickname: opts.nickname,
      role: 'guest',
      joinedAtMs: opts.nowMs,
      leaseOwnerId: runtimeId,
    },
    snapshot: {
      json: JSON.stringify({ code, version, players: ['player_host', opts.playerId] }),
      version,
      updatedAtMs: opts.nowMs,
      leaseOwnerId: runtimeId,
    },
    [`views/${hostUid}`]: {
      slot: '1',
      json: JSON.stringify({ code, version, you: { id: 'player_host' } }),
      version,
      updatedAtMs: opts.nowMs,
      leaseOwnerId: runtimeId,
    },
    [`views/${opts.guestUid}`]: {
      slot: opts.slot,
      json: JSON.stringify({ code, version, you: { id: opts.playerId } }),
      version,
      updatedAtMs: opts.nowMs,
      leaseOwnerId: runtimeId,
    },
    [`joinResponses/${reqSlot}`]: {
      commandId,
      uid: opts.guestUid,
      ok: true,
      dataJson: JSON.stringify({ code, playerId: opts.playerId, token: `tok_${opts.playerId}` }),
      processedAtMs: opts.nowMs,
      leaseOwnerId: runtimeId,
    },
  };

  await assertSucceeds(update(ref(opts.hostDb, `rooms/${roomId}`), updates));
}

describe('Firebase Realtime Database security rules (real emulator)', () => {
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

  beforeEach(async () => {
    await testEnv.clearDatabase();
  });

  afterAll(async () => {
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  it('protects active rooms and preserves targeted expired-room cleanup', async () => {
    const now = Date.now();
    const { hostDb } = await bootstrapOpenRoom(now);
    await assertFails(remove(ref(hostDb, `rooms/${ROOM_ID}`)));
    const intruderDb = testEnv.authenticatedContext(INTRUDER_UID).database();
    await assertFails(remove(ref(intruderDb, `rooms/${ROOM_ID}`)));
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await update(ref(ctx.database(), `rooms/${ROOM_ID}/meta`), { expiresAtMs: now - 3_601_000 });
    });
    await assertSucceeds(remove(ref(hostDb, `rooms/${ROOM_ID}`)));
  });

  it('accepts one aggregate sample per room/round from the live host and rejects guest telemetry or extra identifiers', async () => {
    const now = Date.now();
    const { hostDb } = await bootstrapOpenRoom(now);
    await update(ref(hostDb, `rooms/${ROOM_ID}/meta`), { phase: 'round_result', updatedAtMs: now, leaseOwnerId: RUNTIME_1 });
    const sample = { roomId: ROOM_ID, roundNo: 1, plays: 2, answered: 1, correct: 1, totalSolveMs: 500 };
    const path = `telemetry/question_1/${ROOM_ID}_1`;
    const guestDb = testEnv.authenticatedContext(GUEST_1_UID).database();
    await assertFails(set(ref(guestDb, path), sample));
    await assertFails(set(ref(hostDb, path), { ...sample, nickname: 'must not be stored' }));
    await assertSucceeds(set(ref(hostDb, path), sample));
    await assertFails(set(ref(hostDb, path), { ...sample, correct: 0 }));
      const multiPath = `telemetry/question_2/${ROOM_ID}_1`;
      await assertFails(set(ref(hostDb, multiPath), { ...sample, roundTypeId: 'quickfire_tf', recordedAtMs: now - 120000 }));
      await assertFails(set(ref(hostDb, multiPath), { ...sample, roundTypeId: 'quickfire_tf', recordedAtMs: now, playerId: 'private' }));
      await assertSucceeds(set(ref(hostDb, multiPath), { ...sample, roundTypeId: 'quickfire_tf', recordedAtMs: now }));
      await assertFails(set(ref(hostDb, multiPath), { ...sample, roundTypeId: 'quickfire_tf', recordedAtMs: now }));
    await assertFails(get(ref(testEnv.unauthenticatedContext().database(), 'telemetry/question_1')));
  });

  it('allows full staged room bootstrap, bounded guest join slot, atomic state/view/response publication, and member commands without admin bypass', async () => {
    const now = Date.now();
    const { hostDb, expiresAtMs } = await bootstrapOpenRoom(now);

    const guest1Db = testEnv.authenticatedContext(GUEST_1_UID).database();

    // Guest looks up code and room meta
    const codeSnap = await assertSucceeds(get(ref(guest1Db, `codes/${CODE}`)));
    expect(codeSnap.val()?.roomId).toBe(ROOM_ID);

    const metaSnap = await assertSucceeds(get(ref(guest1Db, `rooms/${ROOM_ID}/meta`)));
    expect(metaSnap.val()?.phase).toBe('lobby');
    expect(metaSnap.val()?.admittedCount).toBe(1);

    // Guest submits a bounded 10-second join request in joinRequests/1 (slots '1'..'8')
    await assertSucceeds(
      set(ref(guest1Db, `rooms/${ROOM_ID}/joinRequests/1`), {
        commandId: 'cmd_join_guest1',
        uid: GUEST_1_UID,
        nickname: 'أحمد',
        createdAtMs: now,
        expiresAtMs: now + 10_000,
      }),
    );

    // Host reads room and admits guest1 into slot '2'
    const roomSnap = await assertSucceeds(get(ref(hostDb, `rooms/${ROOM_ID}`)));
    expect(roomSnap.val()?.joinRequests?.['1']?.nickname).toBe('أحمد');

    await admitGuestViaHost({
      hostDb,
      guestUid: GUEST_1_UID,
      slot: '2',
      memberCount: 2,
      admittedCount: 2,
      nickname: 'أحمد',
      playerId: 'player_guest1',
      nowMs: now,
      expiresAtMs,
      commandId: 'cmd_join_guest1',
      reqSlot: '1',
    });

    // Admitted guest reads own joinResponse, view, member record, and heartbeat
    const joinRespSnap = await assertSucceeds(get(ref(guest1Db, `rooms/${ROOM_ID}/joinResponses/1`)));
    expect(joinRespSnap.val()?.ok).toBe(true);

    const viewSnap = await assertSucceeds(get(ref(guest1Db, `rooms/${ROOM_ID}/views/${GUEST_1_UID}`)));
    expect(JSON.parse(viewSnap.val().json).you.id).toBe('player_guest1');

    const hbSnap = await assertSucceeds(get(ref(guest1Db, `rooms/${ROOM_ID}/heartbeat`)));
    expect(hbSnap.val()?.connected).toBe(true);

    await assertSucceeds(remove(ref(guest1Db, `rooms/${ROOM_ID}/joinRequests/1`)));

    // Guest writes own presence and submits a ready command, then a round:action command with roundNo
    await assertSucceeds(
      set(ref(guest1Db, `rooms/${ROOM_ID}/presence/${GUEST_1_UID}`), {
        uid: GUEST_1_UID,
        connected: true,
        updatedAtMs: now,
      }),
    );

    await assertSucceeds(
      set(ref(guest1Db, `rooms/${ROOM_ID}/commands/${GUEST_1_UID}`), {
        commandId: 'cmd_ready_1',
        uid: GUEST_1_UID,
        type: 'ready',
        payloadJson: JSON.stringify({ ready: true }),
        createdAtMs: now,
        expiresAtMs: now + 10_000,
      }),
    );

    // Host acknowledges member command in responses/GUEST_1_UID
    await assertSucceeds(
      set(ref(hostDb, `rooms/${ROOM_ID}/responses/${GUEST_1_UID}`), {
        slot: '2',
        commandId: 'cmd_ready_1',
        ok: true,
        processedAtMs: now,
        leaseOwnerId: RUNTIME_1,
      }),
    );

    const respSnap = await assertSucceeds(get(ref(guest1Db, `rooms/${ROOM_ID}/responses/${GUEST_1_UID}`)));
    expect(respSnap.val()?.ok).toBe(true);
    expect(respSnap.val()?.commandId).toBe('cmd_ready_1');

    await assertSucceeds(
      set(ref(guest1Db, `rooms/${ROOM_ID}/commands/${GUEST_1_UID}`), {
        commandId: 'cmd_action_1',
        uid: GUEST_1_UID,
        type: 'round:action',
        roundNo: 1,
        payloadJson: JSON.stringify({ kind: 'answer', choice: 2 }),
        createdAtMs: now,
        expiresAtMs: now + 10_000,
      }),
    );
  });

  it('denies root/list enumeration, unauthenticated access, cross-player reads, and guest full-room or snapshot reads', async () => {
    const now = Date.now();
    const { hostDb, expiresAtMs } = await bootstrapOpenRoom(now);

    await admitGuestViaHost({
      hostDb,
      guestUid: GUEST_1_UID,
      slot: '2',
      memberCount: 2,
      admittedCount: 2,
      nickname: 'أحمد',
      playerId: 'player_guest1',
      nowMs: now,
      expiresAtMs,
    });

    const unauthDb = testEnv.unauthenticatedContext().database();
    const guest1Db = testEnv.authenticatedContext(GUEST_1_UID).database();
    const guest2Db = testEnv.authenticatedContext(GUEST_2_UID).database();

    // Unauthenticated reads/writes denied everywhere
    await assertFails(get(ref(unauthDb, `codes/${CODE}`)));
    await assertFails(get(ref(unauthDb, `rooms/${ROOM_ID}/meta`)));

    // Root and collection enumeration denied for authenticated users
    await assertFails(get(ref(guest1Db, '/')));
    await assertFails(get(ref(guest1Db, 'codes')));
    await assertFails(get(ref(guest1Db, 'rooms')));
    await assertFails(get(ref(guest1Db, 'hosts')));
    await assertFails(get(ref(hostDb, 'codes')));
    await assertFails(get(ref(hostDb, 'rooms')));

    // Host-only parent read at /rooms/$roomId must NOT grant guest full-room read
    await assertFails(get(ref(guest1Db, `rooms/${ROOM_ID}`)));
    await assertFails(get(ref(guest1Db, `rooms/${ROOM_ID}/snapshot`)));
    await assertFails(get(ref(guest1Db, `rooms/${ROOM_ID}/lease`)));

    // Cross-player read isolation
    await assertFails(get(ref(guest1Db, `rooms/${ROOM_ID}/views/${HOST_UID}`)));
    await assertFails(get(ref(guest1Db, `rooms/${ROOM_ID}/members/${HOST_UID}`)));
    await assertSucceeds(get(ref(guest1Db, `rooms/${ROOM_ID}/memberSlots/2`))); // guest1 can read own slot 2
    await assertFails(get(ref(guest1Db, `rooms/${ROOM_ID}/memberSlots/1`))); // guest1 cannot read host slot 1
    await assertFails(get(ref(guest2Db, `rooms/${ROOM_ID}/views/${GUEST_1_UID}`)));
    await assertFails(get(ref(guest2Db, `rooms/${ROOM_ID}/responses/${GUEST_1_UID}`)));
    await assertFails(get(ref(guest2Db, `rooms/${ROOM_ID}/heartbeat`)));
  });

  it('rejects premature code reservation or guest join requests before the room is fully bootstrapped', async () => {
    const now = Date.now();
    const hostDb = testEnv.authenticatedContext(HOST_UID).database();
    const guestDb = testEnv.authenticatedContext(GUEST_1_UID).database();
    const earlyRoomId = 'room_incomplete_12345';

    // Code mapping before room exists is rejected
    await assertFails(
      set(ref(hostDb, 'codes/EARLY'), {
        roomId: earlyRoomId,
        hostUid: HOST_UID,
        createdAtMs: now,
        expiresAtMs: now + SIX_HOURS_MS - 5_000,
      }),
    );

    // Stage 0: Install matching private intent pointer before metadata creation
    await assertSucceeds(
      set(ref(hostDb, `hosts/${HOST_UID}/activeRoom`), {
        roomId: earlyRoomId,
        code: 'EARLY',
        updatedAtMs: now,
      }),
    );

    // Stage 1 only (meta created, but no lease or snapshot yet)
    await assertSucceeds(
      set(ref(hostDb, `rooms/${earlyRoomId}/meta`), {
        code: 'EARLY',
        hostUid: HOST_UID,
        createdAtMs: now,
        expiresAtMs: now + SIX_HOURS_MS - 5_000,
        phase: 'lobby',
        status: 'open',
        memberCount: 1,
        admittedCount: 1,
        updatedAtMs: now,
        leaseOwnerId: RUNTIME_1,
      }),
    );

    // Code mapping and guest join still rejected before lease + snapshot exist
    await assertFails(
      set(ref(hostDb, 'codes/EARLY'), {
        roomId: earlyRoomId,
        hostUid: HOST_UID,
        createdAtMs: now,
        expiresAtMs: now + SIX_HOURS_MS - 5_000,
      }),
    );
    await assertFails(
      set(ref(guestDb, `rooms/${earlyRoomId}/joinRequests/1`), {
        commandId: 'cmd_early_join',
        uid: GUEST_1_UID,
        nickname: 'أحمد',
        createdAtMs: now,
        expiresAtMs: now + 10_000,
      }),
    );

    const codeSnap = await assertSucceeds(get(ref(hostDb, 'codes/EARLY')));
    expect(codeSnap.exists()).toBe(false);
  });

  it('rejects unknown extra fields (with matching control writes), malformed payloads, foreign UID writes, and oversized payloads while leaving committed state intact', async () => {
    const now = Date.now();
    const { hostDb, expiresAtMs } = await bootstrapOpenRoom(now);
    const guest1Db = testEnv.authenticatedContext(GUEST_1_UID).database();
    const intruderDb = testEnv.authenticatedContext(INTRUDER_UID).database();

    await admitGuestViaHost({
      hostDb,
      guestUid: GUEST_1_UID,
      slot: '2',
      memberCount: 2,
      admittedCount: 2,
      nickname: 'أحمد',
      playerId: 'player_guest1',
      nowMs: now,
      expiresAtMs,
    });

    // Bootstrap a matching room with meta.code = 'EXTRA' (stages 1-3, before Stage 4 code write)
    const extraHostUid = 'host_extra_code_uid';
    const extraHostDb = testEnv.authenticatedContext(extraHostUid).database();
    const extraRoomId = 'room_extra_code_12345';
    await bootstrapOpenRoom(now, {
      roomId: extraRoomId,
      code: 'EXTRA',
      hostUid: extraHostUid,
      skipCodeExposure: true,
    });

    // Unknown field on /codes/EXTRA is rejected when the only difference is `extraField`
    await assertFails(
      set(ref(extraHostDb, 'codes/EXTRA'), {
        roomId: extraRoomId,
        hostUid: extraHostUid,
        createdAtMs: now,
        expiresAtMs,
        extraField: 'not-allowed',
      }),
    );
    expect((await assertSucceeds(get(ref(extraHostDb, 'codes/EXTRA')))).exists()).toBe(false);

    // Control write: exact same /codes/EXTRA record WITHOUT `extraField` succeeds
    await assertSucceeds(
      set(ref(extraHostDb, 'codes/EXTRA'), {
        roomId: extraRoomId,
        hostUid: extraHostUid,
        createdAtMs: now,
        expiresAtMs,
      }),
    );

    // Unknown field on snapshot rejected; previous version 2 remains intact
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/snapshot`), {
        json: '{"ok":true}',
        version: 3,
        updatedAtMs: now,
        leaseOwnerId: RUNTIME_1,
        unexpected: 123,
      }),
    );
    const snapBefore = await assertSucceeds(get(ref(hostDb, `rooms/${ROOM_ID}/snapshot`)));
    expect(snapBefore.val()?.version).toBe(2);

    // Foreign UID joinRequest / command spoofing rejected
    await assertFails(
      set(ref(intruderDb, `rooms/${ROOM_ID}/joinRequests/1`), {
        commandId: 'cmd_spoof',
        uid: GUEST_1_UID, // inner uid does not match intruder auth.uid
        nickname: 'هاكر',
        createdAtMs: now,
        expiresAtMs: now + 10_000,
      }),
    );
    await assertFails(
      set(ref(intruderDb, `rooms/${ROOM_ID}/joinRequests/${INTRUDER_UID}`), {
        // non-numeric slot key outside 1..8 is rejected
        commandId: 'cmd_bad_slot_key',
        uid: INTRUDER_UID,
        nickname: 'هاكر',
        createdAtMs: now,
        expiresAtMs: now + 10_000,
      }),
    );
    await assertFails(
      set(ref(intruderDb, `rooms/${ROOM_ID}/commands/${INTRUDER_UID}`), {
        commandId: 'cmd_nonmember',
        uid: INTRUDER_UID,
        type: 'ready',
        payloadJson: '{}',
        createdAtMs: now,
        expiresAtMs: now + 10_000,
      }),
    );

    // Guest attempting to write host-owned nodes (snapshot, views, members, meta, heartbeat, responses) rejected
    await assertFails(
      set(ref(guest1Db, `rooms/${ROOM_ID}/snapshot`), {
        json: '{"hacked":true}',
        version: 99,
        updatedAtMs: now,
        leaseOwnerId: RUNTIME_1,
      }),
    );
    await assertFails(
      set(ref(guest1Db, `rooms/${ROOM_ID}/views/${GUEST_1_UID}`), {
        slot: '2',
        json: '{"hacked":true}',
        version: 99,
        updatedAtMs: now,
        leaseOwnerId: RUNTIME_1,
      }),
    );

    // Nickname > 16 chars rejected
    await assertFails(
      set(ref(intruderDb, `rooms/${ROOM_ID}/joinRequests/1`), {
        commandId: 'cmd_long_name',
        uid: INTRUDER_UID,
        nickname: '١٢٣٤٥٦٧٨٩٠١٢٣٤٥٦٧', // 17 chars
        createdAtMs: now,
        expiresAtMs: now + 10_000,
      }),
    );

    // round:action without roundNo rejected
    await assertFails(
      set(ref(guest1Db, `rooms/${ROOM_ID}/commands/${GUEST_1_UID}`), {
        commandId: 'cmd_no_round',
        uid: GUEST_1_UID,
        type: 'round:action',
        payloadJson: '{"kind":"answer","choice":0}',
        createdAtMs: now,
        expiresAtMs: now + 10_000,
      }),
    );

    // Oversized payloads rejected (command > 8KiB, view > 256KiB, snapshot > 512KiB)
    await assertFails(
      set(ref(guest1Db, `rooms/${ROOM_ID}/commands/${GUEST_1_UID}`), {
        commandId: 'cmd_big_payload',
        uid: GUEST_1_UID,
        type: 'ready',
        payloadJson: 'x'.repeat(8193),
        createdAtMs: now,
        expiresAtMs: now + 10_000,
      }),
    );
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/views/${GUEST_1_UID}`), {
        slot: '2',
        json: 'v'.repeat(262_145),
        version: 3,
        updatedAtMs: now,
        leaseOwnerId: RUNTIME_1,
      }),
    );
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/snapshot`), {
        json: 's'.repeat(524_289),
        version: 3,
        updatedAtMs: now,
        leaseOwnerId: RUNTIME_1,
      }),
    );
  });

  it('enforces server-anchored creation timestamps, <=6h expiry bound, immutable metadata, and 10s command/join expiry', async () => {
    const now = Date.now();
    const { hostDb, expiresAtMs } = await bootstrapOpenRoom(now);
    const guest1Db = testEnv.authenticatedContext(GUEST_1_UID).database();

    // Future-dated room creation (1 year in future) rejected
    const futureHostUid = 'host-future-uid';
    const futureHostDb = testEnv.authenticatedContext(futureHostUid).database();
    await assertSucceeds(
      set(ref(futureHostDb, `hosts/${futureHostUid}/activeRoom`), {
        roomId: 'room_future_123456',
        code: 'FUTUR',
        updatedAtMs: now,
      }),
    );
    const oneYearFuture = now + 365 * 24 * 60 * 60 * 1_000;
    await assertFails(
      set(ref(futureHostDb, 'rooms/room_future_123456/meta'), {
        code: 'FUTUR',
        hostUid: futureHostUid,
        createdAtMs: oneYearFuture,
        expiresAtMs: oneYearFuture + SIX_HOURS_MS,
        phase: 'lobby',
        status: 'open',
        memberCount: 1,
        admittedCount: 1,
        updatedAtMs: oneYearFuture,
        leaseOwnerId: RUNTIME_1,
      }),
    );
    // Control write: same host with valid timestamps succeeds
    await assertSucceeds(
      set(ref(futureHostDb, 'rooms/room_future_123456/meta'), {
        code: 'FUTUR',
        hostUid: futureHostUid,
        createdAtMs: now,
        expiresAtMs: now + SIX_HOURS_MS - 5_000,
        phase: 'lobby',
        status: 'open',
        memberCount: 1,
        admittedCount: 1,
        updatedAtMs: now,
        leaseOwnerId: RUNTIME_1,
      }),
    );

    // Room expiry > 6h from now rejected
    const longttlHostUid = 'host-longttl-uid';
    const longttlHostDb = testEnv.authenticatedContext(longttlHostUid).database();
    await assertSucceeds(
      set(ref(longttlHostDb, `hosts/${longttlHostUid}/activeRoom`), {
        roomId: 'room_longttl_12345',
        code: 'LONGT',
        updatedAtMs: now,
      }),
    );
    await assertFails(
      set(ref(longttlHostDb, 'rooms/room_longttl_12345/meta'), {
        code: 'LONGT',
        hostUid: longttlHostUid,
        createdAtMs: now,
        expiresAtMs: now + SIX_HOURS_MS + 60_000,
        phase: 'lobby',
        status: 'open',
        memberCount: 1,
        admittedCount: 1,
        updatedAtMs: now,
        leaseOwnerId: RUNTIME_1,
      }),
    );
    // Control write: same host with valid <=6h TTL succeeds
    await assertSucceeds(
      set(ref(longttlHostDb, 'rooms/room_longttl_12345/meta'), {
        code: 'LONGT',
        hostUid: longttlHostUid,
        createdAtMs: now,
        expiresAtMs: now + SIX_HOURS_MS - 5_000,
        phase: 'lobby',
        status: 'open',
        memberCount: 1,
        admittedCount: 1,
        updatedAtMs: now,
        leaseOwnerId: RUNTIME_1,
      }),
    );

    // Mutating immutable meta fields (hostUid, code, createdAtMs, expiresAtMs) on update rejected
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/meta`), {
        code: 'OTHER',
        hostUid: HOST_UID,
        createdAtMs: now,
        expiresAtMs,
        phase: 'lobby',
        status: 'open',
        memberCount: 1,
        admittedCount: 1,
        updatedAtMs: now,
        leaseOwnerId: RUNTIME_1,
      }),
    );
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/meta`), {
        code: CODE,
        hostUid: HOST_UID,
        createdAtMs: now,
        expiresAtMs: expiresAtMs + 10_000,
        phase: 'lobby',
        status: 'open',
        memberCount: 1,
        admittedCount: 1,
        updatedAtMs: now,
        leaseOwnerId: RUNTIME_1,
      }),
    );

    // Stale offline-queued joinRequest (expiresAtMs already in the past) or lifetime > 10s rejected
    await assertFails(
      set(ref(guest1Db, `rooms/${ROOM_ID}/joinRequests/1`), {
        commandId: 'cmd_expired_join',
        uid: GUEST_1_UID,
        nickname: 'أحمد',
        createdAtMs: now - 12_000,
        expiresAtMs: now - 2_000,
      }),
    );
    await assertFails(
      set(ref(guest1Db, `rooms/${ROOM_ID}/joinRequests/1`), {
        commandId: 'cmd_long_join',
        uid: GUEST_1_UID,
        nickname: 'أحمد',
        createdAtMs: now,
        expiresAtMs: now + 30_000, // > 10s lifetime
      }),
    );
  });

  it('fences all host writes and room/code deletions by live lease, blocks takeover of a live lease even if heartbeat.connected=false, and prevents >60s resurrection', async () => {
    const now = Date.now();
    const { hostDb, expiresAtMs } = await bootstrapOpenRoom(now);

    await admitGuestViaHost({
      hostDb,
      guestUid: GUEST_1_UID,
      slot: '2',
      memberCount: 2,
      admittedCount: 2,
      nickname: 'أحمد',
      playerId: 'player_guest1',
      nowMs: now,
      expiresAtMs,
    });

    // Active leaseholder can renew its own live lease with matching epoch and bounded duration (<=20s)
    await assertSucceeds(
      set(ref(hostDb, `rooms/${ROOM_ID}/lease`), {
        ownerId: RUNTIME_1,
        hostUid: HOST_UID,
        epoch: 1,
        acquiredAtMs: now,
        expiresAtMs: now + 18_000,
      }),
    );

    // Lease renewal with duration > 20s or mutated epoch is rejected
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/lease`), {
        ownerId: RUNTIME_1,
        hostUid: HOST_UID,
        epoch: 1,
        acquiredAtMs: now,
        expiresAtMs: now + 25_000,
      }),
    );
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/lease`), {
        ownerId: RUNTIME_1,
        hostUid: HOST_UID,
        epoch: 2,
        acquiredAtMs: now,
        expiresAtMs: now + 15_000,
      }),
    );

    // 1. Stale runtime owner cannot publish or delete snapshot, views, members, responses, meta, heartbeat, or active room/code
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/snapshot`), {
        json: '{"stale":true}',
        version: 3,
        updatedAtMs: now,
        leaseOwnerId: 'stale_runtime_99',
      }),
    );
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/views/${GUEST_1_UID}`), {
        slot: '2',
        json: '{"stale":true}',
        version: 3,
        updatedAtMs: now,
        leaseOwnerId: 'stale_runtime_99',
      }),
    );
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/members/${GUEST_1_UID}`), {
        uid: GUEST_1_UID,
        slot: '2',
        playerId: 'player_guest1',
        nickname: 'أحمد',
        role: 'guest',
        joinedAtMs: now,
        removed: true,
        leaseOwnerId: 'stale_runtime_99',
      }),
    );
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/responses/${GUEST_1_UID}`), {
        slot: '2',
        commandId: 'cmd_stale',
        ok: false,
        error: 'stale',
        processedAtMs: now,
        leaseOwnerId: 'stale_runtime_99',
      }),
    );
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/heartbeat`), {
        lastSeenAtMs: now,
        connected: true,
        leaseOwnerId: 'stale_runtime_99',
      }),
    );
    await assertFails(remove(ref(hostDb, `rooms/${ROOM_ID}/members/${GUEST_1_UID}`)));
    await assertFails(remove(ref(hostDb, `rooms/${ROOM_ID}/views/${GUEST_1_UID}`)));
    await assertFails(remove(ref(hostDb, `rooms/${ROOM_ID}/responses/${GUEST_1_UID}`)));
    await assertFails(remove(ref(hostDb, `rooms/${ROOM_ID}`)));
    await assertFails(remove(ref(hostDb, `codes/${CODE}`)));

    // 2. Even if heartbeat.connected becomes false (e.g. brief disconnect), a competing runtime
    // CANNOT overwrite a still-live lease (`lease.expiresAtMs > now`)
    await assertSucceeds(
      set(ref(hostDb, `rooms/${ROOM_ID}/heartbeat`), {
        lastSeenAtMs: now,
        connected: false,
        leaseOwnerId: RUNTIME_1,
      }),
    );
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/lease`), {
        ownerId: RUNTIME_2,
        hostUid: HOST_UID,
        epoch: 2,
        acquiredAtMs: now,
        expiresAtMs: now + 15_000,
      }),
    );
    const leaseStill1 = await assertSucceeds(get(ref(hostDb, `rooms/${ROOM_ID}/lease`)));
    expect(leaseStill1.val()?.ownerId).toBe(RUNTIME_1);

    // 3. Seed an expired lease (expired 5s ago, within 60s recovery window) using admin fixture
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await set(ref(ctx.database(), `rooms/${ROOM_ID}/lease`), {
        ownerId: RUNTIME_1,
        hostUid: HOST_UID,
        epoch: 1,
        acquiredAtMs: now - 20_000,
        expiresAtMs: now - 5_000,
      });
    });

    // Old runtime CANNOT publish snapshot/views/members/responses/heartbeat/meta with an expired lease,
    // nor self-renew its expired lease
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/snapshot`), {
        json: '{"expiredLeaseWrite":true}',
        version: 3,
        updatedAtMs: now,
        leaseOwnerId: RUNTIME_1,
      }),
    );
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/views/${GUEST_1_UID}`), {
        slot: '2',
        json: '{"expiredLeaseWrite":true}',
        version: 3,
        updatedAtMs: now,
        leaseOwnerId: RUNTIME_1,
      }),
    );
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/heartbeat`), {
        lastSeenAtMs: now,
        connected: true,
        leaseOwnerId: RUNTIME_1,
      }),
    );
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/lease`), {
        ownerId: RUNTIME_1,
        hostUid: HOST_UID,
        epoch: 1,
        acquiredAtMs: now - 20_000,
        expiresAtMs: now + 15_000,
      }),
    );

    // Successor runtime (RUNTIME_2) must increment epoch by 1 (epoch: 3 is rejected, epoch: 2 succeeds)
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/lease`), {
        ownerId: RUNTIME_2,
        hostUid: HOST_UID,
        epoch: 3,
        acquiredAtMs: now,
        expiresAtMs: now + 15_000,
      }),
    );
    await assertSucceeds(
      set(ref(hostDb, `rooms/${ROOM_ID}/lease`), {
        ownerId: RUNTIME_2,
        hostUid: HOST_UID,
        epoch: 2,
        acquiredAtMs: now,
        expiresAtMs: now + 15_000,
      }),
    );
    await assertSucceeds(
      set(ref(hostDb, `rooms/${ROOM_ID}/meta`), {
        code: CODE,
        hostUid: HOST_UID,
        createdAtMs: now,
        expiresAtMs,
        phase: 'lobby',
        status: 'open',
        memberCount: 2,
        admittedCount: 2,
        updatedAtMs: now,
        leaseOwnerId: RUNTIME_2,
      }),
    );

    // Old runtime RUNTIME_1 (including queued heartbeat/snapshot writes) is fenced out while RUNTIME_2's lease is live
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/snapshot`), {
        json: '{"fromOldRuntime":true}',
        version: 3,
        updatedAtMs: now,
        leaseOwnerId: RUNTIME_1,
      }),
    );
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/heartbeat`), {
        lastSeenAtMs: now,
        connected: true,
        leaseOwnerId: RUNTIME_1,
      }),
    );
    const committedView = await assertSucceeds(get(ref(hostDb, `rooms/${ROOM_ID}/views/${GUEST_1_UID}`)));
    expect(committedView.val()?.version).toBe(2);

    // 4. After >60s without host pulse, neither old queued writes nor a new runtime can resurrect the room
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await update(ref(ctx.database(), `rooms/${ROOM_ID}`), {
        lease: {
          ownerId: RUNTIME_2,
          hostUid: HOST_UID,
          epoch: 2,
          acquiredAtMs: now - 80_000,
          expiresAtMs: now - 65_000,
        },
        heartbeat: {
          lastSeenAtMs: now - 70_000,
          connected: false,
          leaseOwnerId: RUNTIME_2,
        },
      });
    });

    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/lease`), {
        ownerId: 'runtime_owner_3',
        hostUid: HOST_UID,
        epoch: 3,
        acquiredAtMs: now,
        expiresAtMs: now + 15_000,
      }),
    );
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/heartbeat`), {
        lastSeenAtMs: now,
        connected: true,
        leaseOwnerId: RUNTIME_2,
      }),
    );

    // Host can close the abandoned room and then delete the closed code & room records
    await assertSucceeds(
      set(ref(hostDb, `rooms/${ROOM_ID}/meta`), {
        code: CODE,
        hostUid: HOST_UID,
        createdAtMs: now,
        expiresAtMs,
        phase: 'lobby',
        status: 'closed',
        closedReason: 'انتهت مهلة اتصال الهوست',
        memberCount: 1,
        admittedCount: 2,
        updatedAtMs: now,
        leaseOwnerId: RUNTIME_2,
      }),
    );
    await assertSucceeds(remove(ref(hostDb, `codes/${CODE}`)));
    await assertSucceeds(remove(ref(hostDb, `rooms/${ROOM_ID}`)));
  });

  it('enforces 8-player room capacity, member removal revocation, and expired-room denial/cleanup', async () => {
    const now = Date.now();
    const { hostDb, expiresAtMs } = await bootstrapOpenRoom(now);
    const guest1Db = testEnv.authenticatedContext(GUEST_1_UID).database();
    const guest9Db = testEnv.authenticatedContext(INTRUDER_UID).database();

    await admitGuestViaHost({
      hostDb,
      guestUid: GUEST_1_UID,
      slot: '2',
      memberCount: 2,
      admittedCount: 2,
      nickname: 'أحمد',
      playerId: 'player_guest1',
      nowMs: now,
      expiresAtMs,
    });

    // memberCount > 8 or < 1 is rejected on meta
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/meta`), {
        code: CODE,
        hostUid: HOST_UID,
        createdAtMs: now,
        expiresAtMs,
        phase: 'lobby',
        status: 'open',
        memberCount: 9,
        admittedCount: 2,
        updatedAtMs: now,
        leaseOwnerId: RUNTIME_1,
      }),
    );
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/meta`), {
        code: CODE,
        hostUid: HOST_UID,
        createdAtMs: now,
        expiresAtMs,
        phase: 'lobby',
        status: 'open',
        memberCount: 0,
        admittedCount: 2,
        updatedAtMs: now,
        leaseOwnerId: RUNTIME_1,
      }),
    );

    // Set memberCount to 8 (full room)
    await assertSucceeds(
      set(ref(hostDb, `rooms/${ROOM_ID}/meta`), {
        code: CODE,
        hostUid: HOST_UID,
        createdAtMs: now,
        expiresAtMs,
        phase: 'lobby',
        status: 'open',
        memberCount: 8,
        admittedCount: 2,
        updatedAtMs: now,
        leaseOwnerId: RUNTIME_1,
      }),
    );

    // 9th non-member player joinRequest is rejected when room is full (memberCount === 8)
    await assertFails(
      set(ref(guest9Db, `rooms/${ROOM_ID}/joinRequests/1`), {
        commandId: 'cmd_join_9th',
        uid: INTRUDER_UID,
        nickname: 'لاعب ٩',
        createdAtMs: now,
        expiresAtMs: now + 10_000,
      }),
    );

    // Existing active member (guest1) retrying their own joinRequest is allowed even when memberCount === 8
    await assertSucceeds(
      set(ref(guest1Db, `rooms/${ROOM_ID}/joinRequests/1`), {
        commandId: 'cmd_join_retry_guest1',
        uid: GUEST_1_UID,
        nickname: 'أحمد',
        createdAtMs: now,
        expiresAtMs: now + 10_000,
      }),
    );

    // When host marks guest1 as removed (kicked/left), guest1 immediately loses view/heartbeat read and command/presence write access
    await assertSucceeds(
      set(ref(hostDb, `rooms/${ROOM_ID}/members/${GUEST_1_UID}`), {
        uid: GUEST_1_UID,
        slot: '2',
        playerId: 'player_guest1',
        nickname: 'أحمد',
        role: 'guest',
        joinedAtMs: now,
        removed: true,
        leaseOwnerId: RUNTIME_1,
      }),
    );
    await assertFails(get(ref(guest1Db, `rooms/${ROOM_ID}/views/${GUEST_1_UID}`)));
    await assertFails(get(ref(guest1Db, `rooms/${ROOM_ID}/heartbeat`)));
    await assertFails(
      set(ref(guest1Db, `rooms/${ROOM_ID}/commands/${GUEST_1_UID}`), {
        commandId: 'cmd_after_kick',
        uid: GUEST_1_UID,
        type: 'ready',
        payloadJson: '{}',
        createdAtMs: now,
        expiresAtMs: now + 10_000,
      }),
    );
    await assertFails(
      set(ref(guest1Db, `rooms/${ROOM_ID}/presence/${GUEST_1_UID}`), {
        uid: GUEST_1_UID,
        connected: true,
        updatedAtMs: now,
      }),
    );

    // Seed an expired room (>6h old) via admin fixture to verify expiry enforcement and cleanup
    const expiredRoomId = 'room_expired_1234567';
    const expiredCode = 'EXPIR';
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await set(ref(db, `rooms/${expiredRoomId}/meta`), {
        code: expiredCode,
        hostUid: HOST_UID,
        createdAtMs: now - SIX_HOURS_MS - 10_000,
        expiresAtMs: now - 10_000,
        phase: 'lobby',
        status: 'open',
        memberCount: 2,
        admittedCount: 2,
        updatedAtMs: now - 20_000,
        leaseOwnerId: RUNTIME_1,
      });
      await set(ref(db, `codes/${expiredCode}`), {
        roomId: expiredRoomId,
        hostUid: HOST_UID,
        createdAtMs: now - SIX_HOURS_MS - 10_000,
        expiresAtMs: now - 10_000,
      });
    });

    // Reads and writes to expired room fail
    await assertFails(get(ref(guest9Db, `codes/${expiredCode}`)));
    await assertFails(get(ref(guest9Db, `rooms/${expiredRoomId}/meta`)));
    await assertFails(get(ref(hostDb, `rooms/${expiredRoomId}`)));

    // Lazy cleanup of expired code and room succeeds
    await assertSucceeds(remove(ref(guest9Db, `codes/${expiredCode}`)));
    await assertSucceeds(remove(ref(guest9Db, `rooms/${expiredRoomId}`)));
  });

  it('enforces the 32-historical-UID room cap, reuses existing slot on same-UID rejoin without consuming fresh slots, and bounds joinRequests to 8 slots', async () => {
    const now = Date.now();
    const { hostDb, expiresAtMs } = await bootstrapOpenRoom(now);
    const guest1Db = testEnv.authenticatedContext(GUEST_1_UID).database();
    const guest2Db = testEnv.authenticatedContext(GUEST_2_UID).database();

    // 1. Bounded joinRequests slots (1..8): slot 9 or arbitrary key is rejected; active unanswered slot 1 blocks overwrite by another guest
    await assertFails(
      set(ref(guest1Db, `rooms/${ROOM_ID}/joinRequests/9`), {
        commandId: 'cmd_slot9',
        uid: GUEST_1_UID,
        nickname: 'أحمد',
        createdAtMs: now,
        expiresAtMs: now + 10_000,
      }),
    );

    await assertSucceeds(
      set(ref(guest1Db, `rooms/${ROOM_ID}/joinRequests/1`), {
        commandId: 'cmd_slot1_guest1',
        uid: GUEST_1_UID,
        nickname: 'أحمد',
        createdAtMs: now,
        expiresAtMs: now + 10_000,
      }),
    );

    // While guest1's request in slot 1 is unanswered and unexpired, guest2 cannot overwrite slot 1,
    // nor can guest2 read guest1's active request in slot 1
    await assertFails(get(ref(guest2Db, `rooms/${ROOM_ID}/joinRequests/1`)));
    await assertFails(
      set(ref(guest2Db, `rooms/${ROOM_ID}/joinRequests/1`), {
        commandId: 'cmd_slot1_guest2_hijack',
        uid: GUEST_2_UID,
        nickname: 'سارة',
        createdAtMs: now,
        expiresAtMs: now + 10_000,
      }),
    );

    // Once host answers slot 1 in joinResponses/1 (e.g. rejected nickname or admitted), slot 1 is immediately reclaimable by guest2
    await assertSucceeds(
      set(ref(hostDb, `rooms/${ROOM_ID}/joinResponses/1`), {
        commandId: 'cmd_slot1_guest1',
        uid: GUEST_1_UID,
        ok: false,
        error: 'الاسم ده مستخدم في الغرفة',
        processedAtMs: now,
        leaseOwnerId: RUNTIME_1,
      }),
    );
    await assertSucceeds(
      set(ref(guest2Db, `rooms/${ROOM_ID}/joinRequests/1`), {
        commandId: 'cmd_slot1_guest2',
        uid: GUEST_2_UID,
        nickname: 'سارة',
        createdAtMs: now,
        expiresAtMs: now + 10_000,
      }),
    );

    // 2. Admit guest1 into slot '2' using reqSlot '2' (since slot '1' has guest2's request), then remove/kick guest1 (tombstone removed: true), then rejoin guest1
    await admitGuestViaHost({
      hostDb,
      guestUid: GUEST_1_UID,
      slot: '2',
      memberCount: 2,
      admittedCount: 2,
      nickname: 'أحمد',
      playerId: 'player_guest1_first',
      nowMs: now,
      expiresAtMs,
      reqSlot: '2',
    });

    // Tombstone guest1 (kick/leave)
    await assertSucceeds(
      update(ref(hostDb, `rooms/${ROOM_ID}`), {
        meta: {
          code: CODE,
          hostUid: HOST_UID,
          createdAtMs: now,
          expiresAtMs,
          phase: 'lobby',
          status: 'open',
          memberCount: 1,
          admittedCount: 2,
          updatedAtMs: now,
          leaseOwnerId: RUNTIME_1,
        },
        [`members/${GUEST_1_UID}`]: {
          uid: GUEST_1_UID,
          slot: '2',
          playerId: 'player_guest1_first',
          nickname: 'أحمد',
          role: 'guest',
          joinedAtMs: now,
          removed: true,
          leaseOwnerId: RUNTIME_1,
        },
      }),
    );

    // Attempting to allocate a fresh slot '3' for already-known GUEST_1_UID is rejected by rules!
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/memberSlots/3`), {
        slot: '3',
        uid: GUEST_1_UID,
        assignedAtMs: now,
        leaseOwnerId: RUNTIME_1,
      }),
    );

    // Guest1 submits rejoin request in joinRequests/2
    await assertSucceeds(
      set(ref(guest1Db, `rooms/${ROOM_ID}/joinRequests/2`), {
        commandId: 'cmd_rejoin_guest1',
        uid: GUEST_1_UID,
        nickname: 'أحمد ٢',
        createdAtMs: now,
        expiresAtMs: now + 10_000,
      }),
    );

    // Rejoining GUEST_1_UID by reusing original slot '2' (without incrementing admittedCount) succeeds!
    await assertSucceeds(
      update(ref(hostDb, `rooms/${ROOM_ID}`), {
        meta: {
          code: CODE,
          hostUid: HOST_UID,
          createdAtMs: now,
          expiresAtMs,
          phase: 'lobby',
          status: 'open',
          memberCount: 2,
          admittedCount: 2,
          updatedAtMs: now,
          leaseOwnerId: RUNTIME_1,
        },
        [`members/${GUEST_1_UID}`]: {
          uid: GUEST_1_UID,
          slot: '2',
          playerId: 'player_guest1_rejoined',
          nickname: 'أحمد ٢',
          role: 'guest',
          joinedAtMs: now + 100,
          removed: false,
          leaseOwnerId: RUNTIME_1,
        },
        [`views/${GUEST_1_UID}`]: {
          slot: '2',
          json: JSON.stringify({ code: CODE, version: 3, you: { id: 'player_guest1_rejoined' } }),
          version: 3,
          updatedAtMs: now,
          leaseOwnerId: RUNTIME_1,
        },
        [`joinResponses/2`]: {
          commandId: 'cmd_rejoin_guest1',
          uid: GUEST_1_UID,
          ok: true,
          dataJson: JSON.stringify({ code: CODE, playerId: 'player_guest1_rejoined', token: 'tok_rejoin' }),
          processedAtMs: now,
          leaseOwnerId: RUNTIME_1,
        },
      }),
    );

    // Clean up joinRequests/2 so slot 2 is clean for subsequent testing
    await assertSucceeds(remove(ref(guest1Db, `rooms/${ROOM_ID}/joinRequests/2`)));

    // 3. Seed room at the 32-historical-UID cap (slots '1'..'32' filled, admittedCount = 32, active memberCount = 2)
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      const slotUpdates: Record<string, unknown> = {};
      for (let s = 3; s <= 32; s += 1) {
        const slotKey = String(s);
        const uid = `hist-uid-${s}`;
        slotUpdates[`memberSlots/${slotKey}`] = {
          slot: slotKey,
          uid,
          assignedAtMs: now,
          leaseOwnerId: RUNTIME_1,
        };
        slotUpdates[`members/${uid}`] = {
          uid,
          slot: slotKey,
          playerId: `player_${s}`,
          nickname: `لاعب ${s}`,
          role: 'guest',
          joinedAtMs: now,
          removed: true,
          leaseOwnerId: RUNTIME_1,
        };
      }
      slotUpdates.meta = {
        code: CODE,
        hostUid: HOST_UID,
        createdAtMs: now,
        expiresAtMs,
        phase: 'lobby',
        status: 'open',
        memberCount: 2, // active capacity is NOT full (2 < 8), but historical cap is reached (32 === 32)
        admittedCount: 32,
        updatedAtMs: now,
        leaseOwnerId: RUNTIME_1,
      };
      await update(ref(db, `rooms/${ROOM_ID}`), slotUpdates);
    });

    const uid33 = 'guest-uid-33';
    const guest33Db = testEnv.authenticatedContext(uid33).database();

    // 33rd distinct UID cannot submit a joinRequest when admittedCount === 32
    await assertFails(
      set(ref(guest33Db, `rooms/${ROOM_ID}/joinRequests/2`), {
        commandId: 'cmd_join_33rd',
        uid: uid33,
        nickname: 'لاعب ٣٣',
        createdAtMs: now,
        expiresAtMs: now + 10_000,
      }),
    );

    // Already-admitted UID (GUEST_1_UID, slot '2') CAN still submit a joinRequest when admittedCount === 32
    await assertSucceeds(
      set(ref(guest1Db, `rooms/${ROOM_ID}/joinRequests/2`), {
        commandId: 'cmd_join_existing_at_cap',
        uid: GUEST_1_UID,
        nickname: 'أحمد ٢',
        createdAtMs: now,
        expiresAtMs: now + 10_000,
      }),
    );

    // Even if host tries to allocate slot '33', overwrite slot '2' with uid33, increment admittedCount to 33,
    // or write members/views/responses for uid33 claiming slot '2' or '33', all are rejected by rules!
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/memberSlots/33`), {
        slot: '33',
        uid: uid33,
        assignedAtMs: now,
        leaseOwnerId: RUNTIME_1,
      }),
    );
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/memberSlots/2`), {
        slot: '2',
        uid: uid33,
        assignedAtMs: now,
        leaseOwnerId: RUNTIME_1,
      }),
    );
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/meta`), {
        code: CODE,
        hostUid: HOST_UID,
        createdAtMs: now,
        expiresAtMs,
        phase: 'lobby',
        status: 'open',
        memberCount: 3,
        admittedCount: 33,
        updatedAtMs: now,
        leaseOwnerId: RUNTIME_1,
      }),
    );
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/members/${uid33}`), {
        uid: uid33,
        slot: '2',
        playerId: 'player_33',
        nickname: 'لاعب ٣٣',
        role: 'guest',
        joinedAtMs: now,
        leaseOwnerId: RUNTIME_1,
      }),
    );
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/views/${uid33}`), {
        slot: '2',
        json: '{"illegal":true}',
        version: 4,
        updatedAtMs: now,
        leaseOwnerId: RUNTIME_1,
      }),
    );
    await assertFails(
      set(ref(hostDb, `rooms/${ROOM_ID}/responses/${uid33}`), {
        slot: '2',
        commandId: 'cmd_illegal_33',
        ok: true,
        processedAtMs: now,
        leaseOwnerId: RUNTIME_1,
      }),
    );

    // Verify committed slot '2' and meta.admittedCount remain unchanged
    const slot2Snap = await assertSucceeds(get(ref(hostDb, `rooms/${ROOM_ID}/memberSlots/2`)));
    expect(slot2Snap.val()?.uid).toBe(GUEST_1_UID);
    const metaAtCap = await assertSucceeds(get(ref(hostDb, `rooms/${ROOM_ID}/meta`)));
    expect(metaAtCap.val()?.admittedCount).toBe(32);
  });

  it('rejects late atomic snapshot and ok:true response publication when command or join request has expired, while allowing unexpired success and expired failure notices', async () => {
    const now = Date.now();
    const { hostDb, expiresAtMs } = await bootstrapOpenRoom(now);
    const guest1Db = testEnv.authenticatedContext(GUEST_1_UID).database();
    const guest2Db = testEnv.authenticatedContext(GUEST_2_UID).database();

    // Admit guest1 into slot '2' (uses reqSlot '1')
    await admitGuestViaHost({
      hostDb,
      guestUid: GUEST_1_UID,
      slot: '2',
      memberCount: 2,
      admittedCount: 2,
      nickname: 'أحمد',
      playerId: 'player_guest1',
      nowMs: now,
      expiresAtMs,
      reqSlot: '1',
    });

    // Clean up joinRequests/1 after join
    await assertSucceeds(remove(ref(guest1Db, `rooms/${ROOM_ID}/joinRequests/1`)));

    // --- PART 1: Member command expiration regression ---

    // Guest1 posts a short-lived member command expiring in 500ms
    const sendTime = Date.now();
    const shortCommandExpiresAtMs = sendTime + 500;
    await assertSucceeds(
      set(ref(guest1Db, `rooms/${ROOM_ID}/commands/${GUEST_1_UID}`), {
        commandId: 'cmd_short_lived',
        uid: GUEST_1_UID,
        type: 'ready',
        payloadJson: JSON.stringify({ ready: true }),
        createdAtMs: sendTime,
        expiresAtMs: shortCommandExpiresAtMs,
      }),
    );

    // Wait 650ms so the command is strictly expired in the database (now > expiresAtMs)
    await new Promise((resolve) => setTimeout(resolve, 650));
    const lateTime = Date.now();

    // Host attempts atomic update: snapshot version 10 + ok:true response for expired command
    // Rules MUST reject the entire update!
    await assertFails(
      update(ref(hostDb, `rooms/${ROOM_ID}`), {
        snapshot: {
          json: JSON.stringify({ version: 10, phase: 'in_round' }),
          version: 10,
          updatedAtMs: lateTime,
          leaseOwnerId: RUNTIME_1,
        },
        [`responses/${GUEST_1_UID}`]: {
          slot: '2',
          commandId: 'cmd_short_lived',
          ok: true,
          processedAtMs: lateTime,
          leaseOwnerId: RUNTIME_1,
        },
      }),
    );

    // Verify snapshot version was NOT updated (remains at initial version 2 from admitGuestViaHost)
    const snapAfterLate = await assertSucceeds(get(ref(hostDb, `rooms/${ROOM_ID}/snapshot`)));
    expect(snapAfterLate.val()?.version).toBe(2);

    // Host CAN still send failure acknowledgement (ok: false) for expired command without engine effects
    await assertSucceeds(
      set(ref(hostDb, `rooms/${ROOM_ID}/responses/${GUEST_1_UID}`), {
        slot: '2',
        commandId: 'cmd_short_lived',
        ok: false,
        error: 'انتهت صلاحية الأمر',
        processedAtMs: Date.now(),
        leaseOwnerId: RUNTIME_1,
      }),
    );
    const failResp = await assertSucceeds(get(ref(guest1Db, `rooms/${ROOM_ID}/responses/${GUEST_1_UID}`)));
    expect(failResp.val()?.ok).toBe(false);

    // Now send an unexpired member command (10s lifetime)
    const freshSendTime = Date.now();
    await assertSucceeds(
      set(ref(guest1Db, `rooms/${ROOM_ID}/commands/${GUEST_1_UID}`), {
        commandId: 'cmd_fresh_valid',
        uid: GUEST_1_UID,
        type: 'ready',
        payloadJson: JSON.stringify({ ready: true }),
        createdAtMs: freshSendTime,
        expiresAtMs: freshSendTime + 10_000,
      }),
    );

    // Atomic update before expiry: snapshot version 3 + ok:true response SUCCEEDS
    const freshTime = Date.now();
    await assertSucceeds(
      update(ref(hostDb, `rooms/${ROOM_ID}`), {
        snapshot: {
          json: JSON.stringify({ version: 3, phase: 'in_round' }),
          version: 3,
          updatedAtMs: freshTime,
          leaseOwnerId: RUNTIME_1,
        },
        [`responses/${GUEST_1_UID}`]: {
          slot: '2',
          commandId: 'cmd_fresh_valid',
          ok: true,
          processedAtMs: freshTime,
          leaseOwnerId: RUNTIME_1,
        },
      }),
    );
    const snapAfterFresh = await assertSucceeds(get(ref(hostDb, `rooms/${ROOM_ID}/snapshot`)));
    expect(snapAfterFresh.val()?.version).toBe(3);

    // --- PART 2: Guest joinRequest expiration regression ---

    // Guest2 posts a short-lived joinRequest in slot 2 expiring in 500ms
    const joinSendTime = Date.now();
    const shortJoinExpiresAtMs = joinSendTime + 500;
    await assertSucceeds(
      set(ref(guest2Db, `rooms/${ROOM_ID}/joinRequests/2`), {
        commandId: 'cmd_join_short_lived',
        uid: GUEST_2_UID,
        nickname: 'سارة',
        createdAtMs: joinSendTime,
        expiresAtMs: shortJoinExpiresAtMs,
      }),
    );

    // Wait 650ms so the joinRequest is strictly expired
    await new Promise((resolve) => setTimeout(resolve, 650));
    const lateJoinTime = Date.now();

    // Host attempts atomic update with ok:true joinResponse for expired request
    // Rules MUST reject the entire update, leaving snapshot version unchanged at 3
    await assertFails(
      update(ref(hostDb, `rooms/${ROOM_ID}`), {
        snapshot: {
          json: JSON.stringify({ version: 20, phase: 'in_round' }),
          version: 20,
          updatedAtMs: lateJoinTime,
          leaseOwnerId: RUNTIME_1,
        },
        [`joinResponses/2`]: {
          commandId: 'cmd_join_short_lived',
          uid: GUEST_2_UID,
          ok: true,
          dataJson: JSON.stringify({ token: 'tok_late' }),
          processedAtMs: lateJoinTime,
          leaseOwnerId: RUNTIME_1,
        },
      }),
    );
    const snapAfterLateJoin = await assertSucceeds(get(ref(hostDb, `rooms/${ROOM_ID}/snapshot`)));
    expect(snapAfterLateJoin.val()?.version).toBe(3);

    // Host CAN still send rejection notice (ok: false) for expired joinRequest
    await assertSucceeds(
      set(ref(hostDb, `rooms/${ROOM_ID}/joinResponses/2`), {
        commandId: 'cmd_join_short_lived',
        uid: GUEST_2_UID,
        ok: false,
        error: 'انتهت مهلة طلب الانضمام',
        processedAtMs: Date.now(),
        leaseOwnerId: RUNTIME_1,
      }),
    );
    const failJoinResp = await assertSucceeds(get(ref(guest2Db, `rooms/${ROOM_ID}/joinResponses/2`)));
    expect(failJoinResp.val()?.ok).toBe(false);

    // Now guest2 posts a fresh unexpired joinRequest in slot 2
    const freshJoinSendTime = Date.now();
    await assertSucceeds(
      set(ref(guest2Db, `rooms/${ROOM_ID}/joinRequests/2`), {
        commandId: 'cmd_join_fresh_valid',
        uid: GUEST_2_UID,
        nickname: 'سارة',
        createdAtMs: freshJoinSendTime,
        expiresAtMs: freshJoinSendTime + 10_000,
      }),
    );

    // Reserve slot '3' for guest2
    await assertSucceeds(
      set(ref(hostDb, `rooms/${ROOM_ID}/memberSlots/3`), {
        slot: '3',
        uid: GUEST_2_UID,
        assignedAtMs: Date.now(),
        leaseOwnerId: RUNTIME_1,
      }),
    );

    // Host atomically publishes snapshot version 4 + ok:true joinResponse before expiry: SUCCEEDS
    const freshJoinPublishTime = Date.now();
    await assertSucceeds(
      update(ref(hostDb, `rooms/${ROOM_ID}`), {
        meta: {
          code: CODE,
          hostUid: HOST_UID,
          createdAtMs: now,
          expiresAtMs,
          phase: 'lobby',
          status: 'open',
          memberCount: 3,
          admittedCount: 3,
          updatedAtMs: freshJoinPublishTime,
          leaseOwnerId: RUNTIME_1,
        },
        [`members/${GUEST_2_UID}`]: {
          uid: GUEST_2_UID,
          slot: '3',
          playerId: 'player_guest2',
          nickname: 'سارة',
          role: 'guest',
          joinedAtMs: freshJoinPublishTime,
          leaseOwnerId: RUNTIME_1,
        },
        snapshot: {
          json: JSON.stringify({ version: 4, phase: 'lobby' }),
          version: 4,
          updatedAtMs: freshJoinPublishTime,
          leaseOwnerId: RUNTIME_1,
        },
        [`views/${GUEST_2_UID}`]: {
          slot: '3',
          json: JSON.stringify({ code: CODE, version: 4, you: { id: 'player_guest2' } }),
          version: 4,
          updatedAtMs: freshJoinPublishTime,
          leaseOwnerId: RUNTIME_1,
        },
        [`joinResponses/2`]: {
          commandId: 'cmd_join_fresh_valid',
          uid: GUEST_2_UID,
          ok: true,
          dataJson: JSON.stringify({ code: CODE, playerId: 'player_guest2', token: 'tok_guest2' }),
          processedAtMs: freshJoinPublishTime,
          leaseOwnerId: RUNTIME_1,
        },
      }),
    );

    const snapAfterFreshJoin = await assertSucceeds(get(ref(hostDb, `rooms/${ROOM_ID}/snapshot`)));
    expect(snapAfterFreshJoin.val()?.version).toBe(4);
  });
});
