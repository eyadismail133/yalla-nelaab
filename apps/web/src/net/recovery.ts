import type { Session } from './client.js';

const PREFIX = 'party-game-recovery:';
export const RECOVERY_TTL_MS = 15 * 60 * 1_000;
export interface Recovery { seatId: string; session: Session; expiresAtMs: number }
const SEAT_CHANNEL = 'party-game-tab-seats';
let defendedSeat: string | null = null;
let defender: BroadcastChannel | null = null;

export function stopDefendingRecovery(): void {
  defender?.close();
  defender = null;
  defendedSeat = null;
}

export function defendRecoverySeat(seatId: string): void {
  if (defendedSeat === seatId || typeof BroadcastChannel === 'undefined') return;
  stopDefendingRecovery();
  try {
    const channel = new BroadcastChannel(SEAT_CHANNEL);
    const tabInstanceId = crypto.randomUUID();
    channel.addEventListener('message', (event: MessageEvent) => {
      if (event.data?.type === 'probe-seat' && event.data.seatId === seatId && event.data.tabInstanceId !== tabInstanceId) {
        channel.postMessage({ type: 'seat-claimed', seatId, tabInstanceId });
      }
    });
    defender = channel;
    defendedSeat = seatId;
  } catch { /* Recovery remains available when cross-tab coordination is restricted. */ }
}

async function seatIsActive(seatId: string): Promise<boolean> {
  if (typeof BroadcastChannel === 'undefined') return false;
  const channel = new BroadcastChannel(SEAT_CHANNEL);
  try {
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 100);
      channel.addEventListener('message', (event: MessageEvent) => {
        if (event.data?.type === 'seat-claimed' && event.data.seatId === seatId) {
          clearTimeout(timer);
          resolve(true);
        }
      });
      channel.postMessage({ type: 'probe-seat', seatId, tabInstanceId: crypto.randomUUID() });
    });
  } finally { channel.close(); }
}

function localStore(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; }
  catch { return null; }
}

export function rememberRecovery(seatId: string, session: Session, local = localStore(), now = Date.now()): void {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(seatId)) return;
  let nickname = session.nickname;
  if (!nickname) {
    try { nickname = JSON.parse(local?.getItem(PREFIX + seatId) ?? 'null')?.session?.nickname; }
    catch { /* Replace malformed previous recovery metadata with the current session. */ }
  }
  try { local?.setItem(PREFIX + seatId, JSON.stringify({ seatId, session: { ...session, nickname }, expiresAtMs: now + RECOVERY_TTL_MS })); }
  catch { /* Storage restrictions must not block normal session-only play. */ }
}

export function listRecoveries(local = localStore(), now = Date.now()): Recovery[] {
  const recoveries: Recovery[] = [];
  if (!local) return recoveries;
  try {
    const keys = Array.from({ length: local.length }, (_, index) => local.key(index));
    for (const key of keys) {
      if (!key?.startsWith(PREFIX)) continue;
      try {
        const entry = JSON.parse(local.getItem(key) ?? 'null') as Recovery | null;
        if (entry && /^[A-Za-z0-9_-]{8,64}$/.test(entry.seatId) && key === PREFIX + entry.seatId &&
          entry.expiresAtMs > now && entry.expiresAtMs <= now + RECOVERY_TTL_MS &&
          /^[A-Z0-9]{5}$/.test(entry.session?.code) && typeof entry.session.playerId === 'string' &&
          typeof entry.session.token === 'string' && entry.session.token.length > 0) recoveries.push(entry);
        else local.removeItem(key);
      } catch { local.removeItem(key); }
    }
  } catch { return recoveries; }
  return recoveries.sort((a, b) => b.expiresAtMs - a.expiresAtMs);
}

export function forgetRecovery(seatId: string, local = localStore()): void {
  try { local?.removeItem(PREFIX + seatId); } catch { /* Best-effort local cleanup. */ }
}

export async function restoreRecovery(
  seatId: string,
  options: { local: Storage | null; tab: Storage; now: number; probe?: boolean } = {
    local: localStore(), tab: window.sessionStorage, now: Date.now(), probe: true,
  },
): Promise<void> {
  const recovery = listRecoveries(options.local, options.now).find((entry) => entry.seatId === seatId);
  if (!recovery) throw new Error('انتهت مهلة الرجوع للماتش');
  if (options.probe && await seatIsActive(seatId)) throw new Error('المقعد مفتوح في تاب تاني — اقفله الأول');
  options.tab.setItem('party-game-tab-seat-id', recovery.seatId);
  options.tab.setItem('party-game-session', JSON.stringify(recovery.session));
}
