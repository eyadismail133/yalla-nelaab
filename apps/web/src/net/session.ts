import { getOrCreateTabSeatId } from './transport-config.js';
import { defendRecoverySeat, forgetRecovery, rememberRecovery, stopDefendingRecovery } from './recovery.js';

const SESSION_KEY = 'party-game-session';
const store = (): Storage => window.sessionStorage;

export interface Session {
  nickname?: string;
  code: string;
  playerId: string;
  token: string;
}

export function loadSession(): Session | null {
  try {
    const raw = store().getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  try {
    store().setItem(SESSION_KEY, JSON.stringify(session));
    const seatId = getOrCreateTabSeatId(store());
    if (seatId) rememberRecovery(seatId, session);
    if (typeof window.addEventListener === 'function') defendRecoverySeat(seatId);
  } catch {
    // Ignore storage quota/security errors
  }
}

export function clearSession(): void {
  stopDefendingRecovery();
  try {
    const seatId = store().getItem('party-game-tab-seat-id');
    if (seatId) forgetRecovery(seatId);
    store().removeItem(SESSION_KEY);
  } catch {
    // Ignore storage errors
  }
}
