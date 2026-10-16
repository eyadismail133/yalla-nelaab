import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RoomView } from '@game/shared';
import { GameClient, clearSession, loadSession, saveSession } from './client.js';

export interface GameState {
  client: GameClient;
  view: RoomView | null;
  connected: boolean;
  error: string | null;
  closedReason: string | null;
  setError: (message: string | null) => void;
  reset: () => void;
}

/**
 * Holds the entire client state: one server-pushed view plus connection status.
 *
 * There is deliberately no client-side game state to keep in sync. The server is authoritative
 * and pushes a complete redacted view after every transition, so reconnecting is just "receive
 * the next state" — no replay log, no reconciliation, no chance of the two drifting apart.
 */
export function useGame(): GameState {
  const client = useMemo(() => new GameClient(), []);
  const [view, setView] = useState<RoomView | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closedReason, setClosedReason] = useState<string | null>(null);

  useEffect(() => client.onState(setView), [client]);

  useEffect(
    () =>
      client.onClosed(({ reason }) => {
        setClosedReason(reason);
        setView(null);
        clearSession();
      }),
    [client],
  );

  useEffect(
    () =>
      client.onConnectionChange(async (isConnected) => {
        setConnected(isConnected);
        if (!isConnected) return;

        await client.syncClock();

        // Rejoin automatically after a refresh or a dropped connection. Doing it here rather
        // than on mount means it also covers a reconnect mid-match, which is the case that
        // actually happens on phones.
        const session = loadSession();
        if (!session) return;
        const result = await client.resume(session.code, session.token);
        if (!result.ok) {
          // The seat is gone — the room ended, or the server restarted. Clearing the view is
          // the part that matters: without it the player is stranded on a stale screen for a
          // room that no longer exists, with nothing on it that still works.
          clearSession();
          setView(null);
        }
      }),
    [client],
  );

  const reset = useCallback(() => {
    clearSession();
    setView(null);
    setClosedReason(null);
    setError(null);
    void client.leave();
  }, [client]);

  return { client, view, connected, error, closedReason, setError, reset };
}

export { saveSession, loadSession, clearSession };
