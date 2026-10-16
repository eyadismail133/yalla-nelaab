import type { RoomState } from '@game/shared';

export class VersionConflictError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`Room version conflict: expected ${expected}, found ${actual}`);
    this.name = 'VersionConflictError';
  }
}

export class RoomNotFoundError extends Error {
  constructor(readonly code: string) {
    super(`Room not found: ${code}`);
    this.name = 'RoomNotFoundError';
  }
}

/**
 * The swap interface. `MemoryStore` backs the prototype; `RedisStore` will back production
 * with the identical contract, so no engine or game code changes when it lands.
 *
 * The contract that makes that swap safe is `transition`: it must apply `fn` atomically with
 * respect to other transitions on the same room, and reject when `expectedVersion` no longer
 * matches. In memory that is a per-room mutex; in Redis it is a Lua script. Everything above
 * this interface is written against "my change either applies to the state I read, or it does
 * not apply at all" — which is what stops two servers from both finalizing the same round.
 */
export interface RoomStore {
  create(room: RoomState): Promise<void>;
  get(code: string): Promise<RoomState | null>;
  transition(
    code: string,
    expectedVersion: number | null,
    fn: (state: RoomState) => RoomState | Promise<RoomState>,
  ): Promise<RoomState>;
  delete(code: string): Promise<void>;
  /** Room codes whose current phase deadline has passed. Drives the sweeper. */
  dueDeadlines(nowMs: number): Promise<string[]>;
  /** Atomically claims a room code, returning false if it is already taken. */
  reserveCode(code: string): Promise<boolean>;
  /** Rooms untouched for longer than `olderThanMs`, for cleanup. */
  staleRooms(nowMs: number, olderThanMs: number): Promise<string[]>;
}
