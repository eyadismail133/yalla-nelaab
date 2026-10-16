/**
 * Per-socket token bucket.
 *
 * Quickfire rounds are genuinely rapid — five taps in twenty seconds is normal play — so the
 * budget is generous. This exists to stop a scripted client hammering the engine, not to
 * police fast fingers.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; lastRefillMs: number }>();

  constructor(
    private readonly capacity = 25,
    private readonly refillPerSecond = 10,
    private readonly now: () => number = () => Date.now(),
  ) {}

  allow(key: string): boolean {
    const nowMs = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, lastRefillMs: nowMs };

    const elapsedSeconds = (nowMs - bucket.lastRefillMs) / 1_000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillPerSecond);
    bucket.lastRefillMs = nowMs;

    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }

    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return true;
  }

  forget(key: string): void {
    this.buckets.delete(key);
  }
}
