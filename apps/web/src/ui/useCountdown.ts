import { useEffect, useState } from 'react';
import type { GameTransport } from '../net/transport.js';

/**
 * Milliseconds left until `endsAtMs`, measured on the server's clock.
 *
 * Ticking locally against a synced offset rather than waiting for server pushes means the ring
 * animates smoothly at 10fps without the server sending a message per frame — and every player
 * sees the same number regardless of their latency.
 */
export function useCountdown(client: GameTransport, endsAtMs: number | null): number {
  const [remaining, setRemaining] = useState(() =>
    endsAtMs === null ? 0 : Math.max(0, endsAtMs - client.serverNow()),
  );

  useEffect(() => {
    if (endsAtMs === null) {
      setRemaining(0);
      return;
    }

    const update = () => setRemaining(Math.max(0, endsAtMs - client.serverNow()));
    update();
    const timer = setInterval(update, 100);
    return () => clearInterval(timer);
  }, [client, endsAtMs]);

  return remaining;
}
