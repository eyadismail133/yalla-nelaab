import { io, type Socket } from 'socket.io-client';
import type { AckResult, RoomView } from '@game/shared';
import { getOrCreateTabSeatId, type GameTransport } from './transport.js';
import { defendRecoverySeat, forgetRecovery, rememberRecovery, stopDefendingRecovery } from './recovery.js';

/**
 * Where the socket connects.
 *
 * Same origin by default, which is the only choice that works everywhere the game is
 * actually played. Deriving `hostname:3001` looks right on a laptop and breaks the moment
 * the page arrives over a tunnel or a deploy: the browser then dials `https://<host>:3001`,
 * a port nothing is listening on and which no TLS certificate covers. In dev, Vite proxies
 * `/socket.io` to the game server; in production the server serves the built client itself.
 *
 * `VITE_SERVER_URL` stays as the escape hatch for running the two on separate origins.
 */
const SERVER_URL = import.meta.env?.VITE_SERVER_URL ?? '';

const SESSION_KEY = 'party-game-session';

/** A dropped clock sample must not stall the reconnect that follows it. */
const TIME_SYNC_TIMEOUT_MS = 2_000;

/** Normal command timeout (10s) so buttons never stay stuck pending indefinitely. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * A seat belongs to a tab, not to a browser — so the session lives in sessionStorage.
 *
 * localStorage is shared by every tab on the origin, which means opening a second tab makes it
 * resume as the player already sitting in the first one. That breaks the obvious way to test a
 * party game locally, and it is also just wrong: two tabs are two seats.
 *
 * sessionStorage still survives a refresh, a phone sleeping, and a dropped connection — every
 * case reconnect actually exists for. The only thing it does not survive is closing the tab,
 * which ends the session anyway.
 */
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

export class GameClient implements GameTransport {
  readonly socket: Socket;
  /** serverNow − clientNow, so every player's countdown agrees regardless of latency. */
  private clockOffsetMs = 0;

  constructor(socket?: Socket) {
    // An empty URL means "this origin", which is what the proxy and the production server
    // both serve. Polling stays in the list because some corporate and hotel networks kill
    // websockets outright, and a party game that fails there fails at a party.
    // autoConnect: false ensures constructor purity during React render passes;
    // connection activation belongs strictly to useEffect via retryConnection().
    this.socket = socket ?? io(SERVER_URL, { autoConnect: false, transports: ['websocket', 'polling'] });
  }

  onState(handler: (view: RoomView) => void): () => void {
    this.socket.on('room:state', handler);
    return () => this.socket.off('room:state', handler);
  }

  onClosed(handler: (payload: { reason: string }) => void): () => void {
    this.socket.on('room:closed', handler);
    return () => this.socket.off('room:closed', handler);
  }

  onConnectionChange(handler: (connected: boolean) => void): () => void {
    const up = () => handler(true);
    const down = () => handler(false);
    this.socket.on('connect', up);
    this.socket.on('disconnect', down);
    if (this.socket.connected) {
      handler(true);
    }
    return () => {
      this.socket.off('connect', up);
      this.socket.off('disconnect', down);
    };
  }

  onHostStatusChange(_handler: (unresponsive: boolean) => void): () => void {
    return () => {};
  }

  /**
   * Estimates the clock offset from several round trips and keeps the median.
   *
   * A single sample is at the mercy of one unlucky packet; the median of five is stable enough
   * that two players on different networks see the same number of seconds left, which matters
   * because the countdown is the main source of tension in every round.
   */
  async syncClock(samples = 5): Promise<number> {
    const offsets: number[] = [];

    for (let i = 0; i < samples; i += 1) {
      const sentAt = Date.now();
      const serverNowMs = await this.serverTime();
      // One timeout means the network is bad enough that four more will not produce a better
      // estimate — they will only hold the reconnect for another eight seconds while the
      // player stares at a match they have already dropped out of.
      if (serverNowMs === null) break;
      const receivedAt = Date.now();
      const roundTrip = receivedAt - sentAt;
      offsets.push(serverNowMs + roundTrip / 2 - receivedAt);
    }

    // Every sample can be lost on a bad network, and this runs on the reconnect path — the
    // one place a hang is unrecoverable, because the resume that restores the player's seat
    // is queued behind it. Keeping the previous offset is a far better failure than never
    // rejoining the match.
    if (offsets.length === 0) return this.clockOffsetMs;

    offsets.sort((a, b) => a - b);
    this.clockOffsetMs = offsets[Math.floor(offsets.length / 2)]!;
    return this.clockOffsetMs;
  }

  /** One clock sample, or null if the server did not answer in time. */
  private serverTime(): Promise<number | null> {
    return new Promise((resolve) => {
      this.socket
        .timeout(TIME_SYNC_TIMEOUT_MS)
        .emit('time:sync', (error: unknown, reply: { serverNowMs: number }) => {
          resolve(error ? null : reply.serverNowMs);
        });
    });
  }

  /** Current time on the server's clock. */
  serverNow(): number {
    return Date.now() + this.clockOffsetMs;
  }

  readonly latencyLabel = 'اتصال السيرفر';

  async sampleLatency(): Promise<number | null> {
    if (!this.socket.connected) return null;
    const started = performance.now();
    const serverTime = await this.serverTime();
    return serverTime === null || !this.socket.connected ? null : performance.now() - started;
  }

  private request<T extends Record<string, unknown>>(
    event: string,
    payload?: unknown,
  ): Promise<AckResult<T>> {
    return new Promise((resolve) => {
      const handleAck = (err: unknown, result?: AckResult<T>) => {
        if (err) {
          resolve({ ok: false, error: 'انتهت مهلة الطلب — جرب تاني' });
          return;
        }
        if (!result) {
          resolve({ ok: false, error: 'حصلت مشكلة في الاتصال' });
          return;
        }
        resolve(result);
      };

      if (payload === undefined) {
        this.socket.timeout(REQUEST_TIMEOUT_MS).emit(event, handleAck);
      } else {
        this.socket.timeout(REQUEST_TIMEOUT_MS).emit(event, payload, handleAck);
      }
    });
  }

  createRoom(nickname: string, config?: Record<string, unknown>) {
    return this.request<{ code: string; playerId: string; token: string }>('room:create', {
      nickname,
      config,
    });
  }

  joinRoom(code: string, nickname: string) {
    return this.request<{ code: string; playerId: string; token: string }>('room:join', {
      code,
      nickname,
    });
  }

  resume(code: string, token: string) {
    return this.request<{ code: string; playerId: string }>('room:resume', { code, token });
  }

  configure(patch: Record<string, unknown>) {
    return this.request('room:configure', patch);
  }

  setReady(ready?: boolean) {
    return this.request('room:ready', ready === undefined ? {} : { ready });
  }

  start() {
    return this.request('room:start');
  }

  /** Host only: end the intro or result screen now instead of waiting it out. */
  skip() {
    return this.request('room:skip');
  }

  kick(playerId: string) {
    return this.request('room:kick', { playerId });
  }

  rematch() {
    return this.request('room:rematch');
  }

  leave() {
    return this.request('room:leave');
  }

  act(roundNo: number, action: unknown) {
    return this.request('round:action', { roundNo, action });
  }

  retryConnection(): void {
    if (!this.socket.connected) {
      this.socket.connect();
    }
  }

  dispose(): void {
    this.socket.removeAllListeners();
    this.socket.disconnect();
  }
}

export type { GameTransport };
