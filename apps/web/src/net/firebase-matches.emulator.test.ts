import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RoomView } from '@game/shared';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { get, ref } from 'firebase/database';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { JsonSource } from '../../../../apps/server/src/content/json-source.js';
import { clearSession } from './client.js';
import { FirebaseTransport } from './firebase-transport.js';
import type { FirebaseWebConfig } from './transport.js';

const SEED_DIR = fileURLToPath(new URL('../../../../content/seed', import.meta.url));
const contentSource = new JsonSource(SEED_DIR);

const RULES_PATH = fileURLToPath(new URL('../../../../database.rules.json', import.meta.url));
const RULES_JSON = readFileSync(RULES_PATH, 'utf8');

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
  projectId: 'demo-yalla-nelaab',
  appId: '1:123456789:web:abcdef123456',
});

const MCQ_5ROUND_CONFIG = Object.freeze({
  format: 'focused' as const,
  roundTypeId: 'mcq_race',
  roundCount: 5 as const,
  categoryIds: ['general', 'history', 'geography'],
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

function extractCorrectIndex(envelope: any): number {
  const roundState = envelope?.state?.roundState ?? envelope?.state?.round?.state;
  if (
    roundState?.item?.correctIndex !== undefined &&
    typeof roundState.item.correctIndex === 'number'
  ) {
    return roundState.item.correctIndex;
  }
  if (envelope?.state?.pendingContent?.[0]?.correctIndex !== undefined) {
    return envelope.state.pendingContent[0].correctIndex;
  }
  throw new Error(
    `correctIndex not found in snapshot envelope: ${JSON.stringify(envelope).slice(0, 300)}`,
  );
}

interface ExpectedPlayerInfo {
  transport: FirebaseTransport;
  id: string;
  nickname: string;
  isHost: boolean;
  expectedTeamId?: string | null;
}

function assertRematchLobby(
  views: RoomView[],
  expectedCode: string,
  expectedPlayers: ExpectedPlayerInfo[],
  isTeamMatch = false,
): void {
  const originalIds = expectedPlayers.map((p) => p.id).sort();

  for (let i = 0; i < expectedPlayers.length; i += 1) {
    const expected = expectedPlayers[i]!;
    const view = views[i]!;

    expect(view.code).toBe(expectedCode);
    expect(view.phase).toBe('lobby');

    // Observer's own identity must match original registration
    expect(view.you.id).toBe(expected.id);
    expect(view.you.nickname).toBe(expected.nickname);
    expect(view.you.isHost).toBe(expected.isHost);

    // Exact roster IDs must match original set
    expect(view.players).toHaveLength(expectedPlayers.length);
    expect(view.players.map((p) => p.id).sort()).toEqual(originalIds);

    for (const exp of expectedPlayers) {
      const p = view.players.find((pl) => pl.id === exp.id);
      expect(p).toBeDefined();
      expect(p!.nickname).toBe(exp.nickname);
      expect(p!.isHost).toBe(exp.isHost);
      // Scores reset to 0
      expect(p!.total).toBe(0);
      // Readiness reset
      expect(p!.ready).toBeFalsy();
      if (isTeamMatch) {
        expect(p!.teamId).not.toBeNull();
      }
    }

    if (isTeamMatch) {
      expect(view.config.teams).toBe(true);
      const teamACount = view.players.filter((p) => p.teamId === 'team-a').length;
      const teamBCount = view.players.filter((p) => p.teamId === 'team-b').length;
      expect(teamACount).toBe(expectedPlayers.length / 2);
      expect(teamBCount).toBe(expectedPlayers.length / 2);
    }
  }
}

describe('Firebase complete-match acceptance tests', () => {
  let testEnv: RulesTestEnvironment;
  const openTransports: FirebaseTransport[] = [];
  const latestViews = new Map<FirebaseTransport, RoomView>();

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'demo-yalla-nelaab',
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
    latestViews.clear();
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
    latestViews.clear();
    clearSession();
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  function makeTransport(seatId: string, storage?: Storage): FirebaseTransport {
    const transport = new FirebaseTransport({
      seatId,
      config: DEMO_CONFIG,
      storage: storage ?? createMemoryStorage(),
      contentSource,
      databaseEmulatorHost: process.env.FIREBASE_DATABASE_EMULATOR_HOST ?? '127.0.0.1:9000',
      authEmulatorHost: process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099',
    });
    openTransports.push(transport);
    transport.onState((v) => {
      latestViews.set(transport, v);
    });
    return transport;
  }

  async function waitForView(
    transport: FirebaseTransport,
    predicate: (view: RoomView) => boolean,
    timeoutMs = 15_000,
    description = 'expected condition',
  ): Promise<RoomView> {
    const current = latestViews.get(transport);
    if (current && predicate(current)) {
      return current;
    }

    return new Promise<RoomView>((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = transport.onState((v) => {
        latestViews.set(transport, v);
        if (!done && predicate(v)) {
          done = true;
          if (timer) clearTimeout(timer);
          cleanup();
          resolve(v);
        }
      });

      const recheck = latestViews.get(transport);
      if (recheck && predicate(recheck)) {
        done = true;
        cleanup();
        resolve(recheck);
        return;
      }

      timer = setTimeout(() => {
        if (!done) {
          done = true;
          cleanup();
          const last = latestViews.get(transport);
          const diag = last
            ? `phase='${last.phase}', roundNo=${last.round?.roundNo ?? 'none'}, roundIndex=${last.round?.index ?? 'none'}, players=${last.players.length}`
            : 'no view received yet';
          reject(
            new Error(
              `waitForView timed out after ${timeoutMs}ms waiting for [${description}]. Last view: ${diag}`,
            ),
          );
        }
      }, timeoutMs);
    });
  }

  async function waitForAllViews(
    transports: FirebaseTransport[],
    predicate: (view: RoomView) => boolean,
    timeoutMs = 15_000,
    description = 'all players condition',
  ): Promise<RoomView[]> {
    return Promise.all(
      transports.map((t, i) =>
        waitForView(t, predicate, timeoutMs, `${description} [seat/player ${i}]`),
      ),
    );
  }

  async function getRoomIdAndHostUid(
    code: string,
  ): Promise<{ roomId: string; hostUid: string }> {
    const anyAuthDb = testEnv.authenticatedContext('reader-helper').database();
    const codeSnap = await get(ref(anyAuthDb, `codes/${code}`));
    if (!codeSnap.exists() || !codeSnap.val()?.roomId) {
      throw new Error(`Code ${code} not found or missing roomId in database`);
    }
    const val = codeSnap.val();
    return {
      roomId: String(val.roomId),
      hostUid: String(val.hostUid),
    };
  }

  it('enforces real database security rules: denies unauthenticated /rooms reads, cross-player view/snapshot reads, and allows host room access', async () => {
    // 1. Unauthenticated read to /rooms must fail under real database security rules
    const unauthDb = testEnv.unauthenticatedContext().database();
    await assertFails(get(ref(unauthDb, 'rooms')));

    // 2. Setup a room with host and two guests to verify cross-player isolation
    const hostTransport = makeTransport('seat-barrier-host');
    const createRes = await hostTransport.createRoom('هوست_الحاجز');
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) throw new Error(`Host create failed: ${createRes.error}`);

    const code = createRes.code;

    const guest1Transport = makeTransport('seat-barrier-guest-1');
    const joinRes1 = await guest1Transport.joinRoom(code, 'ضيف_الحاجز_١');
    expect(joinRes1.ok).toBe(true);
    if (!joinRes1.ok) throw new Error(`Guest 1 join failed: ${joinRes1.error}`);

    const guest2Transport = makeTransport('seat-barrier-guest-2');
    const joinRes2 = await guest2Transport.joinRoom(code, 'ضيف_الحاجز_٢');
    expect(joinRes2.ok).toBe(true);
    if (!joinRes2.ok) throw new Error(`Guest 2 join failed: ${joinRes2.error}`);

    await waitForView(guest2Transport, (v) => v.phase === 'lobby' && v.players.length === 3);

    const { roomId, hostUid } = await getRoomIdAndHostUid(code);
    const hostDb = testEnv.authenticatedContext(hostUid).database();

    // Host can read own private snapshot envelope
    await assertSucceeds(get(ref(hostDb, `rooms/${roomId}/snapshot`)));
    const snapNode = await get(ref(hostDb, `rooms/${roomId}/snapshot`));
    const envelope = JSON.parse(snapNode.val().json);

    const guest1Binding = envelope.bindings.find(
      (b: { playerId: string; uid: string }) => b.playerId === joinRes1.playerId,
    );
    const guest2Binding = envelope.bindings.find(
      (b: { playerId: string; uid: string }) => b.playerId === joinRes2.playerId,
    );
    expect(guest1Binding).toBeDefined();
    expect(guest2Binding).toBeDefined();

    const guest1Uid = guest1Binding.uid;
    const guest2Uid = guest2Binding.uid;

    const guest1Db = testEnv.authenticatedContext(guest1Uid).database();
    const guest2Db = testEnv.authenticatedContext(guest2Uid).database();
    const intruderDb = testEnv.authenticatedContext('intruder-alien-uid').database();

    // New rooms publish one shared projection and isolated per-seat secrets.
    const publicProjection = await assertSucceeds(get(ref(guest1Db, `rooms/${roomId}/publicView`)));
    expect(publicProjection.exists()).toBe(true);
    expect(JSON.parse(publicProjection.val().json)).not.toHaveProperty('you');
    expect((await assertSucceeds(get(ref(guest1Db, `rooms/${roomId}/privateViews/${guest1Uid}`)))).exists()).toBe(true);
    await assertFails(get(ref(guest1Db, `rooms/${roomId}/privateViews/${guest2Uid}`)));
    await assertFails(get(ref(intruderDb, `rooms/${roomId}/publicView`)));
    await assertFails(get(ref(intruderDb, `rooms/${roomId}/privateViews/${guest1Uid}`)));

    // 3. Guests can read their own private view projection
    await assertSucceeds(get(ref(guest1Db, `rooms/${roomId}/views/${guest1Uid}`)));
    await assertSucceeds(get(ref(guest2Db, `rooms/${roomId}/views/${guest2Uid}`)));

    // 4. Host reading guest views MUST SUCCEED (database.rules.json:53 parent read grants trusted host entire room)
    await assertSucceeds(get(ref(hostDb, `rooms/${roomId}/views/${guest1Uid}`)));
    await assertSucceeds(get(ref(hostDb, `rooms/${roomId}/views/${guest2Uid}`)));

    // 5. Cross-guest read isolation: Guest 1 CANNOT read Guest 2's view
    await assertFails(get(ref(guest1Db, `rooms/${roomId}/views/${guest2Uid}`)));

    // 6. Cross-guest read isolation: Guest 2 CANNOT read Guest 1's view
    await assertFails(get(ref(guest2Db, `rooms/${roomId}/views/${guest1Uid}`)));

    // 7. Guest CANNOT read host view ($uid !== hostUid)
    await assertFails(get(ref(guest1Db, `rooms/${roomId}/views/${hostUid}`)));

    // 8. Guest CANNOT read host's private engine snapshot
    await assertFails(get(ref(guest1Db, `rooms/${roomId}/snapshot`)));
    await assertFails(get(ref(guest2Db, `rooms/${roomId}/snapshot`)));

    // 9. Unrelated third-party intruder CANNOT read guest's private view or host snapshot
    await assertFails(get(ref(intruderDb, `rooms/${roomId}/views/${guest1Uid}`)));
    await assertFails(get(ref(intruderDb, `rooms/${roomId}/snapshot`)));
  });

  it('persists per-question quickfire outcomes once through the real host runtime and rules', async () => {
    const host = makeTransport('seat-telemetry-host');
    const guest = makeTransport('seat-telemetry-guest');
    const created = await host.createRoom('هوست', { ...MCQ_5ROUND_CONFIG, roundTypeId: 'quickfire_tf' });
    if (!created.ok) throw new Error(created.error);
    expect((await guest.joinRoom(created.code, 'ضيف')).ok).toBe(true);
    expect((await host.start()).ok).toBe(true);
    await waitForView(host, (view) => view.phase === 'round_intro');
    expect((await host.skip()).ok).toBe(true);
    const view = await waitForView(host, (current) => current.phase === 'in_round');
    const roundNo = view.round!.roundNo;
    const { roomId, hostUid } = await getRoomIdAndHostUid(created.code);
    const db = testEnv.authenticatedContext(hostUid).database();
    const snapshot = (await get(ref(db, `rooms/${roomId}/snapshot`))).val();
    const items: Array<{ id: string; isTrue: boolean }> = JSON.parse(snapshot.json).state.roundState.items;
    for (const [index, item] of items.entries()) {
      expect((await host.act(roundNo, { kind: 'judge', index, value: item.isTrue })).ok).toBe(true);
      expect((await guest.act(roundNo, { kind: 'judge', index, value: !item.isTrue })).ok).toBe(true);
    }
    await waitForView(host, (current) => current.phase === 'round_result');
    const readSamples = () => Promise.all(items.map(async (item) => (await get(ref(db, `telemetry/${item.id}/${roomId}_${roundNo}`))).val()));
    await expect.poll(async () => (await readSamples()).every(Boolean)).toBe(true);
    const samples = await readSamples();
    for (const sample of samples) {
      expect(sample).toMatchObject({ roomId, roundNo, plays: 2, answered: 2, correct: 1, roundTypeId: 'quickfire_tf' });
      expect(sample.recordedAtMs).toBeGreaterThan(0);
      expect(sample.totalSolveMs).toBeGreaterThanOrEqual(0);
      expect(Object.keys(sample).sort()).toEqual(['answered', 'correct', 'plays', 'recordedAtMs', 'roomId', 'roundNo', 'roundTypeId', 'totalSolveMs']);
    }
    expect((await guest.act(roundNo, { kind: 'result_ready' })).ok).toBe(true);
    expect(await readSamples()).toEqual(samples);
    expect((await guest.leave()).ok).toBe(true);
    expect((await host.leave()).ok).toBe(true);
  }, 40_000);

  it('drives complete 5-round focused mcq_race with 2 players, validates stale action handling, idempotent answer safety, reaches podium, and rematches into lobby', async () => {
    const hostTransport = makeTransport('seat-2p-host');
    const guestTransport = makeTransport('seat-2p-guest');
    const allTransports = [hostTransport, guestTransport];

    // Host creates 5-round focused mcq_race room
    const createRes = await hostTransport.createRoom('هوست ٢ لاعب', MCQ_5ROUND_CONFIG);
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) throw new Error(`Host create failed: ${createRes.error}`);

    const code = createRes.code;
    const hostPlayerId = createRes.playerId;

    // Guest joins room
    const joinRes = await guestTransport.joinRoom(code, 'ضيف ٢ لاعب');
    expect(joinRes.ok).toBe(true);
    if (!joinRes.ok) throw new Error(`Guest join failed: ${joinRes.error}`);

    const guestPlayerId = joinRes.playerId;

    const expectedPlayers: ExpectedPlayerInfo[] = [
      { transport: hostTransport, id: hostPlayerId, nickname: 'هوست ٢ لاعب', isHost: true },
      { transport: guestTransport, id: guestPlayerId, nickname: 'ضيف ٢ لاعب', isHost: false },
    ];

    // Wait for both to be in lobby with 2 players
    const initialViews = await waitForAllViews(
      allTransports,
      (v) => v.phase === 'lobby' && v.players.length === 2,
      15_000,
      '2 players in lobby',
    );
    const firstInitialView = initialViews[0]!;
    expect(firstInitialView.players).toHaveLength(2);
    expect(firstInitialView.config.format).toBe('focused');
    expect(firstInitialView.config.roundTypeId).toBe('mcq_race');
    expect(firstInitialView.config.roundCount).toBe(5);

    // Readiness verification: Guest calls setReady(true) and observers observe actual true before start
    const readyRes = await guestTransport.setReady(true);
    expect(readyRes.ok).toBe(true);

    const readyLobbyViews = await waitForAllViews(
      allTransports,
      (v) => v.players.find((p) => p.id === guestPlayerId)?.ready === true,
      15_000,
      'guest ready: true in lobby before start',
    );
    expect(readyLobbyViews[0]!.players.find((p) => p.id === guestPlayerId)?.ready).toBe(true);
    expect(readyLobbyViews[1]!.players.find((p) => p.id === guestPlayerId)?.ready).toBe(true);

    const { roomId, hostUid } = await getRoomIdAndHostUid(code);
    const hostDb = testEnv.authenticatedContext(hostUid).database();

    // Host starts match; start clears readiness
    const startRes = await hostTransport.start();
    expect(startRes.ok).toBe(true);

    // Drive 5 consecutive rounds through full lifecycle
    for (let roundNo = 1; roundNo <= 5; roundNo += 1) {
      // Capture host's accumulated total before each round begins
      const hostTotalBeforeRound =
        latestViews.get(hostTransport)?.players.find((p) => p.id === hostPlayerId)?.total ?? 0;

      // Step A: Wait for round_intro
      const introViews = await waitForAllViews(
        allTransports,
        (v) => v.phase === 'round_intro' && v.round?.roundNo === roundNo,
        15_000,
        `round ${roundNo} intro`,
      );

      // Verify readiness cleared upon round start
      if (roundNo === 1) {
        for (const view of introViews) {
          expect(view.players.every((p) => !p.ready)).toBe(true);
        }
      }

      // Step B: Host skips intro to enter in_round
      const skipIntroRes = await hostTransport.skip();
      expect(skipIntroRes.ok).toBe(true);

      // Step C: Wait for in_round
      await waitForAllViews(
        allTransports,
        (v) => v.phase === 'in_round' && v.round?.roundNo === roundNo,
        15_000,
        `round ${roundNo} in_round`,
      );

      // Step D: Read correct answer from host's private snapshot
      const snapNode = await get(ref(hostDb, `rooms/${roomId}/snapshot`));
      const envelope = JSON.parse(snapNode.val().json);
      const correctIndex = extractCorrectIndex(envelope);
      const wrongChoice = (correctIndex + 1) % 4;

      // Stale action handling check during round 2
      if (roundNo === 2) {
        const snapBeforeStale = await get(ref(hostDb, `rooms/${roomId}/snapshot`));
        const envBeforeStale = JSON.parse(snapBeforeStale.val().json);
        const guestScoreBefore = latestViews
          .get(guestTransport)!
          .players.find((p) => p.id === guestPlayerId)!.total;

        // Guest submits action with stale roundNo (1 instead of 2)
        const staleRes = await guestTransport.act(roundNo - 1, { kind: 'answer', choice: 0 });
        // Engine silently drops stale round taps per engine.ts:414; transport acknowledges ok: true
        expect(staleRes.ok).toBe(true);

        // Assert snapshot roundState answers and totals remain completely unchanged
        const snapAfterStale = await get(ref(hostDb, `rooms/${roomId}/snapshot`));
        const envAfterStale = JSON.parse(snapAfterStale.val().json);
        expect(envAfterStale.state.roundState.answers).toEqual(
          envBeforeStale.state.roundState.answers,
        );
        expect(envAfterStale.state.totals).toEqual(envBeforeStale.state.totals);
        expect(envAfterStale.state.roundState.answers[guestPlayerId]).toBeUndefined();

        const guestViewAfterStale = latestViews.get(guestTransport)!;
        expect((guestViewAfterStale.round?.view as any)?.hasAnswered).toBe(false);
        expect((guestViewAfterStale.round?.view as any)?.myChoice).toBeNull();
        expect(
          guestViewAfterStale.players.find((p) => p.id === guestPlayerId)!.total,
        ).toBe(guestScoreBefore);
      }

      // Idempotent single-answer check during round 3
      if (roundNo === 3) {
        const hostAct1 = await hostTransport.act(roundNo, {
          kind: 'answer',
          choice: correctIndex,
        });
        expect(hostAct1.ok).toBe(true);

        // Capture first accepted answer from host snapshot
        const snapFirst = await get(ref(hostDb, `rooms/${roomId}/snapshot`));
        const envFirst = JSON.parse(snapFirst.val().json);
        const firstAnswer = envFirst.state.roundState.answers[hostPlayerId];
        expect(firstAnswer).toBeDefined();
        expect(firstAnswer.choice).toBe(correctIndex);

        // Host submits second answer in same round with a DIFFERENT choice
        const hostAct2 = await hostTransport.act(roundNo, {
          kind: 'answer',
          choice: wrongChoice,
        });
        expect(hostAct2.ok).toBe(true);

        // Assert single stored answer remains unchanged in snapshot and view
        const snapSecond = await get(ref(hostDb, `rooms/${roomId}/snapshot`));
        const envSecond = JSON.parse(snapSecond.val().json);
        const secondAnswer = envSecond.state.roundState.answers[hostPlayerId];
        expect(secondAnswer.choice).toBe(correctIndex);
        expect(secondAnswer.atMs).toBe(firstAnswer.atMs);

        const hostViewSecond = latestViews.get(hostTransport)!;
        expect((hostViewSecond.round?.view as any)?.myChoice).toBe(correctIndex);

        // Guest answers wrong choice
        const guestAct = await guestTransport.act(roundNo, {
          kind: 'answer',
          choice: wrongChoice,
        });
        expect(guestAct.ok).toBe(true);
      } else {
        // Normal round: host answers correctly, guest answers wrongly
        const hostAct = await hostTransport.act(roundNo, {
          kind: 'answer',
          choice: correctIndex,
        });
        expect(hostAct.ok).toBe(true);

        const guestAct = await guestTransport.act(roundNo, {
          kind: 'answer',
          choice: wrongChoice,
        });
        expect(guestAct.ok).toBe(true);
      }

      // Step E: All players answered -> automatically advances to round_result
      const resultViews = await waitForAllViews(
        allTransports,
        (v) => v.phase === 'round_result' && v.round?.roundNo === roundNo,
        15_000,
        `round ${roundNo} result`,
      );

      // Assert round scores and weighting (final round 5 has weight 2, rounds 1-4 have weight 1)
      const firstResultView = resultViews[0]!;
      const expectedWeight = roundNo === 5 ? 2 : 1;
      const roundWeight = firstResultView.round?.weight ?? expectedWeight;
      expect(roundWeight).toBe(expectedWeight);
      expect(firstResultView.round?.isFinalRound).toBe(roundNo === 5);

      const hostRoundScore = firstResultView.lastRoundScores?.find(
        (s) => s.playerId === hostPlayerId,
      );
      const guestRoundScore = firstResultView.lastRoundScores?.find(
        (s) => s.playerId === guestPlayerId,
      );

      expect(hostRoundScore?.isCorrect).toBe(true);
      expect(hostRoundScore?.points).toBeGreaterThanOrEqual(120 * roundWeight);
      expect(hostRoundScore?.points).toBeLessThanOrEqual(200 * roundWeight);
      expect(guestRoundScore?.isCorrect).toBe(false);
      expect(guestRoundScore?.points).toBe(0);

      // Verify result total equals previous total plus exactly the single weighted lastRoundScores entry
      const hostTotalAfterRound = firstResultView.players.find(
        (p) => p.id === hostPlayerId,
      )?.total;
      expect(hostTotalAfterRound).toBe(hostTotalBeforeRound + hostRoundScore!.points);
      expect(
        firstResultView.standings.find((s) => s.playerId === hostPlayerId)?.total,
      ).toBe(hostTotalBeforeRound + hostRoundScore!.points);

      // Step F: Host skips result screen to proceed to next round / podium
      const skipResultRes = await hostTransport.skip();
      expect(skipResultRes.ok).toBe(true);
    }

    // Step G: After round 5, match concludes and transitions to podium
    const podiumViews = await waitForAllViews(
      allTransports,
      (v) => v.phase === 'podium',
      15_000,
      'podium phase',
    );

    const hostPodium = podiumViews[0]!;
    expect(hostPodium.winnerId).toBe(hostPlayerId);
    expect(hostPodium.standings).toHaveLength(2);
    expect(hostPodium.standings[0]!.playerId).toBe(hostPlayerId);
    expect(hostPodium.standings[0]!.rank).toBe(1);
    expect(hostPodium.standings[0]!.total).toBeGreaterThan(0);
    expect(hostPodium.standings[1]!.playerId).toBe(guestPlayerId);
    expect(hostPodium.standings[1]!.rank).toBe(2);
    expect(hostPodium.standings[1]!.total).toBe(0);

    // Step H: Host triggers rematch from podium
    const rematchRes = await hostTransport.rematch();
    expect(rematchRes.ok).toBe(true);

    // Step I: All players observe transition back to lobby with exact identity and roster matches
    const rematchLobbyViews = await waitForAllViews(
      allTransports,
      (v) => v.phase === 'lobby',
      15_000,
      'rematch lobby',
    );

    assertRematchLobby(rematchLobbyViews, code, expectedPlayers);
  }, 60_000);

  it('drives complete 5-round focused mcq_race with 4 players, ensures decisive winner, and rematches', async () => {
    const hostTransport = makeTransport('seat-4p-host');
    const guestTransports = [
      makeTransport('seat-4p-guest-1'),
      makeTransport('seat-4p-guest-2'),
      makeTransport('seat-4p-guest-3'),
    ];
    const allTransports = [hostTransport, ...guestTransports];

    const createRes = await hostTransport.createRoom('هوست ٤ لاعب', MCQ_5ROUND_CONFIG);
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) throw new Error(`Host create failed: ${createRes.error}`);

    const code = createRes.code;
    const hostPlayerId = createRes.playerId;
    const guestPlayerIds: string[] = [];

    for (let i = 0; i < guestTransports.length; i += 1) {
      const guest = guestTransports[i]!;
      const nickname = `ضيف ٤_${i + 1}`;
      const joinRes = await guest.joinRoom(code, nickname);
      expect(joinRes.ok).toBe(true);
      if (!joinRes.ok) throw new Error(`Guest join failed: ${joinRes.error}`);
      guestPlayerIds.push(joinRes.playerId);
    }

    const expectedPlayers: ExpectedPlayerInfo[] = [
      { transport: hostTransport, id: hostPlayerId, nickname: 'هوست ٤ لاعب', isHost: true },
      ...guestTransports.map((gt, i) => ({
        transport: gt,
        id: guestPlayerIds[i]!,
        nickname: `ضيف ٤_${i + 1}`,
        isHost: false,
      })),
    ];

    await waitForAllViews(
      allTransports,
      (v) => v.phase === 'lobby' && v.players.length === 4,
      15_000,
      '4 players in lobby',
    );

    const { roomId, hostUid } = await getRoomIdAndHostUid(code);
    const hostDb = testEnv.authenticatedContext(hostUid).database();

    const startRes = await hostTransport.start();
    expect(startRes.ok).toBe(true);

    for (let roundNo = 1; roundNo <= 5; roundNo += 1) {
      await waitForAllViews(
        allTransports,
        (v) => v.phase === 'round_intro' && v.round?.roundNo === roundNo,
        15_000,
        `4p round ${roundNo} intro`,
      );

      const skipIntroRes = await hostTransport.skip();
      expect(skipIntroRes.ok).toBe(true);

      await waitForAllViews(
        allTransports,
        (v) => v.phase === 'in_round' && v.round?.roundNo === roundNo,
        15_000,
        `4p round ${roundNo} in_round`,
      );

      const snapNode = await get(ref(hostDb, `rooms/${roomId}/snapshot`));
      const envelope = JSON.parse(snapNode.val().json);
      const correctIndex = extractCorrectIndex(envelope);
      const wrongChoice = (correctIndex + 1) % 4;

      // Host answers correctly
      const hostAct = await hostTransport.act(roundNo, {
        kind: 'answer',
        choice: correctIndex,
      });
      expect(hostAct.ok).toBe(true);

      // All 3 guests answer incorrectly
      for (const guest of guestTransports) {
        const guestAct = await guest.act(roundNo, {
          kind: 'answer',
          choice: wrongChoice,
        });
        expect(guestAct.ok).toBe(true);
      }

      await waitForAllViews(
        allTransports,
        (v) => v.phase === 'round_result' && v.round?.roundNo === roundNo,
        15_000,
        `4p round ${roundNo} result`,
      );

      const skipResultRes = await hostTransport.skip();
      expect(skipResultRes.ok).toBe(true);
    }

    const podiumViews = await waitForAllViews(
      allTransports,
      (v) => v.phase === 'podium',
      15_000,
      '4p podium phase',
    );

    const hostPodium = podiumViews[0]!;
    expect(hostPodium.winnerId).toBe(hostPlayerId);
    expect(hostPodium.standings).toHaveLength(4);
    expect(hostPodium.standings[0]!.playerId).toBe(hostPlayerId);
    expect(hostPodium.standings[0]!.rank).toBe(1);

    const rematchRes = await hostTransport.rematch();
    expect(rematchRes.ok).toBe(true);

    const rematchViews = await waitForAllViews(
      allTransports,
      (v) => v.phase === 'lobby',
      15_000,
      '4p rematch lobby',
    );

    assertRematchLobby(rematchViews, code, expectedPlayers);
  }, 60_000);

  it('drives complete 5-round focused mcq_race with 8 players at maximum capacity, reaches podium, and rematches', async () => {
    const hostTransport = makeTransport('seat-8p-host');
    const guestTransports: FirebaseTransport[] = [];
    for (let i = 1; i <= 7; i += 1) {
      guestTransports.push(makeTransport(`seat-8p-guest-${i}`));
    }
    const allTransports = [hostTransport, ...guestTransports];

    const createRes = await hostTransport.createRoom('هوست ٨ لاعيبة', MCQ_5ROUND_CONFIG);
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) throw new Error(`Host create failed: ${createRes.error}`);

    const code = createRes.code;
    const hostPlayerId = createRes.playerId;
    const guestPlayerIds: string[] = [];

    for (let i = 0; i < guestTransports.length; i += 1) {
      const guest = guestTransports[i]!;
      const nickname = `لاعب ٨_${i + 1}`;
      const joinRes = await guest.joinRoom(code, nickname);
      expect(joinRes.ok).toBe(true);
      if (!joinRes.ok) throw new Error(`Guest join failed: ${joinRes.error}`);
      guestPlayerIds.push(joinRes.playerId);
    }

    const expectedPlayers: ExpectedPlayerInfo[] = [
      { transport: hostTransport, id: hostPlayerId, nickname: 'هوست ٨ لاعيبة', isHost: true },
      ...guestTransports.map((gt, i) => ({
        transport: gt,
        id: guestPlayerIds[i]!,
        nickname: `لاعب ٨_${i + 1}`,
        isHost: false,
      })),
    ];

    await waitForAllViews(
      allTransports,
      (v) => v.phase === 'lobby' && v.players.length === 8,
      15_000,
      '8 players in lobby',
    );

    const { roomId, hostUid } = await getRoomIdAndHostUid(code);
    const hostDb = testEnv.authenticatedContext(hostUid).database();

    const startRes = await hostTransport.start();
    expect(startRes.ok).toBe(true);

    for (let roundNo = 1; roundNo <= 5; roundNo += 1) {
      await waitForAllViews(
        allTransports,
        (v) => v.phase === 'round_intro' && v.round?.roundNo === roundNo,
        15_000,
        `8p round ${roundNo} intro`,
      );

      const skipIntroRes = await hostTransport.skip();
      expect(skipIntroRes.ok).toBe(true);

      await waitForAllViews(
        allTransports,
        (v) => v.phase === 'in_round' && v.round?.roundNo === roundNo,
        15_000,
        `8p round ${roundNo} in_round`,
      );

      const snapNode = await get(ref(hostDb, `rooms/${roomId}/snapshot`));
      const envelope = JSON.parse(snapNode.val().json);
      const correctIndex = extractCorrectIndex(envelope);
      const wrongChoice = (correctIndex + 1) % 4;

      const hostAct = await hostTransport.act(roundNo, {
        kind: 'answer',
        choice: correctIndex,
      });
      expect(hostAct.ok).toBe(true);

      for (const guest of guestTransports) {
        const guestAct = await guest.act(roundNo, {
          kind: 'answer',
          choice: wrongChoice,
        });
        expect(guestAct.ok).toBe(true);
      }

      const resultViews = await waitForAllViews(
        allTransports,
        (v) => v.phase === 'round_result' && v.round?.roundNo === roundNo,
        15_000,
        `8p round ${roundNo} result`,
      );

      expect(resultViews[0]!.lastRoundScores).toHaveLength(8);

      const skipResultRes = await hostTransport.skip();
      expect(skipResultRes.ok).toBe(true);
    }

    const podiumViews = await waitForAllViews(
      allTransports,
      (v) => v.phase === 'podium',
      15_000,
      '8p podium phase',
    );

    const hostPodium = podiumViews[0]!;
    expect(hostPodium.winnerId).toBe(hostPlayerId);
    expect(hostPodium.standings).toHaveLength(8);
    expect(hostPodium.standings[0]!.playerId).toBe(hostPlayerId);
    expect(hostPodium.standings[0]!.rank).toBe(1);

    const rematchRes = await hostTransport.rematch();
    expect(rematchRes.ok).toBe(true);

    const rematchViews = await waitForAllViews(
      allTransports,
      (v) => v.phase === 'lobby',
      15_000,
      '8p rematch lobby',
    );

    assertRematchLobby(rematchViews, code, expectedPlayers);
  }, 90_000);

  it('drives complete 5-round team match with 4 players, asserts teamStandings, winningTeamId, and rematches', async () => {
    const hostTransport = makeTransport('seat-team-host');
    const guestTransports = [
      makeTransport('seat-team-guest-1'),
      makeTransport('seat-team-guest-2'),
      makeTransport('seat-team-guest-3'),
    ];
    const allTransports = [hostTransport, ...guestTransports];

    // Create room with teams enabled
    const createRes = await hostTransport.createRoom('هوست الفرق', {
      ...MCQ_5ROUND_CONFIG,
      teams: true,
    });
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) throw new Error(`Host create failed: ${createRes.error}`);

    const code = createRes.code;
    const hostPlayerId = createRes.playerId;
    const guestPlayerIds: string[] = [];

    for (let i = 0; i < guestTransports.length; i += 1) {
      const guest = guestTransports[i]!;
      const nickname = `عضو فريق_${i + 1}`;
      const joinRes = await guest.joinRoom(code, nickname);
      expect(joinRes.ok).toBe(true);
      if (!joinRes.ok) throw new Error(`Guest join failed: ${joinRes.error}`);
      guestPlayerIds.push(joinRes.playerId);
    }

    const expectedPlayers: ExpectedPlayerInfo[] = [
      { transport: hostTransport, id: hostPlayerId, nickname: 'هوست الفرق', isHost: true },
      ...guestTransports.map((gt, i) => ({
        transport: gt,
        id: guestPlayerIds[i]!,
        nickname: `عضو فريق_${i + 1}`,
        isHost: false,
      })),
    ];

    // Wait for all 4 players to appear in lobby with team assignment
    const lobbyViews = await waitForAllViews(
      allTransports,
      (v) =>
        v.phase === 'lobby' &&
        v.players.length === 4 &&
        v.config.teams === true &&
        v.players.every((p) => p.teamId !== null),
      15_000,
      '4 players in lobby with teams',
    );

    // Verify team split is balanced (2 on team-a, 2 on team-b)
    const firstLobbyView = lobbyViews[0]!;
    const teamACount = firstLobbyView.players.filter((p) => p.teamId === 'team-a').length;
    const teamBCount = firstLobbyView.players.filter((p) => p.teamId === 'team-b').length;
    expect(teamACount).toBe(2);
    expect(teamBCount).toBe(2);

    const { roomId, hostUid } = await getRoomIdAndHostUid(code);
    const hostDb = testEnv.authenticatedContext(hostUid).database();

    const startRes = await hostTransport.start();
    expect(startRes.ok).toBe(true);

    for (let roundNo = 1; roundNo <= 5; roundNo += 1) {
      await waitForAllViews(
        allTransports,
        (v) => v.phase === 'round_intro' && v.round?.roundNo === roundNo,
        15_000,
        `team round ${roundNo} intro`,
      );

      const skipIntroRes = await hostTransport.skip();
      expect(skipIntroRes.ok).toBe(true);

      const inRoundViews = await waitForAllViews(
        allTransports,
        (v) => v.phase === 'in_round' && v.round?.roundNo === roundNo,
        15_000,
        `team round ${roundNo} in_round`,
      );

      const snapNode = await get(ref(hostDb, `rooms/${roomId}/snapshot`));
      const envelope = JSON.parse(snapNode.val().json);
      const correctIndex = extractCorrectIndex(envelope);
      const wrongChoice = (correctIndex + 1) % 4;

      // Submit actions based on each player's assigned team:
      // Team A players submit correct answers (scoring points)
      // Team B players submit incorrect answers (0 points)
      for (let i = 0; i < allTransports.length; i += 1) {
        const t = allTransports[i]!;
        const playerView = inRoundViews[i]!;
        const myTeam = playerView.players.find((p) => p.id === playerView.you.id)?.teamId;
        const choice = myTeam === 'team-a' ? correctIndex : wrongChoice;

        const actRes = await t.act(roundNo, { kind: 'answer', choice });
        expect(actRes.ok).toBe(true);
      }

      const resultViews = await waitForAllViews(
        allTransports,
        (v) => v.phase === 'round_result' && v.round?.roundNo === roundNo,
        15_000,
        `team round ${roundNo} result`,
      );

      // Verify teamStandings populated and Team A leads
      const firstResult = resultViews[0]!;
      expect(firstResult.teamStandings).toHaveLength(2);
      const teamAStanding = firstResult.teamStandings.find((t) => t.teamId === 'team-a');
      const teamBStanding = firstResult.teamStandings.find((t) => t.teamId === 'team-b');
      expect(teamAStanding?.rank).toBe(1);
      expect(teamAStanding?.total).toBeGreaterThan(0);
      expect(teamBStanding?.rank).toBe(2);
      expect(teamBStanding?.total).toBe(0);

      const skipResultRes = await hostTransport.skip();
      expect(skipResultRes.ok).toBe(true);
    }

    // Assert podium outcome for team match
    const podiumViews = await waitForAllViews(
      allTransports,
      (v) => v.phase === 'podium',
      15_000,
      'team podium phase',
    );

    const podium = podiumViews[0]!;
    expect(podium.winningTeamId).toBe('team-a');
    expect(podium.teamStandings).toHaveLength(2);
    expect(podium.teamStandings[0]!.teamId).toBe('team-a');
    expect(podium.teamStandings[0]!.rank).toBe(1);
    expect(podium.teamStandings[1]!.teamId).toBe('team-b');
    expect(podium.teamStandings[1]!.rank).toBe(2);

    // Host triggers rematch
    const rematchRes = await hostTransport.rematch();
    expect(rematchRes.ok).toBe(true);

    const rematchViews = await waitForAllViews(
      allTransports,
      (v) => v.phase === 'lobby',
      15_000,
      'team rematch lobby',
    );

    assertRematchLobby(rematchViews, code, expectedPlayers, true);
  }, 60_000);
});
