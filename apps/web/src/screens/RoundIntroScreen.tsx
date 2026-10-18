import type { RoomView } from '@game/shared';
import { ar } from '../i18n/ar.js';
import { Screen } from '../ui/primitives.js';
import type { GameTransport } from '../net/transport.js';
import { MatchCards } from '../rounds/MatchCards.js';

/**
 * The three seconds that do most of the anti-boredom work.
 *
 * Announcing the game, its one-line rule and its scoring before the clock starts means players
 * never spend the first five seconds of a round working out what they are looking at — and the
 * full-screen accent change is what makes a ten-round match feel like ten different things.
 */
export function RoundIntroScreen({ view, client }: { view: RoomView; client?: GameTransport }) {
  const round = view.round!;
  const suddenDeath = view.phase === 'sudden_death_intro';

  return (
    <Screen accent={suddenDeath ? 'violet' : round.accent} className="justify-center text-center">
      <div className="pop-in flex flex-col items-center gap-4">
        {suddenDeath ? (
          <>
            <p className="text-sm font-bold uppercase tracking-widest text-muted">
              {ar.suddenDeathAttempt} {view.suddenDeath?.attempt}
            </p>
            <h1 className="text-5xl font-black" style={{ color: 'var(--accent)' }}>
              {ar.suddenDeath}
            </h1>
            <p className="text-lg text-muted">{ar.suddenDeathHint}</p>
          </>
        ) : (
          <>
            <p className="tabular text-sm font-bold tracking-widest text-muted">
              {ar.round} {round.index} {ar.of} {round.total}
            </p>

            {round.isFinalRound ? (
              <span
                className="rounded-full px-4 py-1.5 text-sm font-black text-ink"
                style={{ background: 'var(--accent)' }}
              >
                {ar.finalRound} — {ar.doublePoints}
              </span>
            ) : null}

            <h1 className="text-balance text-5xl font-black leading-tight" style={{ color: 'var(--accent)' }}>
              {round.nameAr}
            </h1>
            <p className="text-balance text-lg text-body/80">{round.taglineAr}</p>

            <div className="mt-2 rounded-2xl border border-line bg-surface px-5 py-3">
              <p className="text-sm text-muted">{round.scoringHintAr}</p>
            </div>
          </>
        )}

        {client && !suddenDeath ? <MatchCards view={view} client={client} /> : null}
        <p className="mt-6 animate-pulse text-2xl font-bold">{ar.getReady}</p>
      </div>
    </Screen>
  );
}
