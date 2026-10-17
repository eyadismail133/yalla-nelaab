import { useState } from 'react';
import type { RoomView } from '@game/shared';
import { ar } from '../i18n/ar.js';
import { Button, TextField } from '../ui/primitives.js';
import { playerTint } from '../ui/playerColors.js';
import { LockStatus } from './McqRaceRound.js';
import type {
  EmojiRushView,
  HigherLowerView,
  LadderView,
  OddOneOutView,
  RelayView,
  RoundProps,
  WordRaceView,
} from './types.js';
import {
  RoundActionStatus,
  reconcileSubmittedDraft,
  useRoundAction,
} from './useRoundAction.js';

const LABELS = ['أ', 'ب', 'ج', 'د'];

/* ------------------------------------------------------------------ الدخيل */

export function OddOneOutRound({ view, roundNo, client }: RoundProps<OddOneOutView>) {
  const { pending, error, act } = useRoundAction(client, roundNo);

  return (
    <div className="flex flex-1 flex-col gap-5">
      <p className="text-center text-sm text-muted">{ar.oddOneOutHint}</p>

      <div className="flex flex-col gap-4">
        {view.puzzles.map((puzzle, puzzleIndex) => {
          const mine = view.myAnswers[puzzleIndex] ?? null;
          const answered = mine !== null;
          return (
            <div key={puzzle.textAr} className="rounded-2xl border border-line bg-surface p-4">
              <p className="mb-3 text-center font-bold">{puzzle.textAr}</p>
              <div className="grid grid-cols-2 gap-2">
                {puzzle.items.map((item, itemIndex) => {
                  const picked = mine === itemIndex;
                  return (
                    <button
                      key={item}
                      type="button"
                      onClick={() => {
                        if (!answered && !pending) {
                          void act({ kind: 'answer', index: puzzleIndex, choice: itemIndex });
                        }
                      }}
                      disabled={answered || pending}
                      className={`min-h-14 rounded-xl border-2 px-3 text-center font-bold transition active:scale-[0.98] ${
                        picked
                          ? 'border-[var(--accent)] bg-surface-2'
                          : 'border-line bg-surface disabled:opacity-45'
                      }`}
                    >
                      {item}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <RoundActionStatus error={error} pending={pending} />

      <LockStatus locked={view.isDone} lockedCount={view.lockedCount} total={view.totalPlayers} />
    </div>
  );
}

/* ------------------------------------------------------------------ إيموجي */

export function EmojiRushRound({
  view,
  roundNo,
  client,
  categories,
}: RoundProps<EmojiRushView> & { categories: RoomView['availableCategories'] }) {
  const [text, setText] = useState('');
  const { pending, error, submitDraft } = useRoundAction(client, roundNo);

  const submit = () => {
    if (!text.trim() || !view.current || pending) return;
    void submitDraft(text, setText, (submittedText) => ({ kind: 'submit', text: submittedText }));
  };

  if (view.isDone || !view.current) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <p className="text-3xl font-black" style={{ color: 'var(--accent)' }}>
          خلصت الخمسة 🎉
        </p>
        <p className="text-muted">{ar.waitingForOthers}</p>
      </div>
    );
  }

  const category = categories.find((c) => c.id === view.current!.categoryId);

  return (
    <div className="flex flex-1 flex-col gap-6">
      <div className="flex justify-center gap-2">
        {Array.from({ length: view.totalItems }, (_, i) => (
          <span
            key={i}
            className="h-2 w-8 rounded-full transition"
            style={{
              background: i < view.solvedCount ? 'var(--accent)' : 'var(--color-surface-2)',
            }}
          />
        ))}
      </div>

      <p className="flex flex-1 items-center justify-center text-center text-6xl leading-relaxed">
        {view.current.emojis}
      </p>
      {category ? (
        <p className="-mt-4 text-center text-sm font-bold text-muted">
          {category.emoji} {category.nameAr}
        </p>
      ) : null}
      {view.current.hintAr ? (
        <p className="text-center text-sm text-muted">{view.current.hintAr}</p>
      ) : null}

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
          aria-label={ar.typeAnswer}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={ar.typeAnswer}
          className="text-center font-bold"
        />
        <Button type="submit" variant="accent" disabled={!text.trim() || pending}>
          {pending ? ar.sendingAction : ar.submit}
        </Button>
      </form>

      <RoundActionStatus error={error} pending={pending} />

      <p className="tabular mt-auto text-center text-sm text-muted">
        {view.solvedCount} / {view.totalItems} {ar.emojiSolved}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ السلّم */

export function LadderRound({ view, roundNo, client }: RoundProps<LadderView>) {
  const { pending, error, act } = useRoundAction(client, roundNo);

  const answer = (choice: number) => {
    if (view.current && !pending) {
      void act({ kind: 'answer', choice });
    }
  };

  return (
    <div className="flex flex-1 flex-col gap-5">
      {/* The ladder itself — climbed rungs lit, the current one ringed. */}
      <div className="flex justify-center gap-1.5">
        {view.ladder.map((value, i) => {
          const rungNumber = i + 1;
          const climbed = rungNumber <= view.rung;
          const isCurrent = rungNumber === view.rung + 1 && !view.isBusted && !view.isLocked;
          return (
            <div
              key={value}
              className={`tabular flex flex-1 flex-col items-center gap-1 rounded-xl border-2 py-2 text-xs font-black transition ${
                isCurrent ? 'border-[var(--accent)]' : 'border-transparent'
              }`}
              style={{
                background: climbed ? 'var(--accent)' : 'var(--color-surface-2)',
                color: climbed ? 'var(--color-ink)' : 'var(--color-muted)',
              }}
            >
              {value}
            </div>
          );
        })}
      </div>

      {view.isBusted ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <p className="text-3xl font-black text-accent-rose">{ar.ladderBusted}</p>
        </div>
      ) : view.isLocked ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <p className="text-sm text-muted">{ar.ladderBankedAt}</p>
          <p className="tabular text-4xl font-black" style={{ color: 'var(--accent)' }}>
            {view.bankedValue}
          </p>
        </div>
      ) : view.current ? (
        <>
          <p className="text-balance text-center text-xl font-bold leading-relaxed">
            {view.current.textAr}
          </p>
          <div className="grid gap-3">
            {view.current.options.map((option, index) => (
              <button
                key={option}
                type="button"
                disabled={pending}
                onClick={() => answer(index)}
                className="flex min-h-14 items-center gap-3 rounded-2xl border border-line bg-surface px-4 text-start text-lg font-bold transition active:scale-[0.99] disabled:opacity-45"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-sm font-black text-muted">
                  {LABELS[index]}
                </span>
                <span className="flex-1 break-words">{option}</span>
              </button>
            ))}
          </div>
          {view.rung > 0 ? (
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => void act({ kind: 'lock' })}
            >
              {ar.ladderBank} ({view.ladder[view.rung - 1]})
            </Button>
          ) : (
            <p className="text-center text-sm text-muted">{ar.ladderKeepGoing}</p>
          )}
        </>
      ) : (
        <p className="mt-auto text-center text-muted">{ar.waitingForOthers}</p>
      )}

      <RoundActionStatus error={error} pending={pending} />

      <p className="tabular text-center text-sm text-muted">
        {view.doneCount} / {view.totalPlayers} خلصوا
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ أعلى ولا أقل؟ */

export function HigherLowerRound({ view, roundNo, client }: RoundProps<HigherLowerView>) {
  const { pending, error, act } = useRoundAction(client, roundNo);

  if (view.isDone || !view.current) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <p className="text-3xl font-black" style={{ color: 'var(--accent)' }}>
          خلصت الأزواج
        </p>
        <p className="text-muted">{ar.waitingForOthers}</p>
      </div>
    );
  }

  const choose = (side: 'a' | 'b') => {
    if (pending || !view.current) return;
    void act({ kind: 'choose', index: view.current.index, side });
  };

  return (
    <div className="flex flex-1 flex-col gap-6">
      <div className="flex justify-center gap-2">
        {Array.from({ length: view.totalPairs }, (_, i) => (
          <span
            key={i}
            className="h-2 w-8 rounded-full transition"
            style={{
              background: i < view.answeredCount ? 'var(--accent)' : 'var(--color-surface-2)',
            }}
          />
        ))}
      </div>

      <p className="text-center text-sm text-muted">{ar.higherLowerWhichBigger}</p>

      <div className="flex flex-1 flex-col gap-3">
        {(['a', 'b'] as const).map((side) => {
          const item = view.current![side];
          return (
            <button
              key={side}
              type="button"
              disabled={pending}
              onClick={() => choose(side)}
              className="flex flex-1 flex-col items-center justify-center gap-1 rounded-2xl border-2 border-line bg-surface p-5 text-center transition active:scale-[0.98] disabled:opacity-45"
            >
              <p className="text-lg font-bold leading-relaxed">{item.textAr}</p>
              {item.unitAr ? <p className="text-sm text-muted">{item.unitAr}</p> : null}
            </button>
          );
        })}
      </div>

      <RoundActionStatus error={error} pending={pending} />
    </div>
  );
}

/* ------------------------------------------------------------------ التتابع */

export function RelayRound({
  view,
  roundNo,
  client,
  players,
}: RoundProps<RelayView> & { players: RoomView['players'] }) {
  const { pending, error, act } = useRoundAction(client, roundNo);
  const nameOf = (id: string | null) =>
    id ? players.find((p) => p.id === id)?.nickname ?? '؟' : '؟';

  return (
    <div className="flex flex-1 flex-col gap-5">
      <div className="flex items-center justify-between rounded-2xl border border-line bg-surface px-4 py-3">
        <div className="text-center">
          <p className="text-xs text-muted">{ar.relayTeamRung}</p>
          <p className="tabular text-2xl font-black" style={{ color: 'var(--accent)' }}>
            {view.myRung} / {view.totalRungs}
          </p>
        </div>
        {view.otherTeams.map((team) => (
          <div key={team.teamId} className="text-center">
            <p className="text-xs text-muted">{ar.relayOtherTeam}</p>
            <p className="tabular text-2xl font-black text-muted">
              {team.rung} / {view.totalRungs}
            </p>
          </div>
        ))}
      </div>

      {view.canAnswer ? (
        <p className="text-center text-lg font-black" style={{ color: 'var(--accent)' }}>
          {ar.relayYourTurn}
        </p>
      ) : (
        <p className="text-center text-muted">
          {ar.relayWaitTurn} — {nameOf(view.activePlayerId)}
        </p>
      )}

      {view.current ? (
        <>
          <p className="text-balance text-center text-xl font-bold leading-relaxed">
            {view.current.textAr}
          </p>
          <div className="grid gap-3">
            {view.current.options.map((option, index) => (
              <button
                key={option}
                type="button"
                onClick={() => {
                  if (view.canAnswer && !pending) {
                    void act({ kind: 'answer', choice: index });
                  }
                }}
                disabled={!view.canAnswer || pending}
                className={`flex min-h-14 items-center gap-3 rounded-2xl border px-4 text-start text-lg font-bold transition active:scale-[0.99] ${
                  view.canAnswer && !pending
                    ? 'border-line bg-surface'
                    : 'border-line bg-surface opacity-60'
                }`}
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-sm font-black text-muted">
                  {LABELS[index]}
                </span>
                <span className="flex-1 break-words">{option}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="mt-auto text-center text-muted">{ar.waitingForOthers}</p>
      )}

      <RoundActionStatus error={error} pending={pending} />
    </div>
  );
}

/* ------------------------------------------------------------------ اسم حيوان جماد بلاد */

export function WordRaceRound({
  view,
  roundNo,
  client,
  players,
  meId,
}: RoundProps<WordRaceView> & { players: RoomView['players']; meId: string }) {
  if (view.stage === 'writing')
    return <WordRaceWriting view={view} roundNo={roundNo} client={client} />;
  return (
    <WordRaceVoting
      view={view}
      roundNo={roundNo}
      client={client}
      players={players}
      meId={meId}
    />
  );
}

function WordRaceWriting({ view, roundNo, client }: RoundProps<WordRaceView>) {
  const { pending, error, act } = useRoundAction(client, roundNo);
  const [drafts, setDrafts] = useState<string[]>(() =>
    view.stage === 'writing' ? view.fieldsAr.map(() => '') : [],
  );

  if (view.stage !== 'writing') return null;

  const submit = (field: number) => {
    const rawDraft = drafts[field] ?? '';
    const trimmed = rawDraft.trim();
    if (!trimmed || view.myAnswers[field] !== null || pending) return;
    void act({ kind: 'write', field, text: trimmed }, () => {
      setDrafts((prev) =>
        prev.map((val, i) => (i === field ? reconcileSubmittedDraft(val, rawDraft) : val)),
      );
    });
  };

  return (
    <div className="flex flex-1 flex-col gap-5">
      <div
        className="rounded-2xl border-2 px-4 py-3 text-center"
        style={{ borderColor: 'var(--accent)' }}
      >
        <p className="text-sm text-muted">{ar.wordRaceLetterIs}</p>
        <p className="text-4xl font-black" style={{ color: 'var(--accent)' }}>
          {view.letter}
        </p>
      </div>
      <p className="text-center text-sm text-muted">{ar.wordRaceFieldsHint}</p>

      <div className="flex flex-col gap-3">
        {view.fieldsAr.map((field, index) => {
          const mine = view.myAnswers[index];
          const locked = mine !== null;
          const currentDraft = drafts[index] ?? '';
          return (
            <form
              key={field}
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                submit(index);
              }}
            >
              <span className="w-16 shrink-0 text-sm font-bold text-muted">{field}</span>
              {locked ? (
                <div className="flex-1 rounded-2xl border-2 border-[var(--accent)] bg-surface px-4 py-3 font-bold">
                  {mine}
                </div>
              ) : (
                <>
                  <TextField
                    lang="ar"
                    dir="rtl"
                    inputMode="text"
                    enterKeyHint="send"
                    aria-label={field}
                    value={currentDraft}
                    onChange={(e) =>
                      setDrafts((prev) => prev.map((v, i) => (i === index ? e.target.value : v)))
                    }
                    placeholder={`${field}...`}
                    className="min-w-0 flex-1"
                  />
                  <button
                    type="submit"
                    disabled={!currentDraft.trim() || pending}
                    className="min-h-14 shrink-0 rounded-2xl border border-line bg-surface-2 px-3.5 text-sm font-bold text-body transition active:scale-[0.98] disabled:opacity-40"
                  >
                    {ar.submit}
                  </button>
                </>
              )}
            </form>
          );
        })}
      </div>

      <RoundActionStatus error={error} pending={pending} />

      <LockStatus
        locked={view.myAnswers.every((a) => a !== null)}
        lockedCount={view.lockedCount}
        total={view.totalPlayers}
      />
    </div>
  );
}

function WordRaceVoting({
  view,
  roundNo,
  client,
  players,
  meId,
}: RoundProps<WordRaceView> & { players: RoomView['players']; meId: string }) {
  const { pending, error, act } = useRoundAction(client, roundNo);
  if (view.stage !== 'voting') return null;
  const nameOf = (id: string) => players.find((p) => p.id === id)?.nickname ?? '؟';

  return (
    <div className="flex flex-1 flex-col gap-4">
      <p className="text-center text-sm text-muted">{ar.wordRaceVoteHint}</p>

      <div className="flex flex-col gap-4 overflow-y-auto">
        {view.table.map((row) => {
          const isMine = row.authorId === meId;
          return (
            <div key={row.authorId} className="rounded-2xl border border-line bg-surface p-3">
              <div className="mb-2 flex items-center gap-2">
                <span
                  className="grid size-7 shrink-0 place-items-center rounded-full text-xs font-black"
                  style={{
                    background: playerTint(players, row.authorId),
                    color: 'var(--color-ink)',
                  }}
                >
                  {nameOf(row.authorId).slice(0, 1)}
                </span>
                <span className="truncate font-bold">{nameOf(row.authorId)}</span>
              </div>
              <div className="flex flex-col gap-2">
                {row.fields.map((field, index) => {
                  if (!field.text) return null;
                  // Nobody can reject their own answer — the button just isn't there for it.
                  const canReject = !isMine && !field.rejectedByMe && !pending;
                  return (
                    <div
                      key={`${row.authorId}-${index}`}
                      className={`flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-sm ${
                        field.rejectedByMe ? 'bg-surface-2 opacity-60' : 'bg-surface'
                      }`}
                    >
                      <span className="min-w-0 flex-1 break-words font-bold">{field.text}</span>
                      {isMine ? (
                        <span className="tabular shrink-0 text-xs text-muted">
                          {ar.wordRaceReject} ({field.rejectedCount})
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            if (canReject) {
                              void act({
                                kind: 'reject',
                                authorId: row.authorId,
                                field: index,
                              });
                            }
                          }}
                          disabled={!canReject}
                          className="tabular shrink-0 text-xs font-bold text-accent-rose disabled:text-muted"
                        >
                          {field.rejectedByMe ? ar.wordRaceRejected : ar.wordRaceReject} (
                          {field.rejectedCount})
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <RoundActionStatus error={error} pending={pending} />

      {view.isReady ? (
        <p className="mt-auto text-center font-bold" style={{ color: 'var(--accent)' }}>
          {ar.locked}
        </p>
      ) : (
        <Button
          type="button"
          variant="accent"
          disabled={pending}
          onClick={() => void act({ kind: 'ready' })}
        >
          {pending ? ar.sendingAction : ar.wordRaceReady}
        </Button>
      )}
      <p className="tabular text-center text-sm text-muted">
        {view.readyCount} / {view.totalPlayers} خلصوا المراجعة
      </p>
    </div>
  );
}
