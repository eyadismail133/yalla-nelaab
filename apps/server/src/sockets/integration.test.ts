import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import type { AckResult, RoomView } from '@game/shared';
import { JsonSource } from '../content/json-source.js';
import { MatchEngine } from '../rooms/engine.js';
import { MemoryStore } from '../rooms/memory-store.js';
import { ROUND_TYPES } from '@game/rounds';
import { registerSocketHandlers } from './handlers.js';

const SEED_DIR = fileURLToPath(new URL('../../../../content/seed', import.meta.url));

let httpServer: HttpServer;
let ioServer: Server;
let stopSweeper: () => void;
let port: number;

/**
 * Drives real socket.io clients against a real server. Everything below this line is the same
 * code paths a browser hits, which is the point — the engine tests prove the rules, this
 * proves the wiring.
 */
class TestClient {
  readonly views: RoomView[] = [];
  playerId = '';
  token = '';

  private constructor(readonly socket: ClientSocket) {
    socket.on('room:state', (view: RoomView) => this.views.push(view));
  }

  static async connect(): Promise<TestClient> {
    const socket = connect(`http://localhost:${port}`, { transports: ['websocket'] });
    await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
    return new TestClient(socket);
  }

  get view(): RoomView {
    const latest = this.views[this.views.length - 1];
    if (!latest) throw new Error('client has received no state yet');
    return latest;
  }

  emit<T extends Record<string, unknown>>(event: string, payload?: unknown): Promise<AckResult<T>> {
    return new Promise((resolve) => {
      if (payload === undefined) this.socket.emit(event, resolve);
      else this.socket.emit(event, payload, resolve);
    });
  }

  /** Waits until this client's latest view satisfies `predicate`. */
  async waitFor(predicate: (view: RoomView) => boolean, timeoutMs = 4_000): Promise<RoomView> {
    if (this.views.length && predicate(this.view)) return this.view;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.off('room:state', onState);
        reject(new Error(`timed out; last phase was ${this.views.at(-1)?.phase ?? 'none'}`));
      }, timeoutMs);

      const onState = (view: RoomView) => {
        if (!predicate(view)) return;
        clearTimeout(timer);
        this.socket.off('room:state', onState);
        resolve(view);
      };
      this.socket.on('room:state', onState);
    });
  }

  close() {
    this.socket.close();
  }
}

beforeAll(async () => {
  const content = new JsonSource(SEED_DIR);
  const store = new MemoryStore();
  const engine = new MatchEngine(store, content, { introMs: 150, resultMs: 150 });

  httpServer = createServer();
  ioServer = new Server(httpServer, { cors: { origin: true } });
  stopSweeper = registerSocketHandlers({
    io: ioServer,
    engine,
    store,
    content,
    sweepIntervalMs: 25,
  });

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  port = (httpServer.address() as { port: number }).port;
});

