import type { RoomState } from '@game/shared';
import { RoomNotFoundError, VersionConflictError, type RoomStore } from './store.js';

/**
 * Single-process RoomStore for the prototype.
 *
 * Node is single-threaded, but a transition can still `await` (content lookups), and during
 * that await another socket event can land on the same room. The per-room promise chain makes
 * transitions serialize anyway — the same guarantee Redis will provide via Lua, reached a much
 * cheaper way. Without it, two players answering simultaneously could both read the same state
 * and one write would silently vanish.
 */
export class MemoryStore implements RoomStore {
  private readonly rooms = new Map<string, RoomState>();
  private readonly locks = new Map<string, Promise<unknown>>();
  /**
   * Codes claimed but not yet written as rooms.
   *
   * `createRoom` reserves a code, then builds the state and stores it — and it awaits in
   * between. Reading `rooms` alone would let a second create in that window be handed the
   * same code and then overwrite the first room, taking its players with it. Redis will hold
   * this with SETNX; here a set is the same guarantee, reached more cheaply.
   */
  private readonly claimed = new Set<string>();

  async create(room: RoomState): Promise<void> {
    this.rooms.set(room.code, room);
    this.claimed.delete(room.code);
  }

  async get(code: string): Promise<RoomState | null> {
    return this.rooms.get(code) ?? null;
  }

  async reserveCode(code: string): Promise<boolean> {
    if (this.rooms.has(code) || this.claimed.has(code)) return false;
    this.claimed.add(code);
    return true;
  }

  async delete(code: string): Promise<void> {
    this.rooms.delete(code);
    this.locks.delete(code);
    // Back into circulation. Codes are five characters from a deliberately small alphabet,
    // so a long-running server that never recycled them would eventually run out.
    this.claimed.delete(code);
  }

  async transition(
    code: string,
    expectedVersion: number | null,
    fn: (state: RoomState) => RoomState | Promise<RoomState>,
  ): Promise<RoomState> {
    const previous = this.locks.get(code) ?? Promise.resolve();
    const run = previous.then(async () => {
      const current = this.rooms.get(code);
      if (!current) throw new RoomNotFoundError(code);
      if (expectedVersion !== null && current.version !== expectedVersion) {
        throw new VersionConflictError(expectedVersion, current.version);
      }

      const next = await fn(current);
      const stored: RoomState = { ...next, version: current.version + 1 };
      this.rooms.set(code, stored);
      return stored;
    });

    // Keep the chain alive even when this transition rejects, so one rejected action does not
    // deadlock every later action on the room.
    this.locks.set(
      code,
      run.catch(() => undefined),
    );
    return run;
  }

  async dueDeadlines(nowMs: number): Promise<string[]> {
    const due: string[] = [];
    for (const room of this.rooms.values()) {
      if (room.phaseEndsAtMs !== null && room.phaseEndsAtMs <= nowMs) due.push(room.code);
    }
    return due;
  }

  async staleRooms(nowMs: number, olderThanMs: number): Promise<string[]> {
    const stale: string[] = [];
    for (const room of this.rooms.values()) {
      if (nowMs - room.updatedAtMs > olderThanMs) stale.push(room.code);
    }
    return stale;
  }

  /** Test/diagnostics helper — not part of the RoomStore contract. */
  size(): number {
    return this.rooms.size;
  }
}
