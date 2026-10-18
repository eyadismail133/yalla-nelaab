import { describe, expect, it } from 'vitest';
import { listRecoveries, rememberRecovery, restoreRecovery, forgetRecovery, defendRecoverySeat, stopDefendingRecovery } from './recovery.js';

function storage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() { return entries.size; },
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: (key) => { entries.delete(key); },
    key: (index) => [...entries.keys()][index] ?? null,
    clear: () => entries.clear(),
  };
}

describe('per-seat match recovery', () => {
  const session = { code: 'ABCDE', playerId: 'p1', token: 'private-seat-token', nickname: 'host' };
  it('offers independent seats for fifteen minutes and restores only the selected credentials', async () => {
    const local = storage();
    const tab = storage();
    rememberRecovery('seat_abcdefgh', session, local, 1_000);
    const { nickname: _nickname, ...credentials } = session;
    rememberRecovery('seat_abcdefgh', credentials, local, 1_000);
    rememberRecovery('seat_ijklmnop', { ...session, playerId: 'p2' }, local, 2_000);
    const recoveries = listRecoveries(local, 3_000);
    expect(recoveries).toHaveLength(2);
    await restoreRecovery('seat_abcdefgh', { local, tab, now: 3_000, probe: false });
    expect(tab.getItem('party-game-tab-seat-id')).toBe('seat_abcdefgh');
    expect(JSON.parse(tab.getItem('party-game-session')!)).toEqual(session);
    expect(listRecoveries(local, 901_001).map((entry) => entry.session.playerId)).toEqual(['p2']);
  });

  it('rejects expired recovery, ignores malformed storage, and clears only the departing seat', async () => {
    const local = storage();
    local.setItem('party-game-recovery:broken', '{');
    rememberRecovery('seat_abcdefgh', session, local, 1_000);
    rememberRecovery('seat_ijklmnop', session, local, 1_000);
    forgetRecovery('seat_abcdefgh', local);
    expect(listRecoveries(local, 2_000).map((entry) => entry.seatId)).toEqual(['seat_ijklmnop']);
    await expect(restoreRecovery('seat_ijklmnop', { local, tab: storage(), now: 901_000, probe: false })).rejects.toThrow();
  });

  it('refuses to recover a seat already held by another live tab', async () => {
    const local = storage();
    const tab = storage();
    rememberRecovery('seat_abcdefgh', session, local, 1_000);
    defendRecoverySeat('seat_abcdefgh');
    try {
      await expect(restoreRecovery('seat_abcdefgh', { local, tab, now: 2_000, probe: true })).rejects.toThrow();
      expect(tab.getItem('party-game-session')).toBeNull();
    } finally { stopDefendingRecovery(); }
  });
});
