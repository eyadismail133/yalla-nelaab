import { ar } from '../i18n/ar.js';
import type { McqRaceView, RoundProps } from './types.js';
import { RoundActionStatus, useRoundAction } from './useRoundAction.js';

const LABELS = ['أ', 'ب', 'ج', 'د'];

export function McqRaceRound({ view, roundNo, client, hiddenOptions = [] }: RoundProps<McqRaceView> & { hiddenOptions?: number[] }) {
  const { pending, error, act, submittedAction } = useRoundAction<{ kind: 'answer'; choice: number }>(client, roundNo);
  const locked = view.hasAnswered || submittedAction !== null;
  const myChoice = view.myChoice ?? submittedAction?.choice;

  const choose = (index: number) => {
    if (locked || pending || hiddenOptions.includes(index)) return;
    void act({ kind: 'answer', choice: index });
  };

  return (
    <div className="flex flex-1 flex-col gap-6">
      <p className="text-balance text-center text-2xl font-bold leading-relaxed">{view.textAr}</p>

      <div className="grid gap-3">
        {view.options.map((option, index) => {
          const mine = myChoice === index;
          return (
            <button
              key={option}
              type="button"
              onClick={() => choose(index)}
              disabled={locked || pending || hiddenOptions.includes(index)}
              className={`flex min-h-16 items-center gap-3 rounded-2xl border-2 px-4 text-start text-lg font-bold transition active:scale-[0.99] ${
                mine
                  ? 'border-[var(--accent)] bg-surface-2'
                  : 'border-line bg-surface disabled:opacity-45'
              }`}
            >
              <span
                className="grid size-9 shrink-0 place-items-center rounded-xl text-base font-black"
                style={
                  mine
                    ? { background: 'var(--accent)', color: 'var(--color-ink)' }
                    : { background: 'var(--color-surface-2)', color: 'var(--color-muted)' }
                }
              >
                {LABELS[index]}
              </span>
              <span className="flex-1 break-words">{hiddenOptions.includes(index) ? '📺 الفار استبعد الاختيار ده' : option}</span>
            </button>
          );
        })}
      </div>

      <RoundActionStatus error={error} pending={pending} />

      <LockStatus
        locked={locked}
        lockedCount={view.lockedCount}
        total={view.totalPlayers}
      />
    </div>
  );
}

export function LockStatus({
  locked,
  lockedCount,
  total,
}: {
  locked: boolean;
  lockedCount: number;
  total: number;
}) {
  return (
    <div className="mt-auto text-center" aria-live="polite">
      {locked ? (
        <p className="font-bold" style={{ color: 'var(--accent)' }}>
          {ar.locked} — {ar.waitingForOthers}
        </p>
      ) : null}
      <p className="tabular mt-1 text-sm text-muted">
        {lockedCount} / {total} خلصوا
      </p>
    </div>
  );
}
