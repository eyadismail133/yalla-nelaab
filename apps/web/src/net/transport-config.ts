import { nanoid } from 'nanoid';
import type { AckResult, ContentSource, RoomView } from '@game/shared';
import type { FirebaseTransportOptions } from './firebase-transport.js';

export const TAB_SEAT_STORAGE_KEY = 'party-game-tab-seat-id';

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  databaseURL: string;
  projectId: string;
  appId: string;
}

/**
 * Checked-in public Firebase Web SDK configuration for the isolated Spark project.
 * These values are public client identifiers (not admin credentials); security is
 * enforced by `database.rules.json` and Firebase Auth anonymous UIDs.
 */
export const DEFAULT_FIREBASE_CONFIG: Readonly<FirebaseWebConfig> = Object.freeze({
  apiKey: 'AIzaSyCP-NozgksAuJ2tSe06zk5ipLFIIMlMbyM',
  authDomain: 'yalla-nelaab-20261016.firebaseapp.com',
  databaseURL: 'https://yalla-nelaab-20261016-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'yalla-nelaab-20261016',
  appId: '1:748713989802:web:e37cbc40c93efee8b6e2d3',
});

export interface GameTransport {
  onState(handler: (view: RoomView) => void): () => void;
  onClosed(handler: (payload: { reason: string }) => void): () => void;
  onConnectionChange(handler: (connected: boolean) => void): () => void;
  onHostStatusChange?(handler: (unresponsive: boolean) => void): () => void;
  onError?(handler: (message: string) => void): () => void;
  syncClock(samples?: number): Promise<number>;
  serverNow(): number;
  createRoom(
    nickname: string,
    config?: Record<string, unknown>,
  ): Promise<AckResult<{ code: string; playerId: string; token: string }>>;
  joinRoom(
    code: string,
    nickname: string,
  ): Promise<AckResult<{ code: string; playerId: string; token: string }>>;
  resume(code: string, token: string): Promise<AckResult<{ code: string; playerId: string }>>;
  configure(patch: Record<string, unknown>): Promise<AckResult<Record<string, unknown>>>;
  setReady(ready?: boolean): Promise<AckResult<Record<string, unknown>>>;
  start(): Promise<AckResult<Record<string, unknown>>>;
  skip(): Promise<AckResult<Record<string, unknown>>>;
  kick(playerId: string): Promise<AckResult<Record<string, unknown>>>;
  rematch(): Promise<AckResult<Record<string, unknown>>>;
  leave(): Promise<AckResult<Record<string, unknown>>>;
  act(roundNo: number, action: unknown): Promise<AckResult<Record<string, unknown>>>;
  dispose(): void;
  retryConnection(): void;
  preloadContent?(categoryIds: string[]): Promise<void>;
  readonly latencyLabel?: string;
  sampleLatency?(): Promise<number | null>;
}

function defaultSessionStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      return window.sessionStorage;
    }
  } catch {
    // Ignore storage access errors in restricted environments
  }
  return null;
}

const SEAT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Returns a stable random seat identifier for the current browser tab.
 * Stored in `sessionStorage` so refreshing the tab preserves the seat while opening
 * a new tab produces a separate anonymous Firebase session and seat.
 */
export function getOrCreateTabSeatId(storage: Storage | null = defaultSessionStorage()): string {
  try {
    const existing = storage?.getItem(TAB_SEAT_STORAGE_KEY);
    if (existing && SEAT_ID_PATTERN.test(existing)) {
      return existing;
    }
    const created = nanoid(16).replace(/[^A-Za-z0-9_-]/g, 'A');
    storage?.setItem(TAB_SEAT_STORAGE_KEY, created);
    return created;
  } catch {
    return nanoid(16).replace(/[^A-Za-z0-9_-]/g, 'A');
  }
}

export function resolveFirebaseConfig(
  overrides?: Partial<FirebaseWebConfig>,
): FirebaseWebConfig {
  const env = (import.meta.env ?? {}) as Record<string, string | undefined>;
  return {
    apiKey:
      overrides?.apiKey !== undefined
        ? overrides.apiKey
        : (env.VITE_FIREBASE_API_KEY ?? DEFAULT_FIREBASE_CONFIG.apiKey),
    authDomain:
      overrides?.authDomain !== undefined
        ? overrides.authDomain
        : (env.VITE_FIREBASE_AUTH_DOMAIN ?? DEFAULT_FIREBASE_CONFIG.authDomain),
    databaseURL:
      overrides?.databaseURL !== undefined
        ? overrides.databaseURL
        : (env.VITE_FIREBASE_DATABASE_URL ?? DEFAULT_FIREBASE_CONFIG.databaseURL),
    projectId:
      overrides?.projectId !== undefined
        ? overrides.projectId
        : (env.VITE_FIREBASE_PROJECT_ID ?? DEFAULT_FIREBASE_CONFIG.projectId),
    appId:
      overrides?.appId !== undefined
        ? overrides.appId
        : (env.VITE_FIREBASE_APP_ID ?? DEFAULT_FIREBASE_CONFIG.appId),
  };
}

export function validateFirebaseConfig(
  config: Partial<FirebaseWebConfig> | null | undefined,
): { ok: true; config: FirebaseWebConfig } | { ok: false; error: string } {
  if (!config) {
    return { ok: false, error: 'إعدادات الاتصال بـ Firebase غير موجودة' };
  }

  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  const authDomain = typeof config.authDomain === 'string' ? config.authDomain.trim() : '';
  const databaseURL = typeof config.databaseURL === 'string' ? config.databaseURL.trim() : '';
  const projectId = typeof config.projectId === 'string' ? config.projectId.trim() : '';
  const appId = typeof config.appId === 'string' ? config.appId.trim() : '';

  if (!apiKey || !authDomain || !databaseURL || !projectId || !appId) {
    return {
      ok: false,
      error: 'إعدادات Firebase ناقصة — اتأكد من ضبط متغيرات VITE_FIREBASE_* بشكل صحيح',
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(databaseURL);
  } catch {
    return {
      ok: false,
      error: 'رابط قاعدة بيانات Firebase غير صالح (VITE_FIREBASE_DATABASE_URL)',
    };
  }

  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    return {
      ok: false,
      error: 'رابط قاعدة بيانات Firebase لازم يبدأ بـ http أو https',
    };
  }

  return {
    ok: true,
    config: {
      apiKey,
      authDomain,
      databaseURL,
      projectId,
      appId,
    },
  };
}

export interface CreateGameTransportOptions {
  transport?: 'socket' | 'firebase';
  firebaseConfig?: Partial<FirebaseWebConfig>;
  seatId?: string;
  contentSource?: ContentSource;
  firebaseOptions?: Omit<FirebaseTransportOptions, 'config' | 'seatId' | 'contentSource'>;
}
