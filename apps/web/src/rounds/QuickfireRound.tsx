import { ar } from '../i18n/ar.js';
import type { QuickfireView, RoundProps } from './types.js';

export function QuickfireRound({ view, roundNo, client }: RoundProps<QuickfireView>) {
  const judge = (value: boolean) => {
    if (!view.current) return;
    void client.act(roundNo, { kind: 'judge', index: view.current.index, value });
  };

  if (view.isDone || !view.current) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <p className="text-3xl font-black" style={{ color: 'var(--accent)' }}>
          خلصت الخمسة 💪
        </p>
        <p className="text-muted">{ar.waitingForOthers}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-6">
      {/* Progress pips, not a bar — five discrete statements should look like five things. */}
      <div className="flex justify-center gap-2">
        {Array.from({ length: view.totalItems }, (_, i) => (
          <span
            key={i}
            className="h-2 w-8 rounded-full transition"
            style={{
              background: i < view.answeredCount ? 'var(--accent)' : 'var(--color-surface-2)',
            }}
          />
        ))}
      </div>

      <p className="flex flex-1 items-center text-balance text-center text-2xl font-bold leading-relaxed">
        {view.current.textAr}
      </p>

      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => judge(true)}
          className="min-h-20 rounded-2xl border-2 border-line bg-surface text-2xl font-black text-accent-emerald transition active:scale-[0.98]"
        >
          {ar.trueLabel}
        </button>
        <button
          onClick={() => judge(false)}
          className="min-h-20 rounded-2xl border-2 border-line bg-surface text-2xl font-black text-accent-rose transition active:scale-[0.98]"
        >
          {ar.falseLabel}
        </button>
      </div>

      <p className="text-center text-sm font-bold text-accent-rose">كل غلطة بتخصم ٢٠</p>
    </div>
  );
}
