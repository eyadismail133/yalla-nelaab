import type { AckResult } from '@game/shared';

type ActionAck = AckResult<Record<string, unknown>>;

export class OfflineActionQueue {
  private pending: {
    scope: string;
    send: () => Promise<ActionAck>;
    resolve: (ack: ActionAck) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  enqueue(scope: string, send: () => Promise<ActionAck>): Promise<ActionAck> {
    if (this.pending) return Promise.resolve({ ok: false, error: 'فيه إجابة مستنية الاتصال' });
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.cancel(), 2_000);
      this.pending = { scope, send, resolve, timer };
    });
  }

  flush(scope: string | null, canSend: boolean): void {
    const pending = this.pending;
    if (!pending) return;
    if (pending.scope !== scope) { this.cancel(); return; }
    if (!canSend) return;
    this.pending = null;
    clearTimeout(pending.timer);
    void pending.send().then(pending.resolve, () => pending.resolve({ ok: false, error: 'تعذر إرسال الإجابة' }));
  }

  cancel(): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.resolve({ ok: false, error: 'انتهت مهلة استرجاع الاتصال — ابعت الإجابة تاني' });
    this.pending = null;
  }
}
