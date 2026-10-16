import { useState } from 'react';
import { ar } from '../i18n/ar.js';
import { Button, TextField } from '../ui/primitives.js';
import type { FillBlankView, RoundProps } from './types.js';

export function FillBlankRound({ view, roundNo, client }: RoundProps<FillBlankView>) {
  const [text, setText] = useState('');
  const exhausted = view.attemptsLeft === 0;

  const submit = () => {
    if (!text.trim() || view.hasSolved || exhausted) return;
    void client.act(roundNo, { kind: 'submit', text });
    setText('');
  };

  const [before, after] = view.textAr.split('____');

  return (
    <div className="flex flex-1 flex-col gap-6">
      <p className="text-balance text-center text-2xl font-bold leading-loose">
        {before}
        <span
          className="mx-1 inline-block min-w-24 border-b-4 pb-1 align-bottom"
          style={{ borderColor: 'var(--accent)' }}
        />
        {after}
      </p>

      {view.hasSolved ? (
        <div className="rounded-3xl border-2 border-[var(--accent)] bg-surface p-6 text-center">
          <p className="text-2xl font-black" style={{ color: 'var(--accent)' }}>
            {ar.locked}
          </p>
        </div>
      ) : exhausted ? (
        <p className="text-center text-lg font-bold text-muted">خلصت محاولاتك</p>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <TextField
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={ar.typeAnswer}
            className="text-center font-bold"
          />
          <Button type="submit" variant="accent" disabled={!text.trim()}>
            {ar.submit}
          </Button>
          <p className="tabular text-center text-sm text-muted">
            {ar.attemptsLeft}: {view.attemptsLeft}
          </p>
        </form>
      )}

      {view.myAttempts.length > 0 && !view.hasSolved ? (
        <div className="flex flex-wrap justify-center gap-2">
          {view.myAttempts.map((attempt, i) => (
            <span
              key={`${attempt}-${i}`}
              className="rounded-full bg-surface-2 px-3 py-1 text-sm text-muted line-through"
            >
              {attempt}
            </span>
          ))}
        </div>
      ) : null}

      {/* A count, never names — knowing who solved it narrows the answer for everyone else. */}
      <p className="tabular mt-auto text-center text-sm text-muted">
        {view.solvedCount} / {view.totalPlayers} عرفوها
      </p>
    </div>
  );
}
