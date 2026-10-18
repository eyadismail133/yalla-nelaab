import { useEffect, useState } from 'react';
import type { GameTransport } from './transport.js';

export function ConnectionQuality({ client, connected }: { client: GameTransport; connected: boolean }) {
  const [rtt, setRtt] = useState<number | null>(null);
  useEffect(() => {
    setRtt(null);
    if (!connected || !client.sampleLatency) return;
    let disposed = false;
    let sampling = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const sample = async () => {
      if (sampling || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
      sampling = true;
      try {
        const measured = await Promise.race([
          client.sampleLatency!(),
          new Promise<null>((resolve) => { timeout = setTimeout(() => resolve(null), 2_000); }),
        ]);
        if (!disposed) setRtt(measured);
      } catch {
        if (!disposed) setRtt(null);
      } finally {
        clearTimeout(timeout);
        sampling = false;
      }
    };
    void sample();
    const interval = setInterval(() => void sample(), 15_000);
    return () => { disposed = true; clearInterval(interval); clearTimeout(timeout); };
  }, [client, connected]);

  const quality = rtt === null ? 'جاري القياس' : rtt < 80 ? '🟢 ممتاز' : rtt < 200 ? '🟡 متوسط' : '🔴 ضعيف';
  return <p role="status" className="px-4 pt-2 text-center text-xs text-muted">
    {connected ? `${client.latencyLabel ?? 'الاتصال'}: ${quality}${rtt === null ? '' : ` · ${Math.round(rtt)} ms`}` : '🔴 غير متصل'}
  </p>;
}
