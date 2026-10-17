import { useState } from 'react';
import { ar } from '../i18n/ar.js';
import { Button, TextField } from '../ui/primitives.js';
import { LockStatus } from './McqRaceRound.js';
import type { FibbingView, RoundProps } from './types.js';
import { RoundActionStatus, useRoundAction } from './useRoundAction.js';

export function FibbingRound({ view, roundNo, client }: RoundProps<FibbingView>) {
  if (view.stage === 'writing') return <WritingStage view={view} roundNo={roundNo} client={client} />;
  return <VotingStage view={view} roundNo={roundNo} client={client} />;
}

function WritingStage({ view, roundNo, client }: RoundProps<FibbingView>) {
  const [text, setText] = useState('');
  const { pending, error, submitDraft } = useRoundAction(client, roundNo);
  if (view.stage !== 'writing') return null;

  const submit = () => {
    if (!text.trim() || view.myLie || pending) return;
    void submitDraft(text, setText, (submittedText) => ({ kind: 'lie', text: submittedText }));
  };

  return (
    <div className="flex flex-1 flex-col gap-6">
      <p className="text-balance text-center text-2xl font-bold leading-relaxed">{view.textAr}</p>

      {view.myLie ? (
        <div className="rounded-3xl border-2 border-[var(--accent)] bg-surface p-6 text-center">
          <p className="text-sm text-muted">{ar.yourLie}</p>
          <p className="mt-2 text-2xl font-black" style={{ color: 'var(--accent)' }}>
            {view.myLie}
          </p>
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
            autoFocus
            lang="ar"
            dir="rtl"
            inputMode="text"
            enterKeyHint="send"
            aria-label={ar.writeLie}
            value={text}
            maxLength={60}
            onChange={(e) => setText(e.target.value)}
            placeholder={ar.writeLie}
            className="text-center font-bold"
          />
          <Button type="submit" variant="accent" disabled={!text.trim() || pending}>
            {pending ? ar.sendingAction : ar.submit}
          </Button>
          <p className="text-center text-sm text-muted">{ar.fibbingWriteHint}</p>
        </form>
      )}

      <RoundActionStatus error={error} pending={pending} />

      <LockStatus
        locked={!!view.myLie}
        lockedCount={view.lockedCount}
        total={view.totalPlayers}
      />
    </div>
  );
}

function VotingStage({ view, roundNo, client }: RoundProps<FibbingView>) {
  const { pending, error, act } = useRoundAction(client, roundNo);
  if (view.stage !== 'voting') return null;

  const choose = (optionId: string) => {
    if (view.myVote || view.myOptionIds.includes(optionId) || pending) return;
    void act({ kind: 'vote', optionId });
  };

  return (
    <div className="flex flex-1 flex-col gap-5">
      <p className="text-balance text-center text-xl font-bold leading-relaxed">{view.textAr}</p>
      <p className="text-center text-sm text-muted">{ar.fibbingVoteHint}</p>

      <div className="grid gap-3">
        {view.options.map((option) => {
          const mine = view.myOptionIds.includes(option.id);
          const picked = view.myVote === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => choose(option.id)}
              disabled={mine || !!view.myVote || pending}
              className={`min-h-16 rounded-2xl border-2 px-4 py-3 text-center text-lg font-bold transition active:scale-[0.99] ${
                picked
                  ? 'border-[var(--accent)] bg-surface-2'
                  : mine
                    ? 'border-dashed border-line bg-surface text-muted'
                    : 'border-line bg-surface disabled:opacity-45'
              }`}
            >
              {option.textAr}
              {/* Your own lie stays visible but unpickable — hiding it would make the list
                  inconsistent between players and give away which one is yours. */}
              {mine ? <span className="ms-2 text-xs">({ar.yourLie})</span> : null}
            </button>
          );
        })}
      </div>

      <RoundActionStatus error={error} pending={pending} />

      <LockStatus
        locked={!!view.myVote}
        lockedCount={view.lockedCount}
        total={view.totalPlayers}
      />
    </div>
  );
}
