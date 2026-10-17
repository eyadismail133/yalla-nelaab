import { describe, expect, it } from 'vitest';
import type { AckResult } from '@game/shared';
import {
  ClientSequencer,
  HostDedupTracker,
  formatCommandId,
  parseCommandId,
  sanitizeSeatIdForCommand,
} from './sequence.js';

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

describe('command identity and parsing contract', () => {
  it('round-trips sequence number and sanitized seat when seat contains underscores and digits', () => {
    const candidateSeats = [
      'player_123_seat',
      'seat_with_multiple___underscores_9',
      '987654321',
      'u_7',
      'player@host!#_456',
    ];

    for (const [idx, rawSeat] of candidateSeats.entries()) {
      const seq = (idx + 1) * 7;
      const formatted = formatCommandId(rawSeat, seq);
      const parsed = parseCommandId(formatted);

      expect(parsed).not.toBeNull();
      expect(parsed?.seq).toBe(seq);
      expect(parsed?.seatId).toBe(sanitizeSeatIdForCommand(rawSeat));
      expect(parsed?.nonce).toMatch(/^[A-Za-z0-9]{4,16}$/);
    }
  });

  it('generates distinguishable nonces across successive format invocations for identical parameters', () => {
    const iterations = 30;
    const formattedIds = new Set<string>();
    const nonces = new Set<string>();

    for (let i = 0; i < iterations; i += 1) {
      const id = formatCommandId('player_seat_1', 42);
      formattedIds.add(id);
      const parsed = parseCommandId(id);
      if (parsed) {
        nonces.add(parsed.nonce);
      }
    }

    expect(formattedIds.size).toBe(iterations);
    expect(nonces.size).toBe(iterations);
  });

  it('rejects malformed IDs, legacy formats, invalid sequence numbers, and corrupt suffixes', () => {
    const invalidInputs = [
      '',
      '   ',
      // Legacy prefix or missing prefix
      'cmd_1_seat-1234_abc12345',
      '1_seat-1234_abc12345',
      // Ambiguous ordering (seat before sequence)
      'c_seat-1234_1_abc12345',
      // Raw underscores in seat segment (delimiter collision)
      'c_1_player_seat_abc12345',
      // Invalid sequence numbers
      'c_0_seat-1234_abc12345',
      'c_-1_seat-1234_abc12345',
      'c_-99_seat-1234_abc12345',
      'c_1.5_seat-1234_abc12345',
      'c_01_seat-1234_abc12345',
      'c_1a_seat-1234_abc12345',
      // Invalid characters and suffixes
      'c_1_seat-1234_abc12345!',
      'c_1_seat-1234_abc12345_extra',
      'c_1_seat-1234_abc12345 ',
      ' c_1_seat-1234_abc12345',
      // Segment length bounds
      'c_1_seat123_abc12345', // seat length 7 < 8
      `c_1_${'a'.repeat(33)}_abc12345`, // seat length 33 > 32
      'c_1_seat-1234_abc', // nonce length 3 < 4
      `c_1_seat-1234_${'a'.repeat(17)}`, // nonce length 17 > 16
      // Incomplete parts
      'c_1_seat-1234',
      'c__abc12345',
      'c_1__abc12345',
    ];

    for (const input of invalidInputs) {
      expect(parseCommandId(input), `Expected "${input}" to be rejected`).toBeNull();
    }

    // Non-string arguments
    expect(parseCommandId(null as unknown as string)).toBeNull();
    expect(parseCommandId(undefined as unknown as string)).toBeNull();
    expect(parseCommandId(12345 as unknown as string)).toBeNull();
  });

  it('throws Error in formatCommandId when sequence number is zero, negative, fractional, or non-safe integer', () => {
    const invalidSequences = [0, -1, -50, 1.25, Number.NaN, Number.POSITIVE_INFINITY];

    for (const seq of invalidSequences) {
      expect(() => formatCommandId('seat_123', seq)).toThrow(
        /Invalid command sequence number/,
      );
    }
  });
});

