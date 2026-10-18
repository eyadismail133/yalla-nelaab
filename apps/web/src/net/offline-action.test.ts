import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfflineActionQueue } from './offline-action.js';

afterEach(() => vi.useRealTimers());

describe('short offline action queue', () => {
  it('sends once on reconnect within two seconds, but never while offline or busy', async () => {
    const queue = new OfflineActionQueue();
    let sent = 0;
    const submit = queue.enqueue('room:1:answering', async () => { sent += 1; return { ok: true }; });
    queue.flush('room:1:answering', false);
    expect(sent).toBe(0);
    queue.flush('room:1:answering', true);
    queue.flush('room:1:answering', true);
    expect(await submit).toEqual({ ok: true });
    expect(sent).toBe(1);
  });

  it('expires queued answers and rejects replay into a new round or stage', async () => {
    vi.useFakeTimers();
    const queue = new OfflineActionQueue();
    let sent = false;
    const send = async () => { sent = true; return { ok: true as const }; };
    const expired = queue.enqueue('round:1', send);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await expired).ok).toBe(false);
    queue.flush('round:1', true);
    const stale = queue.enqueue('round:1:writing', send);
    queue.flush('round:1:voting', true);
    expect((await stale).ok).toBe(false);
    expect(sent).toBe(false);
  });

  it('cancels on leave/disposal and refuses a second queued tap', async () => {
    const queue = new OfflineActionQueue();
    const first = queue.enqueue('round:1', async () => ({ ok: true }));
    expect((await queue.enqueue('round:1', async () => ({ ok: true }))).ok).toBe(false);
    queue.cancel();
    expect((await first).ok).toBe(false);
  });
});