afterAll(async () => {
  stopSweeper();
  ioServer.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

async function hostAndGuests(count: number, config?: Record<string, unknown>) {
  const host = await TestClient.connect();
  const created = await host.emit<{ code: string; playerId: string; token: string }>('room:create', {
    nickname: 'يوسف',
    config,
  });
  if (!created.ok) throw new Error(created.error);
  host.playerId = created.playerId;
  host.token = created.token;

  const guests: TestClient[] = [];
  for (let i = 1; i < count; i += 1) {
    const guest = await TestClient.connect();
    const joined = await guest.emit<{ playerId: string; token: string }>('room:join', {
      code: created.code,
      nickname: `لاعب ${i}`,
    });
    if (!joined.ok) throw new Error(joined.error);
    guest.playerId = joined.playerId;
    guest.token = joined.token;
    guests.push(guest);
  }

  return { host, guests, code: created.code, all: [host, ...guests] };
}

describe('socket lifecycle', () => {
  it('creates a room and pushes state to the host', async () => {
    const { host, all } = await hostAndGuests(1);
    await host.waitFor((v) => v.phase === 'lobby');

    expect(host.view.you.isHost).toBe(true);
    expect(host.view.code).toHaveLength(5);
    expect(host.view.availableCategories.length).toBeGreaterThan(0);
    expect(host.view.availableRoundTypes.length).toBe(ROUND_TYPES.length);
    all.forEach((c) => c.close());
  });

  it('shows joiners to everyone already in the room', async () => {
    const { host, all } = await hostAndGuests(3);
    await host.waitFor((v) => v.players.length === 3);
    expect(host.view.players.map((p) => p.nickname)).toContain('لاعب 2');
    all.forEach((c) => c.close());
  });

  it('never sends one player another player\'s token', async () => {
    const { host, guests, all } = await hostAndGuests(2);
    await host.waitFor((v) => v.players.length === 2);
    expect(JSON.stringify(host.view)).not.toContain(guests[0]!.token);
    all.forEach((c) => c.close());
  });

  it('rejects a join for a room that does not exist', async () => {
    const client = await TestClient.connect();
    const result = await client.emit('room:join', { code: 'AAAAA', nickname: 'حد' });
    expect(result.ok).toBe(false);
    client.close();
  });

  it('answers a clock-sync request', async () => {
    const client = await TestClient.connect();
    const before = Date.now();
    const { serverNowMs } = await new Promise<{ serverNowMs: number }>((resolve) =>
      client.socket.emit('time:sync', resolve),
    );
    expect(serverNowMs).toBeGreaterThanOrEqual(before);
    client.close();
  });
});

describe('playing a match over sockets', () => {
  it('runs a full match from lobby to podium', async () => {
    const { host, all, code } = await hostAndGuests(2, {
      roundCount: 5,
      format: 'focused',
      roundTypeId: 'mcq_race',
    });
    await host.waitFor((v) => v.players.length === 2);
    expect((await host.emit('room:start')).ok).toBe(true);

    for (let round = 0; round < 5; round += 1) {
      await Promise.all(all.map((c) => c.waitFor((v) => v.phase === 'in_round')));

      // Everyone answers; correctness does not matter here, reaching the podium does.
      await Promise.all(
        all.map((c) =>
          c.emit('round:action', {
            roundNo: c.view.round!.roundNo,
            action: { kind: 'answer', choice: 0 },
          }),
        ),
      );

      if (round < 4) {
        await Promise.all(all.map((c) => c.waitFor((v) => v.phase === 'round_result')));
      }
    }

    const final = await host.waitFor((v) => v.phase === 'podium' || v.phase === 'sudden_death_intro', 8_000);
    expect(['podium', 'sudden_death_intro']).toContain(final.phase);
    expect(host.view.code).toBe(code);
    all.forEach((c) => c.close());
  });

  it('shows the intro card with the rules before each round starts', async () => {
    const { host, all } = await hostAndGuests(2, { roundCount: 5 });
    await host.waitFor((v) => v.players.length === 2);
    await host.emit('room:start');

    const intro = await host.waitFor((v) => v.phase === 'round_intro');
    expect(intro.round!.nameAr.length).toBeGreaterThan(0);
    expect(intro.round!.scoringHintAr.length).toBeGreaterThan(0);
    expect(intro.round!.accent.length).toBeGreaterThan(0);
    // The question itself must not arrive until the clock starts.
    expect(intro.round!.view).toBeNull();
    all.forEach((c) => c.close());
  });

  it('never leaks the correct answer before the reveal', async () => {
    const { host, all } = await hostAndGuests(2, {
      roundCount: 5,
      format: 'focused',
      roundTypeId: 'mcq_race',
    });
    await host.waitFor((v) => v.players.length === 2);
    await host.emit('room:start');
    await host.waitFor((v) => v.phase === 'in_round');

    for (const view of host.views) {
      if (view.phase === 'round_result' || view.phase === 'podium') continue;
      expect(JSON.stringify(view)).not.toContain('correctIndex');
    }
    all.forEach((c) => c.close());
  });

  it('reveals the answer once the round resolves', async () => {
    const { host, all } = await hostAndGuests(2, {
      roundCount: 5,
      format: 'focused',
      roundTypeId: 'mcq_race',
    });
    await host.waitFor((v) => v.players.length === 2);
    await host.emit('room:start');
    await Promise.all(all.map((c) => c.waitFor((v) => v.phase === 'in_round')));

    await Promise.all(
      all.map((c) =>
        c.emit('round:action', {
          roundNo: c.view.round!.roundNo,
          action: { kind: 'answer', choice: 0 },
        }),
      ),
    );

    const result = await host.waitFor((v) => v.phase === 'round_result');
    expect(result.reveal).not.toBeNull();
    expect(JSON.stringify(result.reveal)).toContain('correctIndex');
    expect(result.lastRoundScores).toHaveLength(2);
    all.forEach((c) => c.close());
  });

  it('rejects a start from someone who is not the host', async () => {
    const { host, guests, all } = await hostAndGuests(2);
    await host.waitFor((v) => v.players.length === 2);
    const result = await guests[0]!.emit('room:start');
    expect(result.ok).toBe(false);
    all.forEach((c) => c.close());
  });

  it('rejects malformed payloads instead of crashing', async () => {
    const { host, all } = await hostAndGuests(1);
    expect((await host.emit('room:join', { code: 'x' })).ok).toBe(false);
    expect((await host.emit('round:action', { roundNo: 'abc' })).ok).toBe(false);
    expect((await host.emit('room:configure', { roundCount: 7 })).ok).toBe(false);
    all.forEach((c) => c.close());
  });
});

describe('one socket, one room', () => {
  /**
   * A socket that joined a second room used to stay subscribed to the first.
   *
   * `socket.data` named the new room while socket.io still delivered the old one, so the next
   * broadcast on the old room rendered it for a player id that was not in it: an empty
   * nickname, no host controls, and a lobby full of strangers replacing whatever the player
   * was actually looking at.
   */
  it('leaves the previous room when the same socket creates another', async () => {
    const { host, guests, code } = await hostAndGuests(2);

    const created = await host.emit<{ code: string }>('room:create', { nickname: 'تاني' });
    if (!created.ok) throw new Error(created.error);
    expect(created.code).not.toBe(code);

    // The old room loses the seat and hands the host role on.
    const old = await guests[0]!.waitFor((v) => v.players.length === 1);
    expect(old.you.isHost).toBe(true);

    const before = host.views.length;
    // Anything that broadcasts the old room would previously reach this socket too.
    const third = await TestClient.connect();
    await third.emit('room:join', { code, nickname: 'تالت' });
    await guests[0]!.waitFor((v) => v.players.length === 2);

    expect(host.views.slice(before).map((v) => v.code)).not.toContain(code);
    expect(host.view.code).toBe(created.code);

    third.close();
    host.close();
    for (const guest of guests) guest.close();
  });

  /**
   * Unsubscribing the socket is only half the fix.
   *
   * The socket is still open, so the old room never sees a disconnect. Without telling the
   * engine, the seat stays occupied by a player who is connected forever: one of five lobby
   * places gone, and a match that can never decide it has been abandoned.
   */
  it('gives up the seat in the old room, not just the subscription', async () => {
    const { host, guests, code } = await hostAndGuests(3);
    expect(host.view.players).toHaveLength(3);

    const moved = await guests[0]!.emit<{ code: string }>('room:create', { nickname: 'ماشي' });
    if (!moved.ok) throw new Error(moved.error);

    const after = await host.waitFor((v) => v.players.length === 2);
    expect(after.code).toBe(code);
    expect(after.players.map((p) => p.nickname)).not.toContain('لاعب 1');

    for (const client of [host, ...guests]) client.close();
  });

  it('leaves the previous room when the same socket joins another', async () => {
    const roomA = await hostAndGuests(2);
    const roomB = await hostAndGuests(2);

    const joined = await roomA.guests[0]!.emit('room:join', {
      code: roomB.code,
      nickname: 'متنقل',
    });
    expect(joined.ok).toBe(true);

    const mover = roomA.guests[0]!;
    await roomA.host.waitFor((v) => v.players.length === 1);

    const before = mover.views.length;
    const late = await TestClient.connect();
    await late.emit('room:join', { code: roomA.code, nickname: 'متأخر' });
    await roomA.host.waitFor((v) => v.players.length === 2);

    expect(mover.views.slice(before).map((v) => v.code)).not.toContain(roomA.code);

    late.close();
    for (const client of [...roomA.all, ...roomB.all]) client.close();
  });
});

describe('disconnect and resume over sockets', () => {
  it('marks a dropped player away without removing their seat', async () => {
    const { host, guests, all } = await hostAndGuests(3);
    await host.waitFor((v) => v.players.length === 3);

    guests[0]!.close();
    const after = await host.waitFor((v) => v.players.some((p) => !p.connected));
    expect(after.players).toHaveLength(3);
    [host, guests[1]!].forEach((c) => c.close());
  });

  it('lets a player resume their seat with their token', async () => {
    const { host, guests, code, all } = await hostAndGuests(2);
    await host.waitFor((v) => v.players.length === 2);

    const token = guests[0]!.token;
    const playerId = guests[0]!.playerId;
    guests[0]!.close();
    await host.waitFor((v) => v.players.some((p) => !p.connected));

    const returning = await TestClient.connect();
    const resumed = await returning.emit<{ playerId: string }>('room:resume', { code, token });
    expect(resumed.ok && resumed.playerId).toBe(playerId);

    await host.waitFor((v) => v.players.every((p) => p.connected));
    returning.close();
    host.close();
  });

  it('hands the host role to the next player when the host leaves', async () => {
    const { host, guests, all } = await hostAndGuests(3);
    await host.waitFor((v) => v.players.length === 3);
    const successor = guests[0]!.playerId;

    host.close();
    const after = await guests[0]!.waitFor((v) => v.players.some((p) => p.isHost && p.id === successor));
    expect(after.you.isHost).toBe(true);
    guests.forEach((c) => c.close());
  });
});
