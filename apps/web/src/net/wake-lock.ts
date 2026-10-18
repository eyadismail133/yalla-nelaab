import { useEffect } from 'react';

export function useScreenWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === 'undefined' || !navigator.wakeLock) return;
    let disposed = false;
    let acquiring = false;
    let sentinel: WakeLockSentinel | null = null;

    const release = () => {
      const held = sentinel;
      sentinel = null;
      void held?.release().catch(() => {});
    };
    const acquire = async () => {
      if (disposed || acquiring || sentinel || document.visibilityState !== 'visible') return;
      acquiring = true;
      try {
        const held = await navigator.wakeLock.request('screen');
        if (disposed || document.visibilityState !== 'visible') {
          await held.release();
        } else {
          sentinel = held;
          held.addEventListener?.('release', () => { if (sentinel === held) sentinel = null; });
        }
      } catch {
        // Unsupported policy or low battery must not prevent playing a match.
      } finally {
        acquiring = false;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire();
      else release();
    };
    document.addEventListener('visibilitychange', onVisibility);
    void acquire();
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      release();
    };
  }, [active]);
}
