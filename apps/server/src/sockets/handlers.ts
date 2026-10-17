import type { Server, Socket } from 'socket.io';
import type { ZodSchema } from 'zod';
import {
  configureRoomSchema,
  createRoomSchema,
  joinRoomSchema,
  kickPlayerSchema,
  resumeRoomSchema,
  roundActionSchema,
  setReadySchema,
  type AckResult,
  type ContentSource,
} from '@game/shared';
import { normalizeCode } from '../rooms/codes.js';
import { EngineError, MatchEngine } from '../rooms/engine.js';
import { RoomNotFoundError, type RoomStore } from '../rooms/store.js';
import { toView } from '../rooms/view.js';
import { RateLimiter } from './rate-limit.js';

interface SocketData {
  code?: string;
  playerId?: string;
}

type Ack = (result: AckResult<Record<string, unknown>>) => void;

const ok = (extra: Record<string, unknown> = {}) => ({ ok: true as const, ...extra });

/** Turns internal failures into something a player can read, and hides the rest. */
function toMessage(error: unknown): string {
  if (error instanceof EngineError) return error.message;
  if (error instanceof RoomNotFoundError) return 'الغرفة دي مش موجودة أو خلصت';
  return 'حصلت مشكلة، جرّب تاني';
}

/**
 * How often the sweeper looks for expired phase deadlines.
 *
 * This is the real resolution of every timed transition — an intro card configured for 3.5s
 * actually lasts up to 3.5s + this interval. At one second the jitter was visible as stutter
 * between rounds, so it is set well below the threshold where a person notices. The cost is
 * four cheap range queries per second per node, which stays negligible against Redis later.
 */
export const SWEEP_INTERVAL_MS = 250;

export interface SocketDeps {
  io: Server;
  engine: MatchEngine;
  store: RoomStore;
  content: ContentSource;
  sweepIntervalMs?: number;
}

