import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomView } from '@game/shared';
import { clearSession, loadSession, saveSession } from './session.js';
import { isPermanentSessionError } from './session-error.js';
import { createGameTransport } from '#game-transport';
import type { GameTransport } from './transport-config.js';
import { useScreenWakeLock } from './wake-lock.js';

export interface GameState {
  client: GameTransport;
  view: RoomView | null;
  connected: boolean;
  hostUnresponsive: boolean;
  error: string | null;
  connectionError: string | null;
  closedReason: string | null;
  setError: (message: string | null) => void;
  reset: () => void;
  retry: () => Promise<void>;
}

/**
 * Holds the entire client state: one server-pushed view plus connection and host status.
 *
 * There is deliberately no client-side game state to keep in sync. The server/host is authoritative
 * and pushes a complete redacted view after every transition, so reconnecting is just "receive
 * the next state" — no replay log, no reconciliation, no chance of drifting apart.
 */
export function useGame(): GameState {
  const [client] = useState(() => createGameTransport());
  const [view, setView] = useState<RoomView | null>(null);
  const [connected, setConnected] = useState(false);
  const [hostUnresponsive, setHostUnresponsive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [closedReason, setClosedReason] = useState<string | null>(null);

  const disposeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const opGenRef = useRef(0);
  const activeResumeGenRef = useRef<number | null>(null);
  const prevRoomRef = useRef<{ code: string; playerId: string } | null>(null);
  useScreenWakeLock(Boolean(view && ['round_intro', 'in_round', 'round_result', 'sudden_death_intro', 'sudden_death'].includes(view.phase)));

  const preloadCategories = view && ['lobby', 'round_intro'].includes(view.phase)
    ? JSON.stringify(view.config.categoryIds) : null;
  useEffect(() => {
    if (preloadCategories === null) return;
    // Gameplay retries a failed chunk load; prefetch failure must not prevent entering a room.
    void client.preloadContent?.(JSON.parse(preloadCategories) as string[]).catch(() => {});
  }, [client, preloadCategories]);

  useEffect(() => {
    if (!view) return;
    const refreshRecovery = () => {
      const session = loadSession();
      if (session?.code === view.code && session.playerId === view.you.id) saveSession(session);
    };
    refreshRecovery();
    const timer = setInterval(refreshRecovery, 60_000);
    window.addEventListener('pagehide', refreshRecovery);
    return () => { clearInterval(timer); window.removeEventListener('pagehide', refreshRecovery); };
  }, [view?.code, view?.you.id]);

  const performResume = useCallback(async () => {
    const session = loadSession();
    if (!session || activeResumeGenRef.current !== null) return;

    const myGen = ++opGenRef.current;
    activeResumeGenRef.current = myGen;
    const targetCode = session.code;
    const targetToken = session.token;

    try {
      if (client.syncClock) {
        try {
          await client.syncClock();
        } catch {
          // Clock sync fallback
        }
      }

      // Check current session identity and generation guard after syncClock
      let currentSession = loadSession();
      if (
        !mountedRef.current ||
        opGenRef.current !== myGen ||
        !currentSession ||
        currentSession.code !== targetCode ||
        currentSession.token !== targetToken
      ) {
        return;
      }

      const result = await client.resume(session.code, session.token);

      // Check current session identity and generation guard after resume
      currentSession = loadSession();
      if (
        !mountedRef.current ||
        opGenRef.current !== myGen ||
        !currentSession ||
        currentSession.code !== targetCode ||
        currentSession.token !== targetToken
      ) {
        return;
      }

      if (!result.ok) {
        const err = result.error || 'تعذر استعادة الجلسة';
        if (isPermanentSessionError(err)) {
          clearSession();
          setView(null);
          setConnectionError(null);
          setError(err);
        } else {
          // Temporary failure preserves saved seat and exposes persistent connection error with retry
          setConnectionError(err);
        }
      } else {
        setConnectionError(null);
      }
    } catch (err) {
      const currentSession = loadSession();
      if (
        mountedRef.current &&
        opGenRef.current === myGen &&
        currentSession &&
        currentSession.code === targetCode &&
        currentSession.token === targetToken
      ) {
        const msg =
          err instanceof Error && err.message ? err.message : 'حصلت مشكلة في إعادة الاتصال';
        setConnectionError(msg);
      }
    } finally {
      // Only release coalescing ownership if this operation is still the active one
      if (activeResumeGenRef.current === myGen) {
        activeResumeGenRef.current = null;
      }
    }
  }, [client]);

  const retry = useCallback(async () => {
    setError(null);
    setConnectionError(null);
    client.retryConnection();
    await performResume();
  }, [client, performResume]);

  const reset = useCallback(() => {
    opGenRef.current += 1;
    activeResumeGenRef.current = null;
    prevRoomRef.current = null;
    clearSession();
    setView(null);
    setClosedReason(null);
    setError(null);
    setConnectionError(null);
    setHostUnresponsive(false);
    void client.leave().catch(() => {});
  }, [client]);

  // 1. Subscriptions: attached BEFORE eager connection startup so no event or initial state is missed.
  useEffect(() => {
    mountedRef.current = true;
    const unsubs: Array<() => void> = [];

    // State updates: preserve view, invalidate obsolete operations only on accepted room/seat identity change
    unsubs.push(
      client.onState((nextView) => {
        if (!mountedRef.current) return;
        if (
          prevRoomRef.current &&
          nextView &&
          (prevRoomRef.current.code !== nextView.code ||
            prevRoomRef.current.playerId !== nextView.you.id)
        ) {
          opGenRef.current += 1;
          activeResumeGenRef.current = null;
          setHostUnresponsive(false);
          setConnectionError(null);
        }
        if (nextView) {
          prevRoomRef.current = { code: nextView.code, playerId: nextView.you.id };
        }
        setView(nextView);
      }),
    );

    // Room closed: clear state and all stale connection/status errors for a coherent end-state
    unsubs.push(
      client.onClosed(({ reason }) => {
        if (!mountedRef.current) return;
        opGenRef.current += 1;
        activeResumeGenRef.current = null;
        prevRoomRef.current = null;
        setClosedReason(reason);
        setView(null);
        setHostUnresponsive(false);
        setConnectionError(null);
        setError(null);
        clearSession();
      }),
    );

    // Host status change: onHostStatusChange exclusively owns hostUnresponsive status
    if (client.onHostStatusChange) {
      unsubs.push(
        client.onHostStatusChange((unresponsive) => {
          if (!mountedRef.current) return;
          setHostUnresponsive(unresponsive);
        }),
      );
    }

    // Optional transport initialization / retry error callback
    const transportWithError = client as {
      onError?: (handler: (message: string) => void) => () => void;
    };
    if (typeof transportWithError.onError === 'function') {
      unsubs.push(
        transportWithError.onError((msg: string) => {
          if (!mountedRef.current) return;
          setConnectionError(msg);
          setError(msg);
        }),
      );
    }

    // Connection lifecycle and auto-resume
    unsubs.push(
      client.onConnectionChange(async (isConnected) => {
        if (!mountedRef.current) return;
        setConnected(isConnected);
        if (!isConnected) return;

        setConnectionError(null);
        await performResume();
      }),
    );

    return () => {
      mountedRef.current = false;
      for (const unsub of unsubs) {
        try {
          unsub();
        } catch {
          // Ignore subscription cleanup errors
        }
      }
    };
  }, [client, performResume]);

  // 2. Eager startup, mobile app-switch recovery, and disposal lifecycle:
  // Runs after subscriptions are attached. Cancels pending deferred disposal on StrictMode remount,
  // calls retryConnection() to begin connecting, listens for mobile foreground/visibility/network return,
  // and defers disposal on unmount to survive StrictMode while guaranteeing true unmount eventually disposes.
  useEffect(() => {
    if (disposeTimerRef.current) {
      clearTimeout(disposeTimerRef.current);
      disposeTimerRef.current = null;
    }
    client.retryConnection();

    const handleForegroundOrOnline = () => {
      if (!mountedRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      setConnectionError(null);
      client.retryConnection();
      void performResume();
    };

    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        handleForegroundOrOnline();
      }
    };

    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pageshow', handleForegroundOrOnline);
      window.addEventListener('focus', handleForegroundOrOnline);
      window.addEventListener('online', handleForegroundOrOnline);
    }

    return () => {
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('pageshow', handleForegroundOrOnline);
        window.removeEventListener('focus', handleForegroundOrOnline);
        window.removeEventListener('online', handleForegroundOrOnline);
      }
      disposeTimerRef.current = setTimeout(() => {
        client.dispose();
      }, 150);
    };
  }, [client, performResume]);

  return {
    client,
    view,
    connected,
    hostUnresponsive,
    error,
    connectionError,
    closedReason,
    setError,
    reset,
    retry,
  };
}

export { saveSession, loadSession, clearSession, isPermanentSessionError };
