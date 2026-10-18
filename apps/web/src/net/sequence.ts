import { nanoid } from 'nanoid';
import type { AckResult } from '@game/shared';

// Format: c_<seq>_<seatId>_<nonce>
// seatId contains only A-Za-z0-9 and hyphens (no underscores)
// nonce contains only A-Za-z0-9 (no underscores)
const STRICT_COMMAND_ID_REGEX = /^c_([1-9][0-9]{0,11})_([A-Za-z0-9-]{8,32})_([A-Za-z0-9]{4,16})$/;

export interface ParsedCommandId {
  seq: number;
  seatId: string;
  nonce: string;
}

export function sanitizeSeatIdForCommand(seatId: string): string {
  // Replace underscores with hyphens to ensure delimiter safety
  return seatId.replace(/_/g, '-').replace(/[^A-Za-z0-9-]/g, 'a').slice(0, 32).padEnd(8, '0');
}

export function formatCommandId(seatId: string, seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new Error(`Invalid command sequence number: ${seq}`);
  }
  const cleanSeat = sanitizeSeatIdForCommand(seatId);
  const nonce = nanoid(8).replace(/[^A-Za-z0-9]/g, 'x');
  return `c_${seq}_${cleanSeat}_${nonce}`;
}

export function parseCommandId(commandId: string): ParsedCommandId | null {
  if (typeof commandId !== 'string') return null;
  const match = STRICT_COMMAND_ID_REGEX.exec(commandId);
  if (!match) return null;
  const seq = Number.parseInt(match[1]!, 10);
  if (!Number.isSafeInteger(seq) || seq < 1) return null;
  return {
    seq,
    seatId: match[2]!,
    nonce: match[3]!,
  };
}

export interface ClientSequencerOptions {
  storage?: Storage | null;
  recoveryStorage?: Storage | null;
  storageKeyPrefix?: string;
}

/**
 * Manages monotonic per-seat command sequencing on the client.
 *
 * Increment-before-send guarantees that sequence numbers strictly increase even across
 * tab refreshes or connection drops, preventing reuse of command IDs.
 */
export class ClientSequencer {
  private readonly storage: Storage | null;
  private readonly storageKey: string;
  private readonly recoveryStorage: Storage | null;
  private inMemorySeq = 0;

  constructor(seatId: string, options: ClientSequencerOptions = {}) {
    this.storage = options.storage !== undefined ? options.storage : defaultSessionStorage();
    this.storageKey = `${options.storageKeyPrefix ?? 'party-game-seq-'}${seatId}`;
    this.recoveryStorage = options.recoveryStorage !== undefined ? options.recoveryStorage : defaultLocalStorage();
    this.inMemorySeq = this.loadSeq();
  }

  private loadSeq(): number {
    let highest = 0;
    for (const storage of [this.storage, this.recoveryStorage]) {
      try {
        const raw = storage?.getItem(this.storageKey);
        if (raw) {
          const parsed = Number.parseInt(raw, 10);
          if (Number.isSafeInteger(parsed) && parsed >= 0) {
            highest = Math.max(highest, parsed);
          }
        }
      } catch { /* Try the other storage when a browser restricts one. */ }
    }
    return highest;
  }

  private persistSeq(seq: number): void {
    for (const storage of [this.storage, this.recoveryStorage]) {
      try { storage?.setItem(this.storageKey, String(seq)); }
      catch { /* In-memory sequencing still supports restricted-storage sessions. */ }
    }
  }

  nextCommandId(seatId: string): { commandId: string; seq: number } {
    this.inMemorySeq += 1;
    this.persistSeq(this.inMemorySeq);
    const commandId = formatCommandId(seatId, this.inMemorySeq);
    return { commandId, seq: this.inMemorySeq };
  }

  currentSeq(): number {
    return this.inMemorySeq;
  }

  advanceTo(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq <= this.inMemorySeq) return;
    this.inMemorySeq = seq;
    this.persistSeq(seq);
  }
}

function defaultLocalStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage ?? null; }
  catch { return null; }
}

export interface DedupRecord {
  lastSeq: number;
  lastCommandId: string;
  lastAck: AckResult<Record<string, unknown>>;
  updatedAtMs: number;
}

export type DedupEvaluation =
  | { action: 'execute'; seq: number }
  | { action: 'replay'; ack: AckResult<Record<string, unknown>> }
  | { action: 'reject'; error: string };

/**
 * Host-side deduplication tracker.
 *
 * Enforces strictly increasing per-UID command sequences:
 * - Reject malformed or invalid IDs.
 * - Replay exact latest acknowledgement on retry without re-executing.
 * - Reject older sequence numbers (`seq < lastSeq`).
 * - Reject duplicate sequence numbers with mismatched command IDs.
 */
export class HostDedupTracker {
  private readonly records = new Map<string, DedupRecord>();

  evaluate(uid: string, commandId: string): DedupEvaluation {
    const parsed = parseCommandId(commandId);
    if (!parsed) {
      return { action: 'reject', error: 'معرّف الأمر غير صالح' };
    }

    const existing = this.records.get(uid);
    if (!existing) {
      return { action: 'execute', seq: parsed.seq };
    }

    if (parsed.seq === existing.lastSeq) {
      if (commandId === existing.lastCommandId) {
        return { action: 'replay', ack: existing.lastAck };
      }
      return { action: 'reject', error: 'تكرار رقم تسلسلي لأمر مختلف' };
    }

    if (parsed.seq < existing.lastSeq) {
      return { action: 'reject', error: 'أمر قديم تم تجاهله' };
    }

    return { action: 'execute', seq: parsed.seq };
  }

  recordAck(
    uid: string,
    commandId: string,
    seq: number,
    ack: AckResult<Record<string, unknown>>,
    nowMs = Date.now(),
  ): void {
    this.records.set(uid, {
      lastSeq: seq,
      lastCommandId: commandId,
      lastAck: ack,
      updatedAtMs: nowMs,
    });
  }

  toJSON(): Record<string, DedupRecord> {
    const obj: Record<string, DedupRecord> = {};
    for (const [uid, record] of this.records) {
      obj[uid] = record;
    }
    return obj;
  }

  fromJSON(data: Record<string, DedupRecord> | undefined | null): void {
    this.records.clear();
    if (!data || typeof data !== 'object') return;
    for (const [uid, record] of Object.entries(data)) {
      if (
        record &&
        typeof record.lastSeq === 'number' &&
        typeof record.lastCommandId === 'string' &&
        record.lastAck &&
        typeof record.lastAck === 'object'
      ) {
        this.records.set(uid, record);
      }
    }
  }

  clear(): void {
    this.records.clear();
  }
}

function defaultSessionStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      return window.sessionStorage;
    }
  } catch {
    // Ignore
  }
  return null;
}
