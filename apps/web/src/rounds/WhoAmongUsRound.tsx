import type { RoomView } from '@game/shared';
import { ar } from '../i18n/ar.js';
import { playerTint } from '../ui/playerColors.js';
import { LockStatus } from './McqRaceRound.js';
import type { RoundProps, WhoAmongUsView } from './types.js';

export function WhoAmongUsRound({
  view,
  roundNo,
  client,
  players,
}: RoundProps<WhoAmongUsView> & { players: RoomView['players'] }) {
  const nameOf = (id: string) => players.find((p) => p.id === id)?.nickname ?? '؟';

  const vote = (targetId: string) => {
    if (view.hasVoted) return;
    void client.act(roundNo, { kind: 'vote', targetId });
  };

  return (
    <div className="flex flex-1 flex-col gap-6">
      <p className="text-balance text-center text-2xl font-bold leading-relaxed">{view.textAr}</p>

      <div className="grid gap-3">
        {view.candidates.map((id) => {
          const picked = view.myVote === id;
          return (
            <button
              key={id}
              onClick={() => vote(id)}
              disabled={view.hasVoted}
              className={`flex min-h-16 items-center gap-3 rounded-2xl border-2 px-4 text-start text-lg font-bold transition active:scale-[0.99] ${
                picked
                  ? 'border-[var(--accent)] bg-surface-2'
                  : 'border-line bg-surface disabled:opacity-45'
              }`}
            >
              <span
                className="grid size-10 shrink-0 place-items-center rounded-full text-lg font-black"
                style={{ background: playerTint(players, id), color: 'var(--color-ink)' }}
              >
                {nameOf(id).slice(0, 1)}
              </span>
              <span className="flex-1">{nameOf(id)}</span>
            </button>
          );
        })}
      </div>

      <p className="text-center text-sm text-muted">{ar.whoAmongUsHint}</p>

      <LockStatus
        locked={view.hasVoted}
        lockedCount={view.lockedCount}
        total={view.totalPlayers}
      />
    </div>
  );
}