export function registerSocketHandlers({
  io,
  engine,
  store,
  content,
  sweepIntervalMs = SWEEP_INTERVAL_MS,
}: SocketDeps): () => void {
  const limiter = new RateLimiter();

  /**
   * Pushes one full, per-player redacted view to everyone in the room.
   *
   * Rebuilding the view per socket is what keeps redaction honest — there is no shared payload
   * that could accidentally carry another player's answer.
   */
  async function broadcast(code: string): Promise<void> {
    const state = await store.get(code);
    if (!state) return;

    const categories = await content.categories();
    for (const socket of await io.in(code).fetchSockets()) {
      const playerId = (socket.data as SocketData).playerId;
      if (playerId) socket.emit('room:state', toView(state, playerId, categories));
    }
  }

  /**
   * Binds a socket to exactly one room.
   *
   * Joining without leaving looks harmless and is not: the socket stays subscribed to its
   * previous room while `socket.data` now names the new one, so the next broadcast on the old
   * room renders that room for a player id that does not belong to it. The player watches
   * their screen replaced by a lobby they are not in, with no nickname and no controls.
   */
  async function takeSeat(socket: Socket, code: string, playerId: string): Promise<void> {
    const data = socket.data as SocketData;
    const previous = data.code;
    const previousPlayerId = data.playerId;

    data.code = code;
    data.playerId = playerId;
    await socket.join(code);

    if (!previous || previous === code || !previousPlayerId) return;

    // Unsubscribing is only half of it. The socket is still open, so the old room never sees
    // a disconnect and holds the seat as a connected player forever — occupying one of five
    // places in its lobby, and counting towards "somebody is still playing" in a match that
    // has nobody left in it.
    await socket.leave(previous);
    await engine.leave(previous, previousPlayerId);
    await broadcast(previous);
  }

  function guard<T>(schema: ZodSchema<T>, payload: unknown, ack: Ack): T | null {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      ack({ ok: false, error: 'البيانات اللي وصلت مش مظبوطة' });
      return null;
    }
    return parsed.data;
  }

  async function attempt(socket: Socket, ack: Ack, fn: () => Promise<Record<string, unknown> | void>) {
    if (!limiter.allow(socket.id)) {
      ack({ ok: false, error: 'براحة شوية 🙂' });
      return;
    }
    try {
      const extra = await fn();
      ack(ok(extra ?? {}));
    } catch (error) {
      ack({ ok: false, error: toMessage(error) });
    }
  }

  io.on('connection', (socket: Socket) => {
    const data = socket.data as SocketData;

    socket.on('time:sync', (ack: (r: { serverNowMs: number }) => void) => {
      // The client measures round-trip time around this to derive a clock offset, so every
      // player's countdown ring reads the same regardless of their latency.
      if (typeof ack === 'function') ack({ serverNowMs: Date.now() });
    });

    socket.on('room:create', async (payload: unknown, ack: Ack) => {
      const input = guard(createRoomSchema, payload, ack);
      if (!input) return;

      await attempt(socket, ack, async () => {
        const { state, playerId, token } = await engine.createRoom(input.nickname, input.config);
        await takeSeat(socket, state.code, playerId);
        await broadcast(state.code);
        return { code: state.code, playerId, token };
      });
    });

    socket.on('room:join', async (payload: unknown, ack: Ack) => {
      const input = guard(joinRoomSchema, payload, ack);
      if (!input) return;

      await attempt(socket, ack, async () => {
        const code = normalizeCode(input.code);
        const { playerId, token } = await engine.join(code, input.nickname);
        await takeSeat(socket, code, playerId);
        await broadcast(code);
        return { code, playerId, token };
      });
    });

    socket.on('room:resume', async (payload: unknown, ack: Ack) => {
      const input = guard(resumeRoomSchema, payload, ack);
      if (!input) return;

      await attempt(socket, ack, async () => {
        const code = normalizeCode(input.code);
        const { playerId } = await engine.resume(code, input.token);
        await takeSeat(socket, code, playerId);
        await broadcast(code);
        return { code, playerId };
      });
    });

    socket.on('room:configure', async (payload: unknown, ack: Ack) => {
      const input = guard(configureRoomSchema, payload, ack);
      if (!input || !data.code || !data.playerId) return ack({ ok: false, error: 'مش في غرفة' });

      await attempt(socket, ack, async () => {
        await engine.configure(data.code!, data.playerId!, input);
        await broadcast(data.code!);
      });
    });

    socket.on('room:ready', async (payload: unknown, maybeAck?: Ack) => {
      const ack: Ack = typeof payload === 'function' ? (payload as Ack) : (maybeAck as Ack);
      const rawPayload = typeof payload === 'function' ? undefined : payload;
      const parsed = setReadySchema.safeParse(rawPayload);
      if (!parsed.success) return ack({ ok: false, error: 'البيانات اللي وصلت مش مظبوطة' });
      if (!data.code || !data.playerId) return ack({ ok: false, error: 'مش في غرفة' });

      await attempt(socket, ack, async () => {
        await engine.setReady(data.code!, data.playerId!, parsed.data?.ready);
        await broadcast(data.code!);
      });
    });

    socket.on('room:start', async (ack: Ack) => {
      if (!data.code || !data.playerId) return ack({ ok: false, error: 'مش في غرفة' });
      await attempt(socket, ack, async () => {
        await engine.start(data.code!, data.playerId!);
        await broadcast(data.code!);
      });
    });

    socket.on('room:kick', async (payload: unknown, ack: Ack) => {
      const input = guard(kickPlayerSchema, payload, ack);
      if (!input || !data.code || !data.playerId) return ack({ ok: false, error: 'مش في غرفة' });

      await attempt(socket, ack, async () => {
        await engine.kick(data.code!, data.playerId!, input.playerId);
        for (const other of await io.in(data.code!).fetchSockets()) {
          if ((other.data as SocketData).playerId === input.playerId) {
            other.emit('room:closed', { reason: 'الهوست طردك من الغرفة' });
            other.leave(data.code!);
          }
        }
        await broadcast(data.code!);
      });
    });

    socket.on('room:skip', async (ack: Ack) => {
      if (!data.code || !data.playerId) return ack({ ok: false, error: 'مش في غرفة' });
      await attempt(socket, ack, async () => {
        await engine.skipPhase(data.code!, data.playerId!);
        await broadcast(data.code!);
      });
    });

    socket.on('room:rematch', async (ack: Ack) => {
      if (!data.code || !data.playerId) return ack({ ok: false, error: 'مش في غرفة' });
      await attempt(socket, ack, async () => {
        await engine.rematch(data.code!, data.playerId!);
        await broadcast(data.code!);
      });
    });

    socket.on('round:action', async (payload: unknown, ack: Ack) => {
      const input = guard(roundActionSchema, payload, ack);
      if (!input || !data.code || !data.playerId) return ack({ ok: false, error: 'مش في غرفة' });

      await attempt(socket, ack, async () => {
        await engine.submitAction(data.code!, data.playerId!, input.roundNo, input.action);
        await broadcast(data.code!);
      });
    });

    socket.on('room:leave', async (ack: Ack) => {
      if (!data.code || !data.playerId) return ack({ ok: false, error: 'مش في غرفة' });
      const code = data.code;
      const playerId = data.playerId;
      // The seat is released first and unconditionally. A room that has already been reaped
      // makes the engine call fail, and a player left subscribed to a room they walked out of
      // is exactly the cross-room mixup `takeSeat` exists to prevent.
      await socket.leave(code);
      data.code = undefined;
      data.playerId = undefined;
      await attempt(socket, ack, async () => {
        await engine.leave(code, playerId);
        await broadcast(code);
      });
    });

    socket.on('disconnect', async () => {
      limiter.forget(socket.id);
      if (!data.code || !data.playerId) return;

      try {
        // Marked away rather than removed — the seat and score are held for the grace period
        // so a tunnel or a locked phone does not cost a player their match.
        await engine.setConnected(data.code, data.playerId, false);
        await broadcast(data.code);
      } catch (error) {
        // Nothing is waiting on this handler — there is no ack and no caller — so a rejection
        // here escapes as an unhandled promise rejection and takes the whole server down with
        // every match on it. One player dropping must never be able to do that.
        console.error('[sockets] disconnect cleanup failed', error);
      }
    });
  });

  // The sweeper. Advances intro cards, expired rounds and result screens, and reaps seats
  // whose grace period ran out. One interval drives every room in the process.
  let sweeping = false;
  const sweeper = setInterval(() => {
    // A slow sweep must not stack on top of itself and double-advance rooms.
    if (sweeping) return;
    sweeping = true;

    void (async () => {
      try {
        for (const code of await engine.tick()) await broadcast(code);

        for (const room of io.sockets.adapter.rooms.keys()) {
          if (io.sockets.adapter.sids.has(room)) continue; // skip per-socket rooms
          const changed = await engine.reapDisconnected(room);
          if (changed) await broadcast(room);
        }
      } catch (error) {
        console.error('[sweeper]', error);
      } finally {
        sweeping = false;
      }
    })();
  }, sweepIntervalMs);

  return () => clearInterval(sweeper);
}
