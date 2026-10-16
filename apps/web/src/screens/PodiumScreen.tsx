import type { RoomView } from '@game/shared';
import { ar } from '../i18n/ar.js';
import { Button, Card, Screen } from '../ui/primitives.js';
import { Scoreboard, TeamScoreboard } from './ResultScreen.js';
import type { GameClient } from '../net/client.js';

export function PodiumScreen({
  view,
  client,
  onLeave,
  onError,
}: {
  view: RoomView;
  client: GameClient;
  onLeave: () => void;
  onError: (message: string) => void;
}) {
  const winner = view.players.find((p) => p.id === view.winnerId);
  const winningTeam = view.teams.find((t) => t.id === view.winningTeamId);
  const abandoned = view.endReason === 'abandoned';

  return (
    <Screen accent="amber">
      <Card className="text-center">
        {abandoned ? (
          <p className="text-xl font-bold text-muted">{ar.endedEarly}</p>
        ) : winningTeam ? (
          <>
            <p className="text-6xl">{winningTeam.emoji}</p>
            <p className="mt-2 text-sm text-muted">{ar.winningTeam}</p>
            <p className="text-balance text-4xl font-black" style={{ color: 'var(--accent)' }}>
              {winningTeam.nameAr}
            </p>
          </>
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

      <div className="mt-auto flex flex-col gap-2 pt-4">
        {view.you.isHost ? (
          <Button
            variant="accent"
            onClick={async () => {
              const result = await client.rematch();
              if (!result.ok) onError(result.error);
            }}
          >
            {ar.rematch}
          </Button>
        ) : (
          <p className="text-center text-muted">{ar.waitingForHost}</p>
        )}
        <Button variant="ghost" onClick={onLeave}>
          {ar.backHome}
        </Button>
      </div>
    </Screen>
  );
}
