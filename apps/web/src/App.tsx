import { useEffect, useState } from 'react';
import { ar } from './i18n/ar.js';
import { useGame } from './net/useGame.js';
import { Button, Screen } from './ui/primitives.js';
import { HomeScreen } from './screens/HomeScreen.js';
import { LobbyScreen } from './screens/LobbyScreen.js';
import { RoundIntroScreen } from './screens/RoundIntroScreen.js';
import { RoundScreen } from './screens/RoundScreen.js';
import { ResultScreen } from './screens/ResultScreen.js';
import { PodiumScreen } from './screens/PodiumScreen.js';

export function App() {
  const { client, view, connected, error, closedReason, setError, reset } = useGame();
  const [initialCode] = useState(
    () => new URLSearchParams(window.location.search).get('code')?.toUpperCase() ?? '',
  );

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 3200);
    return () => clearTimeout(timer);
  }, [error, setError]);

  return (
    <>
      {closedReason ? (
        <Screen className="justify-center text-center">
          <p className="text-2xl font-bold">{closedReason}</p>
          <Button variant="ghost" onClick={reset}>
            {ar.backHome}
          </Button>
        </Screen>
      ) : !view ? (
        <HomeScreen
          client={client}
          connected={connected}
          onError={setError}
          initialCode={initialCode}
        />
      ) : (
        <MatchRouter view={view} client={client} onError={setError} onLeave={reset} />
      )}

      {!connected && view ? (
        <div className="fixed inset-x-0 top-0 bg-accent-rose py-2 text-center text-sm font-bold text-ink">
          {ar.reconnecting}
        </div>
      ) : null}

      {error ? (
        <div className="pop-in fixed inset-x-4 bottom-4 mx-auto max-w-md rounded-2xl bg-surface-2 px-4 py-3 text-center font-bold shadow-lg">
          {error}
        </div>
      ) : null}
    </>
  );
}

function MatchRouter({
  view,
  client,
  onError,
  onLeave,
}: {
  view: ReturnType<typeof useGame>['view'] & object;
  client: ReturnType<typeof useGame>['client'];
  onError: (message: string) => void;
  onLeave: () => void;
}) {
  switch (view.phase) {
    case 'lobby':
      return <LobbyScreen view={view} client={client} onError={onError} onLeave={onLeave} />;
    case 'round_intro':
    case 'sudden_death_intro':
      return <RoundIntroScreen view={view} />;
    case 'in_round':
    case 'sudden_death':
      return <RoundScreen view={view} client={client} />;
    case 'round_result':
      return <ResultScreen view={view} client={client} onError={onError} />;
    case 'podium':
      return <PodiumScreen view={view} client={client} onLeave={onLeave} onError={onError} />;
    default:
      return null;
  }
}
