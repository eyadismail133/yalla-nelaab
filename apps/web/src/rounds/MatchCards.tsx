import type { RoomView } from '@game/shared';
import type { GameTransport } from '../net/transport.js';
import { Button } from '../ui/primitives.js';
import { RoundActionStatus, useRoundAction } from './useRoundAction.js';

export function MatchCards({ view, client }: { view: RoomView; client: GameTransport }) {
  const { pending, error, act } = useRoundAction(client, view.round!.roundNo);
  const cards = view.you.cards;
  if (!cards || view.you.isSpectator) return null;
  const offerDouble = view.phase === 'round_intro' && cards.doubleAvailable;
  const roundView = view.round?.view as { hasAnswered?: boolean; hasGuessed?: boolean } | null;
  const offerVar = view.phase === 'in_round' && cards.varAvailable &&
    ['mcq_race', 'numeric_guess'].includes(view.round!.typeId) && !roundView?.hasAnswered && !roundView?.hasGuessed;
  if (!offerDouble && !offerVar && !cards.doubleActive && !cards.varHint) return null;
  return <aside aria-label="كروت الماتش" className="flex flex-col gap-2 rounded-2xl border border-line p-3 text-center">
    {offerDouble ? <Button variant="ghost" disabled={pending} onClick={() => void act({ kind: 'card', card: 'double_captain' })}>
      👑 الكابتن ×٢ — ضاعف نقط الجولة دي
    </Button> : null}
    {offerVar ? <Button variant="ghost" disabled={pending} onClick={() => void act({ kind: 'card', card: 'var' })}>
      📺 الفار — {view.round!.typeId === 'mcq_race' ? 'احذف اختيارين غلط' : 'خد تلميح للرقم'}
    </Button> : null}
    {cards.doubleActive ? <p className="text-sm font-bold">👑 الكابتن ×٢ شغّال للجولة دي</p> : null}
    {cards.varHint?.range ? <p className="tabular text-sm font-bold">📺 الرقم بين {cards.varHint.range[0]} و{cards.varHint.range[1]}</p> : null}
    <RoundActionStatus error={error} pending={pending} />
  </aside>;
}
