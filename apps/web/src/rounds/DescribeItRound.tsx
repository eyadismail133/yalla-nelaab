import { useState } from 'react';
import { ar } from '../i18n/ar.js';
import { Button, TextField } from '../ui/primitives.js';
import type { DescribeItView, RoundProps } from './types.js';

export function DescribeItRound({ view, roundNo, client }: RoundProps<DescribeItView>) {
  const [text, setText] = useState('');

  const send = () => {
    if (!text.trim()) return;
    void client.act(roundNo, { kind: view.isDescriber ? 'clue' : 'guess', text });
    setText('');
  };

  if (view.teamSolved) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <p className="text-5xl">🎉</p>
        <p className="text-3xl font-black" style={{ color: 'var(--accent)' }}>
          {ar.teamGotIt}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-5">
      {view.isDescriber ? (
        <div
          className="rounded-3xl border-2 bg-surface p-5 text-center"
          style={{ borderColor: 'var(--accent)' }}
        >
          <p className="text-sm text-muted">{ar.describeThis}</p>
          <p className="mt-1 text-3xl font-black" style={{ color: 'var(--accent)' }}>
            {view.secretAr}
          </p>
          <p className="mt-2 text-xs text-accent-rose">{ar.dontSayIt}</p>
        </div>
      ) : (
        <p className="text-center text-lg font-bold text-muted">{ar.guessFromClues}</p>
      )}

      <div className="flex flex-1 flex-col gap-2">
        {view.clues.length === 0 ? (
          <p className="py-6 text-center text-muted">{ar.noCluesYet}</p>
        ) : (
          view.clues.map((clue, i) => (
            <div
              key={`${clue}-${i}`}
              className="pop-in rounded-2xl border border-line bg-surface px-4 py-3 text-lg"
            >
              {clue}
            </div>
          ))
        )}
      </div>

      {view.lastClueRejected && view.isDescriber ? (
        <p className="text-center text-sm font-bold text-accent-rose">{ar.clueRejected}</p>
      ) : null}

      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <TextField
          value={text}
          maxLength={60}
          onChange={(e) => setText(e.target.value)}
          placeholder={view.isDescriber ? ar.writeClue : ar.typeAnswer}
          className="text-center font-bold"
        />
        <Button type="submit" variant="accent" disabled={!text.trim()}>
          {view.isDescriber ? ar.sendClue : ar.submit}
        </Button>
      </form>

      <p className="tabular text-center text-sm text-muted">
        {view.solvedTeams} / {view.totalTeams} {ar.teamsSolved}
      </p>
    </div>
  );
}
