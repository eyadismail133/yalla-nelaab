import { useState } from 'react';
import type { RoomView } from '@game/shared';
import { ar } from '../i18n/ar.js';
import { Button, TextField } from '../ui/primitives.js';
import { playerTint } from '../ui/playerColors.js';
import { useCountdown } from '../ui/useCountdown.js';
import { LockStatus } from './McqRaceRound.js';
import type {
  BiddingView,
  LandGrabView,
  OrderingView,
  RoundProps,
  StealView,
  WhoAmIView,
} from './types.js';

const LABELS = ['أ', 'ب', 'ج', 'د'];

/* ------------------------------------------------------------------ مين أنا؟ */

export function WhoAmIRound({ view, roundNo, client }: RoundProps<WhoAmIView>) {
  const [text, setText] = useState('');
  const exhausted = view.attemptsLeft === 0;
  // The clues are nine seconds apart now, which is long enough that "when does it drop?"
  // becomes a real question. Showing it turns dead waiting into the decision the round is
  // actually about: commit at this price, or hold for the next clue and a lower one.
  const untilNextHint = useCountdown(client, view.nextHintAtMs);

  const submit = () => {
    if (!text.trim() || view.hasSolved || exhausted) return;
    void client.act(roundNo, { kind: 'guess', text });
    setText('');
  };

  return (
    <div className="flex flex-1 flex-col gap-5">
      {/* The whole tension of the round is watching this number fall, so it is the headline. */}
      <div className="rounded-2xl border border-line bg-surface px-4 py-3 text-center">
        <p className="text-sm text-muted">{ar.pointsIfNow}</p>
        <p className="tabular text-4xl font-black" style={{ color: 'var(--accent)' }}>
          {view.pointsIfRightNow}
        </p>
        {view.nextHintAtMs !== null && view.pointsAfterNextHint !== null && !view.hasSolved ? (
          <p className="tabular mt-1 text-xs text-muted">
            {ar.nextHintIn} {Math.ceil(untilNextHint / 1000)}
            {ar.secondsShort} ← {view.pointsAfterNextHint}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        {view.hints.map((hint, i) => (
          <div
            key={hint}
            className="pop-in rounded-2xl border border-line bg-surface px-4 py-3 text-lg"
          >
            <span className="tabular me-2 text-sm text-muted">{i + 1}.</span>
            {hint}
          </div>
        ))}
        {Array.from({ length: view.totalHints - view.hints.length }, (_, i) => (
          <div
            key={`pending-${i}`}
            className="rounded-2xl border border-dashed border-line px-4 py-3 text-center text-sm text-muted"
          >
            {ar.hintComing}
          </div>
        ))}
      </div>

      {view.hasSolved ? (
        <p className="text-center text-2xl font-black" style={{ color: 'var(--accent)' }}>
          {ar.locked}
        </p>
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
    </div>
  );
}

/* ------------------------------------------------------------------ رتّب صح */

export function OrderingRound({ view, roundNo, client }: RoundProps<OrderingView>) {
  const placedSet = new Set(view.myOrder);

  return (
    <div className="flex flex-1 flex-col gap-5">
      <p className="text-balance text-center text-xl font-bold">{view.textAr}</p>

      <div className="flex flex-col gap-2">
        {view.myOrder.map((itemIndex, position) => (
          <div
            key={itemIndex}
            className="flex items-center gap-3 rounded-2xl border-2 px-4 py-3 font-bold"
            style={{ borderColor: 'var(--accent)' }}
          >
            <span
              className="tabular grid size-8 shrink-0 place-items-center rounded-lg text-sm font-black text-ink"
              style={{ background: 'var(--accent)' }}
            >
              {position + 1}
            </span>
            <span className="flex-1">{view.items[itemIndex]}</span>
          </div>
        ))}
      </div>

      {!view.isLocked ? (
        <>
          <div className="flex flex-col gap-2">
            {view.items.map((label, index) =>
              placedSet.has(index) ? null : (
                <button
                  key={label}
                  onClick={() => void client.act(roundNo, { kind: 'place', index })}
                  className="min-h-14 rounded-2xl border border-line bg-surface px-4 text-lg font-bold transition active:scale-[0.99]"
                >
                  {label}
                </button>
              ),
            )}
          </div>

          {view.myOrder.length > 0 ? (
            <Button variant="ghost" onClick={() => void client.act(roundNo, { kind: 'undo' })}>
              {ar.undo}
            </Button>
          ) : null}
        </>
      ) : (
        <p className="text-center font-bold" style={{ color: 'var(--accent)' }}>
          {ar.locked}
        </p>
      )}

      <LockStatus
        locked={view.isLocked}
        lockedCount={view.lockedCount}
        total={view.totalPlayers}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ السرقة */

export function StealRound({
  view,
  roundNo,
  client,
  players,
}: RoundProps<StealView> & { players: RoomView['players'] }) {
  const nameOf = (id: string) => players.find((p) => p.id === id)?.nickname ?? '؟';

  if (view.stage === 'answering') {
    return (
      <div className="flex flex-1 flex-col gap-6">
        <p className="text-balance text-center text-2xl font-bold leading-relaxed">{view.textAr}</p>
        <div className="grid gap-3">
          {view.options.map((option, index) => {
            const mine = view.myChoice === index;
            return (
              <button
                key={option}
                onClick={() => {
                  if (!view.hasAnswered) void client.act(roundNo, { kind: 'answer', choice: index });
                }}
                disabled={view.hasAnswered}
                className={`flex min-h-16 items-center gap-3 rounded-2xl border-2 px-4 text-start text-lg font-bold transition active:scale-[0.99] ${
                  mine ? 'border-[var(--accent)] bg-surface-2' : 'border-line bg-surface disabled:opacity-45'
                }`}
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-base font-black text-muted">
                  {LABELS[index]}
                </span>
                <span className="flex-1">{option}</span>
              </button>
            );
          })}
        </div>
        <LockStatus
          locked={view.hasAnswered}
          lockedCount={view.lockedCount}
          total={view.totalPlayers}
        />
      </div>
    );
  }

  if (!view.iWasCorrect) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <p className="text-2xl font-black text-muted">{ar.cannotSteal}</p>
        <p className="text-muted">{ar.waitingForOthers}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-5">
      <div className="rounded-2xl border-2 px-4 py-3 text-center" style={{ borderColor: 'var(--accent)' }}>
        <p className="text-lg font-black" style={{ color: 'var(--accent)' }}>
          {ar.youWereRight}
        </p>
        <p className="mt-1 text-sm text-muted">{ar.stealHint}</p>
      </div>

      <div className="grid gap-3">
        {view.targets.map((id) => {
          const picked = view.myTarget === id;
          return (
            <button
              key={id}
              onClick={() => {
                if (!view.hasActed) void client.act(roundNo, { kind: 'steal', targetId: id });
              }}
              disabled={view.hasActed}
              className={`flex min-h-16 items-center gap-3 rounded-2xl border-2 px-4 text-start text-lg font-bold transition active:scale-[0.99] ${
                picked ? 'border-[var(--accent)] bg-surface-2' : 'border-line bg-surface disabled:opacity-45'
              }`}
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-full bg-surface-2 font-black">
                {nameOf(id).slice(0, 1)}
              </span>
              <span className="flex-1">{nameOf(id)}</span>
            </button>
          );
        })}
      </div>

      {!view.hasActed ? (
        <Button variant="ghost" onClick={() => void client.act(roundNo, { kind: 'pass' })}>
          {ar.passSteal}
        </Button>
      ) : (
        <p className="text-center font-bold" style={{ color: 'var(--accent)' }}>
          {ar.locked}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ المزايدة */

export function BiddingRound({ view, roundNo, client }: RoundProps<BiddingView>) {
  if (view.stage === 'bidding') {
    return (
      <div className="flex flex-1 flex-col justify-center gap-6 text-center">
        <div>
          <p className="text-balance text-2xl font-bold leading-relaxed">{ar.bidPrompt}</p>
          <p className="mt-2 text-muted">{ar.bidHint}</p>
        </div>

        <div className="grid grid-cols-4 gap-3">
          {Array.from({ length: view.maxBid }, (_, i) => i + 1).map((amount) => {
            const picked = view.myBid === amount;
            return (
              <button
                key={amount}
                onClick={() => {
                  if (view.myBid === null) void client.act(roundNo, { kind: 'bid', amount });
                }}
                disabled={view.myBid !== null}
                className={`flex min-h-24 flex-col items-center justify-center rounded-2xl border-2 transition active:scale-[0.98] ${
                  picked ? 'border-[var(--accent)] bg-surface-2' : 'border-line bg-surface disabled:opacity-40'
                }`}
              >
                <span className="tabular text-3xl font-black">{amount}</span>
                <span className="tabular mt-1 text-xs text-muted">
                  {amount * view.pointsPerBid}
                </span>
              </button>
            );
          })}
        </div>

        <LockStatus
          locked={view.myBid !== null}
          lockedCount={view.lockedCount}
          total={view.totalPlayers}
        />
      </div>
    );
  }

  if (view.isDone || !view.current) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <p className="text-2xl font-black" style={{ color: 'var(--accent)' }}>
          خلصت الأسئلة
        </p>
        <p className="text-muted">{ar.waitingForOthers}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-5">
      <div className="flex items-center justify-between rounded-2xl border border-line bg-surface px-4 py-2">
        <span className="text-sm text-muted">{ar.yourBid}</span>
        <span className="tabular text-2xl font-black" style={{ color: 'var(--accent)' }}>
          {view.myBid}
        </span>
      </div>

      <div className="flex justify-center gap-2">
        {Array.from({ length: view.totalQuestions }, (_, i) => (
          <span
            key={i}
            className="h-2 w-8 rounded-full transition"
            style={{ background: i < view.answeredCount ? 'var(--accent)' : 'var(--color-surface-2)' }}
          />
        ))}
      </div>

      <p className="text-balance text-center text-xl font-bold leading-relaxed">
        {view.current.textAr}
      </p>

      <div className="grid gap-3">
        {view.current.options.map((option, index) => (
          <button
            key={option}
            onClick={() =>
              void client.act(roundNo, { kind: 'answer', index: view.current!.index, choice: index })
            }
            className="flex min-h-14 items-center gap-3 rounded-2xl border border-line bg-surface px-4 text-start text-lg font-bold transition active:scale-[0.99]"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-sm font-black text-muted">
              {LABELS[index]}
            </span>
            <span className="flex-1">{option}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ قطع الأرض */

export function LandGrabRound({
  view,
  roundNo,
  client,
  players,
  meId,
}: RoundProps<LandGrabView> & { players: RoomView['players']; meId: string }) {
  const tintOf = (ownerId: string | null) => (ownerId ? playerTint(players, ownerId) : null);
  // 3×3 for a small room, 4×4 for a big one — the board decides, not the layout.
  const side = Math.round(Math.sqrt(view.board.length));

  if (view.openCell) {
    return (
      <div className="flex flex-1 flex-col gap-5">
        <p className="text-center text-sm text-muted">
          {ar.cellNumber} {view.openCell.cell + 1}
        </p>
        <p className="text-balance text-center text-xl font-bold leading-relaxed">
          {view.openCell.textAr}
        </p>
        <div className="grid gap-3">
          {view.openCell.options.map((option, index) => (
            <button
              key={option}
              onClick={() =>
                void client.act(roundNo, {
                  kind: 'answer',
                  cell: view.openCell!.cell,
                  choice: index,
                })
              }
              className="flex min-h-14 items-center gap-3 rounded-2xl border border-line bg-surface px-4 text-start text-lg font-bold transition active:scale-[0.99]"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-sm font-black text-muted">
                {LABELS[index]}
              </span>
              <span className="flex-1">{option}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-5">
      <p className="text-center text-muted">{ar.pickACell}</p>

      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(${side}, minmax(0, 1fr))` }}
      >
        {view.board.map((cell) => {
          const tint = tintOf(cell.ownerId);
          const mine = cell.ownerId === meId;
          const taken = cell.ownerId !== null;

          return (
            <button
              key={cell.cell}
              onClick={() => {
                if (!taken && !cell.failedByMe) void client.act(roundNo, { kind: 'open', cell: cell.cell });
              }}
              disabled={taken || cell.failedByMe}
              className={`tabular grid aspect-square place-items-center rounded-2xl border-2 text-2xl font-black transition active:scale-[0.97] ${
                cell.failedByMe && !taken ? 'border-dashed border-line text-muted opacity-40' : ''
              }`}
              style={
                tint
                  ? { background: tint, borderColor: tint, color: 'var(--color-ink)' }
                  : { borderColor: 'var(--color-line)', background: 'var(--color-surface)' }
              }
            >
              {taken ? (mine ? '★' : '●') : cell.cell + 1}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap justify-center gap-3">
        {players.map((player) => (
          <span key={player.id} className="flex items-center gap-1.5 text-sm">
            <span className="size-3 rounded-full" style={{ background: playerTint(players, player.id) }} />
            {player.nickname}
          </span>
        ))}
      </div>

      <p className="tabular mt-auto text-center text-sm text-muted">
        {ar.yourCells}: {view.myCells} / {view.totalCells}
      </p>
    </div>
  );
}