describe('ClientSequencer monotonic sequencing and persistence contract', () => {
  it('increments sequence number before send and persists to storage', () => {
    const storage = createMemoryStorage();
    const sequencer = new ClientSequencer('seat_player_1', { storage });

    expect(sequencer.currentSeq()).toBe(0);
    expect(storage.getItem('party-game-seq-seat_player_1')).toBeNull();

    const first = sequencer.nextCommandId('seat_player_1');
    expect(first.seq).toBe(1);
    expect(sequencer.currentSeq()).toBe(1);
    expect(storage.getItem('party-game-seq-seat_player_1')).toBe('1');

    const firstParsed = parseCommandId(first.commandId);
    expect(firstParsed?.seq).toBe(1);

    const second = sequencer.nextCommandId('seat_player_1');
    expect(second.seq).toBe(2);
    expect(sequencer.currentSeq()).toBe(2);
    expect(storage.getItem('party-game-seq-seat_player_1')).toBe('2');

    const secondParsed = parseCommandId(second.commandId);
    expect(secondParsed?.seq).toBe(2);
  });

  it('resumes from persisted storage across new instances without reusing sequence numbers', () => {
    const storage = createMemoryStorage();
    const initialInstance = new ClientSequencer('seat_player_2', { storage });

    const cmd1 = initialInstance.nextCommandId('seat_player_2');
    const cmd2 = initialInstance.nextCommandId('seat_player_2');
    expect(cmd1.seq).toBe(1);
    expect(cmd2.seq).toBe(2);
    expect(storage.getItem('party-game-seq-seat_player_2')).toBe('2');

    // Emulate tab restart / re-instantiation with same storage
    const resumedInstance = new ClientSequencer('seat_player_2', { storage });
    expect(resumedInstance.currentSeq()).toBe(2);

    const cmd3 = resumedInstance.nextCommandId('seat_player_2');
    expect(cmd3.seq).toBe(3);
    expect(storage.getItem('party-game-seq-seat_player_2')).toBe('3');

    const cmd4 = resumedInstance.nextCommandId('seat_player_2');
    expect(cmd4.seq).toBe(4);
    expect(storage.getItem('party-game-seq-seat_player_2')).toBe('4');
  });

  it('isolates sequence storage across different seats and supports custom storage prefixes', () => {
    const storage = createMemoryStorage();
    const seqA = new ClientSequencer('seat_A', {
      storage,
      storageKeyPrefix: 'custom-game-seq-',
    });
    const seqB = new ClientSequencer('seat_B', {
      storage,
      storageKeyPrefix: 'custom-game-seq-',
    });

    const a1 = seqA.nextCommandId('seat_A');
    const a2 = seqA.nextCommandId('seat_A');
    expect(a1.seq).toBe(1);
    expect(a2.seq).toBe(2);
    expect(seqA.currentSeq()).toBe(2);

    expect(seqB.currentSeq()).toBe(0);
    const b1 = seqB.nextCommandId('seat_B');
    expect(b1.seq).toBe(1);

    expect(storage.getItem('custom-game-seq-seat_A')).toBe('2');
    expect(storage.getItem('custom-game-seq-seat_B')).toBe('1');
    expect(storage.getItem('party-game-seq-seat_A')).toBeNull();
  });

  it('operates in-memory when storage is null and recovers safely from corrupted storage entries', () => {
    // Null storage
    const inMemOnly = new ClientSequencer('seat_no_store', { storage: null });
    expect(inMemOnly.currentSeq()).toBe(0);
    expect(inMemOnly.nextCommandId('seat_no_store').seq).toBe(1);
    expect(inMemOnly.nextCommandId('seat_no_store').seq).toBe(2);

    // Corrupted storage value
    const corruptedStorage = createMemoryStorage();
    corruptedStorage.setItem('party-game-seq-seat_corrupt', 'not-a-valid-int');

    const recovered = new ClientSequencer('seat_corrupt', { storage: corruptedStorage });
    expect(recovered.currentSeq()).toBe(0);
    const firstRecovered = recovered.nextCommandId('seat_corrupt');
    expect(firstRecovered.seq).toBe(1);
    expect(corruptedStorage.getItem('party-game-seq-seat_corrupt')).toBe('1');
  });
});

