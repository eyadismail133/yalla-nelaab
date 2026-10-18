import { useRef, useState } from 'react';
import type { RoomView } from '@game/shared';
import { ResultShare } from '../experience/index.js';
import { ar } from '../i18n/ar.js';
import { Button, Card, Screen } from '../ui/primitives.js';
import { Scoreboard, TeamScoreboard } from './ResultScreen.js';
import type { GameTransport } from '../net/transport.js';

export function PodiumScreen({
  view,
  client,
  onLeave,
  onError,
}: {
  view: RoomView;
  client: GameTransport;
  onLeave: () => void;
  onError: (message: string) => void;
}) {
  const [rematchBusy, setRematchBusy] = useState(false);
  const [rematchError, setRematchError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const isTeamMatch = Boolean(view.config.teams || view.teamStandings.length > 0);
  const winningTeam = isTeamMatch && view.winningTeamId ? view.teams.find((t) => t.id === view.winningTeamId) : undefined;
  const winner = !isTeamMatch && view.winnerId ? view.players.find((p) => p.id === view.winnerId) : undefined;
  const abandoned = view.endReason === 'abandoned';

  const handleRematch = async () => {
    if (inFlightRef.current || rematchBusy) return;
    inFlightRef.current = true;
    setRematchBusy(true);
    setRematchError(null);
    try {
      const result = await client.rematch();
      if (!result.ok) {
        setRematchError(result.error);
        onError(result.error);
      }
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : 'حصلت مشكلة في بدء ماتش جديد';
      setRematchError(msg);
      onError(msg);
    } finally {
      inFlightRef.current = false;
      setRematchBusy(false);
    }
  };

  return (
    <Screen accent="amber">
      <Card className="podium-hero text-center">
        {abandoned ? (
          <p className="text-xl font-bold text-muted">{ar.endedEarly}</p>
        ) : isTeamMatch ? (
          winningTeam ? (
            <>
              <p className="text-6xl">{winningTeam.emoji}</p>
              <p className="mt-2 text-sm text-muted">{ar.winningTeam}</p>
              <p className="text-balance text-4xl font-black" style={{ color: 'var(--accent)' }}>
                {winningTeam.nameAr}
              </p>
            </>
          ) : (
            <>
              <p className="text-6xl">🤝</p>
              <p className="mt-2 text-xl font-bold">{ar.sharedWin}</p>
            </>
          )
        ) : winner ? (
          <>
            <p className="text-6xl">🏆</p>
            <p className="mt-2 text-sm text-muted">{ar.winner}</p>
            <p className="text-balance text-4xl font-black" style={{ color: 'var(--accent)' }}>
              {winner.nickname}
            </p>
            <p className="tabular mt-2 text-lg text-muted">
              {view.standings.find((s) => s.playerId === winner.id)?.total} {ar.points}
            </p>
          </>
        ) : (
          <>
            <p className="text-6xl">🤝</p>
            <p className="mt-2 text-xl font-bold">{ar.sharedWin}</p>
          </>
        )}
      </Card>

      {view.teamStandings.length > 0 ? <TeamScoreboard view={view} /> : null}
      <Scoreboard view={view} />

      <ResultShare view={view} onError={onError} />

      <div className="mt-auto flex flex-col gap-2 pt-4">
        {rematchError ? (
          <p role="alert" aria-live="assertive" className="text-center text-sm font-bold text-accent-rose">
            {rematchError}
          </p>
        ) : null}

        {view.you.isHost ? (
          <Button
            type="button"
            variant="accent"
            disabled={rematchBusy}
            onClick={() => void handleRematch()}
          >
            {rematchBusy ? ar.sendingAction : ar.rematch}
          </Button>
        ) : (
          <p className="text-center text-muted">{ar.waitingForHost}</p>
        )}
        <Button type="button" variant="ghost" disabled={rematchBusy} onClick={onLeave}>
          {ar.backHome}
        </Button>
      </div>
    </Screen>
  );
}
