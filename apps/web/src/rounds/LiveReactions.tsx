import { useEffect, useState } from 'react';
import type { RoomView } from '@game/shared';
import type { GameTransport } from '../net/transport.js';
import { RoundActionStatus, useRoundAction } from './useRoundAction.js';

const REACTIONS = [{ emoji: '⚽', label: 'هدف' }, { emoji: '🟨', label: 'إنذار' }, { emoji: '😂', label: 'ضحك' }, { emoji: '🔥', label: 'عاش' }];

export function LiveReactions({ view, client }: { view: RoomView; client: GameTransport }) {
  const [now, setNow] = useState(() => client.serverNow());
  const [lastSent, setLastSent] = useState(0);
  const { pending, error, act } = useRoundAction(client, view.round?.roundNo ?? 0);
  useEffect(() => {
    const timer = setInterval(() => setNow(client.serverNow()), 500);
    return () => clearInterval(timer);
  }, [client]);
  return <aside className="mx-auto w-full max-w-md px-4 pb-4 text-center" aria-label="تفاعلات الماتش">
    <div className="flex flex-wrap justify-center gap-2">{REACTIONS.map(({ emoji, label }) => <button
      type="button" key={emoji} aria-label={label} disabled={pending || now - lastSent < 1_000}
      className="min-h-11 rounded-xl border border-line bg-surface px-3 text-xl disabled:opacity-40"
      onClick={() => { setLastSent(client.serverNow()); void act({ kind: 'reaction', emoji }); }}>
      {emoji}
    </button>)}</div>
    <div aria-live="polite" className="flex min-h-8 flex-wrap justify-center gap-2 pt-2">
      {(view.reactions ?? []).filter((reaction) => now - reaction.atMs < 3_000).map((reaction) => <span
        key={`${reaction.playerId}:${reaction.atMs}`} className="pop-in rounded-full bg-surface-2 px-2 py-1 text-sm">
        {reaction.emoji} {view.players.find((player) => player.id === reaction.playerId)?.nickname}
      </span>)}
    </div>
    <RoundActionStatus error={error} pending={pending} />
  </aside>;
}