describe('HostDedupTracker deduplication and acknowledgement contract', () => {
  it('executes first command and replays exact cached success ack on identical retry without re-executing', () => {
    const tracker = new HostDedupTracker();
    const cmd1 = formatCommandId('seat_host_1', 1);

    const initialEval = tracker.evaluate('uid_host_1', cmd1);
    expect(initialEval).toEqual({ action: 'execute', seq: 1 });

    const successAck: AckResult<{ code: string; score: number }> = {
      ok: true,
      code: 'ABC99',
      score: 100,
    };
    tracker.recordAck('uid_host_1', cmd1, 1, successAck);

    const replayEval = tracker.evaluate('uid_host_1', cmd1);
    expect(replayEval).toEqual({ action: 'replay', ack: successAck });
  });

  it('replays exact cached failure ack accurately without re-executing', () => {
    const tracker = new HostDedupTracker();
    const cmd1 = formatCommandId('seat_host_fail', 1);

    expect(tracker.evaluate('uid_fail_1', cmd1)).toEqual({ action: 'execute', seq: 1 });

    const failedAck: AckResult = {
      ok: false,
      error: 'round_already_finished',
    };
    tracker.recordAck('uid_fail_1', cmd1, 1, failedAck);

    const replayEval = tracker.evaluate('uid_fail_1', cmd1);
    expect(replayEval).toEqual({ action: 'replay', ack: failedAck });
  });

  it('rejects a different command ID presenting a duplicate sequence number', () => {
    const tracker = new HostDedupTracker();
    const cmd1A = formatCommandId('seat_dup', 1);
    tracker.recordAck('uid_dup_1', cmd1A, 1, { ok: true });

    // Generate another distinct command ID for the same sequence number
    const cmd1B = formatCommandId('seat_dup', 1);
    expect(cmd1B).not.toBe(cmd1A);

    const evalDuplicate = tracker.evaluate('uid_dup_1', cmd1B);
    expect(evalDuplicate.action).toBe('reject');
    if (evalDuplicate.action === 'reject') {
      expect(evalDuplicate.error).toBeTruthy();
    }
  });

  it('rejects older valid command IDs after a newer command has been accepted', () => {
    const tracker = new HostDedupTracker();
    const cmd1 = formatCommandId('seat_order', 1);
    const cmd2 = formatCommandId('seat_order', 2);

    tracker.recordAck('uid_order_1', cmd1, 1, { ok: true });
    tracker.recordAck('uid_order_1', cmd2, 2, { ok: true });

    const evalOldAccepted = tracker.evaluate('uid_order_1', cmd1);
    expect(evalOldAccepted.action).toBe('reject');
    if (evalOldAccepted.action === 'reject') {
      expect(evalOldAccepted.error).toBeTruthy();
    }

    const cmd1Other = formatCommandId('seat_order', 1);
    const evalOldOther = tracker.evaluate('uid_order_1', cmd1Other);
    expect(evalOldOther.action).toBe('reject');
  });

  it('rejects malformed command IDs regardless of whether tracker has prior records', () => {
    const tracker = new HostDedupTracker();
    const malformedIds = [
      '',
      'invalid-id',
      'c_0_seat-1234_abc12345',
      'cmd_1_seat-1234_abc12345',
    ];

    for (const badId of malformedIds) {
      const evalEmpty = tracker.evaluate('uid_any', badId);
      expect(evalEmpty.action).toBe('reject');
    }

    // After setting a record, malformed IDs are still rejected
    const validCmd = formatCommandId('seat_valid', 1);
    tracker.recordAck('uid_any', validCmd, 1, { ok: true });

    for (const badId of malformedIds) {
      const evalWithRecord = tracker.evaluate('uid_any', badId);
      expect(evalWithRecord.action).toBe('reject');
    }
  });

  it('tracks sequences independently per user ID', () => {
    const tracker = new HostDedupTracker();
    const cmd1 = formatCommandId('seat_shared', 1);

    tracker.recordAck('user_alpha', cmd1, 1, { ok: true });

    // user_beta should still be able to execute sequence 1
    const evalBeta = tracker.evaluate('user_beta', cmd1);
    expect(evalBeta).toEqual({ action: 'execute', seq: 1 });
  });
});

