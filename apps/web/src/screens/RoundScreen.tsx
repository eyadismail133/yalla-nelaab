import type { RoomView } from '@game/shared';
import { ar } from '../i18n/ar.js';
import { CountdownRing, Screen } from '../ui/primitives.js';
import { useCountdown } from '../ui/useCountdown.js';
import type { GameClient } from '../net/client.js';
import { McqRaceRound } from '../rounds/McqRaceRound.js';
import { NumericGuessRound } from '../rounds/NumericGuessRound.js';
import { QuickfireRound } from '../rounds/QuickfireRound.js';
import { FillBlankRound } from '../rounds/FillBlankRound.js';
import { FibbingRound } from '../rounds/FibbingRound.js';
import { WhoAmongUsRound } from '../rounds/WhoAmongUsRound.js';
import {
  BiddingRound,
  LandGrabRound,
  OrderingRound,
  StealRound,
  WhoAmIRound,
} from '../rounds/NewRounds.js';
import { DescribeItRound } from '../rounds/DescribeItRound.js';
import {
  EmojiRushRound,
  HigherLowerRound,
  LadderRound,
  OddOneOutRound,
  RelayRound,
  WordRaceRound,
} from '../rounds/ExpansionRounds.js';
import type {
  BiddingView,
  DescribeItView,
  EmojiRushView,
  FibbingView,
  FillBlankView,
  HigherLowerView,
  LadderView,
  LandGrabView,
  OddOneOutView,
  OrderingView,
  RelayView,
  StealView,
  WhoAmIView,
  WordRaceView,
  McqRaceView,
  NumericGuessView,
  QuickfireView,
  WhoAmongUsView,
} from '../rounds/types.js';

export function RoundScreen({ view, client }: { view: RoomView; client: GameClient }) {
  const round = view.round!;
  const remaining = useCountdown(client, view.phaseEndsAtMs);
  const suddenDeath = view.phase === 'sudden_death';
  const spectating =
    suddenDeath && !!view.suddenDeath && !view.suddenDeath.contenders.includes(view.you.id);

  const totalMs = view.phaseEndsAtMs && round ? guessRoundLength(view) : 1;

  return (
    <Screen accent={suddenDeath ? 'violet' : round.accent}>
      <header className="flex items-center gap-3">
        <CountdownRing remainingMs={remaining} totalMs={totalMs} />
        <div className="flex-1">
          <p className="font-bold">{suddenDeath ? ar.suddenDeath : round.nameAr}</p>
          <p className="tabular text-sm text-muted">
            {suddenDeath ? ar.suddenDeathHint : `${ar.round} ${round.index} ${ar.of} ${round.total}`}
          </p>
        </div>
        {round.isFinalRound && !suddenDeath ? (
          <span
            className="rounded-full px-3 py-1 text-xs font-black text-ink"
            style={{ background: 'var(--accent)' }}
          >
            ×٢
          </span>
        ) : null}
      </header>

      {spectating ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <p className="text-2xl font-black" style={{ color: 'var(--accent)' }}>
            {ar.spectating}
          </p>
          <p className="text-muted">{ar.suddenDeathHint}</p>
        </div>
      ) : (
        <RoundBody view={view} client={client} />
      )}
    </Screen>
  );
}

function RoundBody({ view, client }: { view: RoomView; client: GameClient }) {
  const round = view.round!;
  const props = { roundNo: round.roundNo, client };

  switch (round.typeId) {
    case 'mcq_race':
      return <McqRaceRound {...props} view={round.view as McqRaceView} />;
    case 'numeric_guess':
      return <NumericGuessRound {...props} view={round.view as NumericGuessView} />;
    case 'quickfire_tf':
      return <QuickfireRound {...props} view={round.view as QuickfireView} />;
    case 'fill_blank':
      return <FillBlankRound {...props} view={round.view as FillBlankView} />;
    case 'fibbing':
      return <FibbingRound {...props} view={round.view as FibbingView} />;
    case 'who_among_us':
      return (
        <WhoAmongUsRound
          {...props}
          view={round.view as WhoAmongUsView}
          players={view.players}
        />
      );
    case 'describe_it':
      return <DescribeItRound {...props} view={round.view as DescribeItView} />;
    case 'who_am_i':
      return <WhoAmIRound {...props} view={round.view as WhoAmIView} />;
    case 'ordering':
      return <OrderingRound {...props} view={round.view as OrderingView} />;
    case 'bidding':
      return <BiddingRound {...props} view={round.view as BiddingView} />;
    case 'steal':
      return <StealRound {...props} view={round.view as StealView} players={view.players} />;
    case 'land_grab':
      return (
        <LandGrabRound
          {...props}
          view={round.view as LandGrabView}
          players={view.players}
          meId={view.you.id}
        />
      );
    case 'odd_one_out':
      return <OddOneOutRound {...props} view={round.view as OddOneOutView} />;
    case 'emoji_rush':
      return (
        <EmojiRushRound
          {...props}
          view={round.view as EmojiRushView}
          categories={view.availableCategories}
        />
      );
    case 'ladder':
      return <LadderRound {...props} view={round.view as LadderView} />;
    case 'higher_lower':
      return <HigherLowerRound {...props} view={round.view as HigherLowerView} />;
    case 'relay':
      return <RelayRound {...props} view={round.view as RelayView} players={view.players} />;
    case 'word_race':
      return (
        <WordRaceRound
          {...props}
          view={round.view as WordRaceView}
          players={view.players}
          meId={view.you.id}
        />
      );
    default:
      return <p className="text-center text-muted">اللعبة دي لسه مش جاهزة</p>;
  }
}

/**
 * Round length is not in the view, so it is derived from the deadline the first time a round
 * renders. Only the ring's fill ratio depends on it — the seconds shown always come straight
 * from the server deadline, so a bad estimate can never mislead a player about their time.
 *
 * Bounded because round numbers only ever climb: an unbounded map would grow for every round
 * of every match for as long as the tab stays open.
 */
const lengths = new Map<number, number>();
function guessRoundLength(view: RoomView): number {
  const key = view.round!.roundNo;
  const existing = lengths.get(key);
  if (existing) return existing;

  const total = Math.max(1, (view.phaseEndsAtMs ?? 0) - view.serverNowMs);
  if (lengths.size > 32) {
    for (const stale of [...lengths.keys()].slice(0, 16)) lengths.delete(stale);
  }
  lengths.set(key, total);
  return total;
}
