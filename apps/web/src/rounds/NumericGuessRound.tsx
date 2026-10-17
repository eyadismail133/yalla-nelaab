import { useState } from 'react';
import { parseNumericAnswer } from '@game/shared';
import { ar } from '../i18n/ar.js';
import { Button, TextField } from '../ui/primitives.js';
import { LockStatus } from './McqRaceRound.js';
import type { NumericGuessView, RoundProps } from './types.js';
import { RoundActionStatus, useRoundAction } from './useRoundAction.js';

export function NumericGuessRound({ view, roundNo, client }: RoundProps<NumericGuessView>) {
  const [text, setText] = useState('');
  const { pending, error, submitDraft } = useRoundAction(client, roundNo);
  const parsed = parseNumericAnswer(text);

  const submit = () => {
    if (parsed === null || view.hasGuessed || pending) return;
    const value = parsed;
    void submitDraft(text, setText, () => ({ kind: 'guess', value }));
  };

  return (
    <div className="flex flex-1 flex-col gap-6">
      <p className="text-balance text-center text-2xl font-bold leading-relaxed">{view.textAr}</p>

      {view.hasGuessed ? (
        <div className="rounded-3xl border-2 border-[var(--accent)] bg-surface p-6 text-center">
          <p className="text-sm text-muted">{ar.yourAnswer}</p>
          <p className="tabular mt-1 text-4xl font-black" style={{ color: 'var(--accent)' }}>
            {view.myGuess}
          </p>
          {view.unitAr ? <p className="mt-1 text-sm text-muted">{view.unitAr}</p> : null}
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <TextField
            // `inputMode="numeric"` raises the number pad on phones without blocking Arabic-Indic
            // digits, which parseNumericAnswer accepts either way.
            inputMode="numeric"
            enterKeyHint="send"
            aria-label={view.unitAr ? `${ar.typeNumber} (${view.unitAr})` : ar.typeNumber}
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={view.unitAr ? `${ar.typeNumber} (${view.unitAr})` : ar.typeNumber}
            className="tabular text-center text-2xl font-black"
          />
          <Button type="submit" variant="accent" disabled={parsed === null || pending}>
            {pending ? ar.sendingAction : ar.submit}
          </Button>
        </form>
      )}

      <RoundActionStatus error={error} pending={pending} />

      <LockStatus
        locked={view.hasGuessed}
        lockedCount={view.lockedCount}
        total={view.totalPlayers}
      />
    </div>
  );
}
