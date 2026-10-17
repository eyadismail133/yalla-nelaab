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
  const {
    client,
    view,
    connected,
    hostUnresponsive,
    error,
    connectionError,
    closedReason,
    setError,
    reset,
    retry,
  } = useGame();

  const [initialCode] = useState(
    () => new URLSearchParams(window.location.search).get('code')?.toUpperCase() ?? '',
  );

  const [disconnectedSeconds, setDisconnectedSeconds] = useState(0);

  const isFirebaseMode =
    (import.meta.env?.VITE_GAME_TRANSPORT ?? '').toLowerCase() === 'firebase';

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 3200);
    return () => clearTimeout(timer);
  }, [error, setError]);

  useEffect(() => {
    if (connected) {
      setDisconnectedSeconds(0);
      return;
    }
    const timer = setInterval(() => {
      setDisconnectedSeconds((s) => s + 1);
    }, 1_000);
    return () => clearInterval(timer);
  }, [connected]);

  return (
    <>
      {/* Host unresponsive banner (15s without heartbeat or host execution lease loss) */}
      {hostUnresponsive && !closedReason && view ? (
        <aside
          role="status"
          aria-live="polite"
          className="sticky top-0 z-50 flex flex-wrap items-center justify-center gap-3 bg-accent-amber px-4 py-2 text-center text-sm font-bold text-ink shadow-md"
        >
          <span>
            {view.you?.isHost
              ? 'انقطع تشغيل الغرفة — جرب إعادة الاتصال'
              : 'الهوست غير متصل مؤقتاً — في انتظار عودته...'}
          </span>
          <Button
            type="button"
            variant="ghost"
            onClick={() => void retry()}
            className="w-auto min-h-8 py-1 px-3 text-xs"
          >
            إعادة المحاولة
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={reset}
            className="w-auto min-h-8 py-1 px-3 text-xs"
          >
            {ar.backHome}
          </Button>
        </aside>
      ) : null}

      {/* Persistent connection / initialization error banner with immediate retry */}
      {connectionError && !hostUnresponsive ? (
        <aside
          role="alert"
          aria-live="assertive"
          className="sticky top-0 z-40 flex flex-wrap items-center justify-center gap-3 bg-accent-rose px-4 py-2 text-center text-sm font-bold text-ink shadow-md"
        >
          <span>{connectionError}</span>
          <Button
            type="button"
            variant="ghost"
            onClick={() => void retry()}
            className="w-auto min-h-8 py-1 px-3 text-xs"
          >
            إعادة المحاولة
          </Button>
          {view ? (
            <Button
              type="button"
              variant="ghost"
              onClick={reset}
              className="w-auto min-h-8 py-1 px-3 text-xs"
            >
              {ar.backHome}
            </Button>
          ) : null}
        </aside>
      ) : null}

      {/* Disconnected / Reconnecting banner */}
      {!connected && !connectionError && !hostUnresponsive ? (
        <aside
          role="status"
          aria-live="polite"
          className="sticky top-0 z-40 flex flex-wrap items-center justify-center gap-3 bg-accent-rose px-4 py-2 text-center text-sm font-bold text-ink shadow-md"
        >
          <span>{ar.reconnecting}</span>
          {disconnectedSeconds >= 90 ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => void retry()}
              className="w-auto min-h-8 py-1 px-3 text-xs"
            >
              إعادة الاتصال
            </Button>
          ) : null}
        </aside>
      ) : null}

      {/* Main match screens */}
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
        <div className="flex min-h-dvh flex-col">
          {/* Firebase mode notices (host tab requirement and guest beta note) in normal layout flow */}
          {isFirebaseMode && view.phase === 'lobby' ? (
            <aside
              role="status"
              aria-live="polite"
              aria-label="معلومات النسخة التجريبية"
              className="mx-auto w-full max-w-md px-4 pt-3 text-center text-xs font-semibold text-muted"
            >
              <div className="rounded-xl border border-line bg-surface-2 p-2.5 shadow-sm">
                {view.you.isHost
                  ? '⚠️ تنبيه الهوست: خلّي التاب مفتوح والشاشة شغالة لأن متصفحك هو اللي بيدير الماتش.'
                  : 'نسخة تجريبية: اللعب عبر دعوات الأصدقاء فقط (حد أقصى 8 لاعبين).'}
              </div>
            </aside>
          ) : null}

          <fieldset disabled={hostUnresponsive} className="contents">
            <MatchRouter view={view} client={client} onError={setError} onLeave={reset} />
          </fieldset>
        </div>
      )}

      {/* Transient error toast with aria-live */}
      {error ? (
        <div
          aria-live="assertive"
          className="pop-in fixed inset-x-4 bottom-4 z-50 mx-auto max-w-md rounded-2xl bg-surface-2 px-4 py-3 text-center font-bold shadow-lg"
        >
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