describe('HostDedupTracker JSON serialization and state restoration', () => {
  it('preserves replay and rejection guarantees across JSON serialization and restoration', () => {
    const tracker = new HostDedupTracker();

    const cmdUserSuccess = formatCommandId('seat_succ', 4);
    const successAck: AckResult<{ transition: string }> = {
      ok: true,
      transition: 'round_started',
    };
    tracker.recordAck('user_success', cmdUserSuccess, 4, successAck);

    const cmdUserFail = formatCommandId('seat_fail', 9);
    const failureAck: AckResult = {
      ok: false,
      error: 'action_rejected_by_rule',
    };
    tracker.recordAck('user_fail', cmdUserFail, 9, failureAck);

    // Full JSON serialize -> parse round-trip
    const serializedJson = JSON.stringify(tracker.toJSON());
    const parsedData = JSON.parse(serializedJson);

    const restoredTracker = new HostDedupTracker();
    restoredTracker.fromJSON(parsedData);

    // 1. Observable replay parity for successful ack
    const replaySuccess = restoredTracker.evaluate('user_success', cmdUserSuccess);
    expect(replaySuccess).toEqual({ action: 'replay', ack: successAck });

    // 2. Observable replay parity for failed ack
    const replayFail = restoredTracker.evaluate('user_fail', cmdUserFail);
    expect(replayFail).toEqual({ action: 'replay', ack: failureAck });

    // 3. Rejection of duplicate sequence with mismatched command ID on restored tracker
    const cmdUserSuccessMismatched = formatCommandId('seat_succ', 4);
    const rejectMismatch = restoredTracker.evaluate('user_success', cmdUserSuccessMismatched);
    expect(rejectMismatch.action).toBe('reject');

    // 4. Rejection of older sequence numbers on restored tracker
    const cmdUserSuccessOlder = formatCommandId('seat_succ', 3);
    const rejectOlder = restoredTracker.evaluate('user_success', cmdUserSuccessOlder);
    expect(rejectOlder.action).toBe('reject');

    const cmdUserFailOlder = formatCommandId('seat_fail', 8);
    expect(restoredTracker.evaluate('user_fail', cmdUserFailOlder).action).toBe('reject');

    // 5. Execution of strictly newer sequence numbers on restored tracker
    const cmdUserSuccessNewer = formatCommandId('seat_succ', 5);
    expect(restoredTracker.evaluate('user_success', cmdUserSuccessNewer)).toEqual({
      action: 'execute',
      seq: 5,
    });

    const cmdUserFailNewer = formatCommandId('seat_fail', 10);
    expect(restoredTracker.evaluate('user_fail', cmdUserFailNewer)).toEqual({
      action: 'execute',
      seq: 10,
    });

    // 6. Rejection of malformed IDs on restored tracker
    expect(restoredTracker.evaluate('user_success', 'c_0_bad_nonce').action).toBe('reject');
  });

  it('safely handles empty, null, or corrupted data in fromJSON without throwing', () => {
    const tracker = new HostDedupTracker();

    expect(() => tracker.fromJSON(null)).not.toThrow();
    expect(() => tracker.fromJSON(undefined)).not.toThrow();
    expect(() => tracker.fromJSON({} as unknown as Record<string, never>)).not.toThrow();

    // Corrupted record structures
    const corruptPayload = {
      invalidSeq: {
        lastSeq: 'not-a-number',
        lastCommandId: 'c_1_seat1234_abc12345',
        lastAck: { ok: true },
      },
      invalidCmdId: {
        lastSeq: 1,
        lastCommandId: 12345,
        lastAck: { ok: true },
      },
      missingAck: {
        lastSeq: 1,
        lastCommandId: 'c_1_seat1234_abc12345',
      },
    };

    expect(() => tracker.fromJSON(corruptPayload as unknown as any)).not.toThrow();

    // Tracker should treat those users as unrecorded
    const validCmd = formatCommandId('seat_fresh', 1);
    expect(tracker.evaluate('invalidSeq', validCmd)).toEqual({
      action: 'execute',
      seq: 1,
    });
  });
});
