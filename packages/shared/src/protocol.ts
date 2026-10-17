import { z } from 'zod';
import { matchConfigSchema } from './match.js';
import type { RoomView } from './match.js';

/**
 * The protocol is deliberately tiny: the server pushes one full redacted `room:state` after
 * every transition and the client renders from it. At most eight players per room makes the
 * bandwidth irrelevant, and it buys two things that are otherwise fiddly — reconnect becomes
 * "push the state" with no replay log, and there is exactly one code path that can leak an
 * answer, which is the one the redaction test guards.
 */

export const createRoomSchema = z.object({
  nickname: z.string().trim().min(1).max(16),
  config: matchConfigSchema.partial().optional(),
});

export const joinRoomSchema = z.object({
  code: z.string().trim().length(5),
  nickname: z.string().trim().min(1).max(16),
});

export const resumeRoomSchema = z.object({
  code: z.string().trim().length(5),
  token: z.string().min(8),
});

export const configureRoomSchema = matchConfigSchema.partial();

export const setReadySchema = z
  .object({
    ready: z.boolean().optional(),
  })
  .optional();

export const kickPlayerSchema = z.object({ playerId: z.string().min(1) });

export const roundActionSchema = z.object({
  /** The round the player was looking at. An action from a finished round is dropped. */
  roundNo: z.number().int().nonnegative(),
  action: z.unknown(),
});

export interface ServerToClient {
  'room:state': (view: RoomView) => void;
  'room:error': (payload: { message: string }) => void;
  'room:closed': (payload: { reason: string }) => void;
}

export interface ClientToServer {
  'room:create': (
    payload: z.infer<typeof createRoomSchema>,
    ack: (r: AckResult<{ code: string; playerId: string; token: string }>) => void,
  ) => void;
  'room:join': (
    payload: z.infer<typeof joinRoomSchema>,
    ack: (r: AckResult<{ code: string; playerId: string; token: string }>) => void,
  ) => void;
  'room:resume': (
    payload: z.infer<typeof resumeRoomSchema>,
    ack: (r: AckResult<{ code: string; playerId: string }>) => void,
  ) => void;
  'room:configure': (payload: z.infer<typeof configureRoomSchema>, ack: (r: AckResult) => void) => void;
  'room:ready': (payload: z.infer<typeof setReadySchema>, ack: (r: AckResult) => void) => void;
  'room:start': (ack: (r: AckResult) => void) => void;
  'room:kick': (payload: z.infer<typeof kickPlayerSchema>, ack: (r: AckResult) => void) => void;
  /** Host only: cut the intro or result screen short and move on. */
  'room:skip': (ack: (r: AckResult) => void) => void;
  'room:rematch': (ack: (r: AckResult) => void) => void;
  'room:leave': (ack: (r: AckResult) => void) => void;
  'round:action': (payload: z.infer<typeof roundActionSchema>, ack: (r: AckResult) => void) => void;
  'time:sync': (ack: (r: { serverNowMs: number }) => void) => void;
}

export type AckResult<T = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };
