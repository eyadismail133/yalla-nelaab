import { useEffect, useRef, useState } from 'react';
import { GameDiscovery } from '../experience/GameDiscovery.js';
import { HomeFooter, HomeGameModes, HomeHeader, HomeHero, HomeStats } from '../experience/HomePresentation.js';
import { ar } from '../i18n/ar.js';
import { saveSession } from '../net/session.js';
import { listRecoveries, restoreRecovery } from '../net/recovery.js';
import type { GameTransport } from '../net/transport.js';
import { isValidRoomCode, normalizeRoomCodeInput } from '../ui/InvitationPanel.js';
import { Button, Card, Screen, TextField } from '../ui/primitives.js';

export function HomeScreen({
  client,
  connected,
  onError,
  initialCode,
}: {
  client: GameTransport;
  connected: boolean;
  onError: (message: string) => void;
  initialCode: string;
}) {
  const [nickname, setNickname] = useState('');
  const [code, setCode] = useState(() => normalizeRoomCodeInput(initialCode));
  const [mode, setMode] = useState<'menu' | 'join'>(initialCode ? 'join' : 'menu');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const [recoveries, setRecoveries] = useState(() => listRecoveries());
  useEffect(() => {
    const timer = setInterval(() => setRecoveries(listRecoveries()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const reportError = (msg: string) => {
    setLocalError(msg);
    onError(msg);
  };

  const run = async (
    fn: () => Promise<{ ok: boolean } & Record<string, unknown>>,
  ) => {
    if (inFlightRef.current || busy) return;
    const trimmedName = nickname.trim();
    if (!trimmedName) {
      reportError('اكتب اسمك الأول');
      return;
    }

    inFlightRef.current = true;
    setBusy(true);
    setLocalError(null);

    try {
      const result = await fn();
      if (!result.ok) {
        reportError(String(result.error ?? 'حصلت مشكلة'));
        return;
      }
      saveSession({
        nickname: trimmedName,
        code: String(result.code),
        playerId: String(result.playerId),
        token: String(result.token),
      });
    } catch (err) {
      const message =
        err instanceof Error && err.message ? err.message : 'حصلت مشكلة في الاتصال — جرب تاني';
      reportError(message);
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  };

  const normalizedCode = normalizeRoomCodeInput(code);
  const codeValid = isValidRoomCode(normalizedCode);

  return (
    <Screen brand={false} className={`home-screen ${mode === 'join' ? 'home-screen--join' : ''}`}>
      <HomeHeader />
      <HomeHero>
        <section id="start-playing" className="home-start" aria-label="ابدأ اللعب">

          {recoveries.length > 0 ? <Card className="flex flex-col gap-3">
            <p className="text-sm text-muted">ماتش لعبته قريب؟ اقفل التاب القديم لو لسه مفتوح وارجع لمقعدك.</p>
            {recoveries.map((recovery) => <Button key={recovery.seatId} variant="ghost" disabled={busy}
              onClick={async () => {
                if (inFlightRef.current) return;
                inFlightRef.current = true;
                setBusy(true);
                try { await restoreRecovery(recovery.seatId); window.location.reload(); }
                catch (error) { reportError(error instanceof Error ? error.message : 'تعذر استرجاع المقعد'); }
                finally { inFlightRef.current = false; setBusy(false); }
              }}>
              العودة للماتش الشغال (غرفة {recovery.session.code})
              {recovery.session.nickname ? ` — ${recovery.session.nickname}` : ''}
            </Button>)}
          </Card> : null}

          <Card className="home-entry flex flex-col gap-4">
            <div className="entry-heading">
              <span className="entry-icon" aria-hidden="true">{mode === 'join' ? '↗' : '01'}</span>
              <div>
                <h2>{mode === 'join' ? 'صحابك مستنيينك' : 'ابدأوا الليلة'}</h2>
                <p>{mode === 'join' ? 'اكتب اسمك والكود، وادخل على طول.' : 'افتح غرفة، ابعت الكود، وابدأوا التحدي.'}</p>
              </div>
            </div>
            <label className="flex flex-col gap-2">
              <span className="font-bold">{ar.nickname}</span>
              <TextField
                lang="ar"
                dir="rtl"
                inputMode="text"
                enterKeyHint={mode === 'join' ? 'next' : 'go'}
                value={nickname}
                maxLength={16}
                disabled={busy}
                onChange={(e) => {
                  setNickname(e.target.value);
                  if (localError) setLocalError(null);
                }}
                placeholder={ar.nicknamePlaceholder}
              />
            </label>

            {mode === 'join' ? (
              <div className="entry-actions entry-actions--join">
                <label className="flex flex-col gap-2">
                  <span className="font-bold">{ar.roomCode}</span>
                  <TextField
                    dir="ltr"
                    lang="en"
                    inputMode="text"
                    enterKeyHint="go"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    autoComplete="off"
                    spellCheck={false}
                    value={code}
                    maxLength={5}
                    disabled={busy}
                    onChange={(e) => {
                      setCode(normalizeRoomCodeInput(e.target.value));
                      if (localError) setLocalError(null);
                    }}
                    placeholder={ar.roomCodePlaceholder}
                    className="tabular text-center text-2xl font-black uppercase tracking-[0.35em]"
                  />
                </label>
                <Button
                  type="button"
                  variant="accent"
                  disabled={busy || !connected || !codeValid}
                  onClick={() => {
                    if (!codeValid) {
                      reportError('كود الغرفة لازم يكون ٥ حروف أو أرقام بالإنجليزي');
                      return;
                    }
                    void run(() => client.joinRoom(normalizedCode, nickname.trim()));
                  }}
                >
                  {busy ? ar.sendingAction : ar.join}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setLocalError(null);
                    setMode('menu');
                  }}
                >
                  رجوع
                </Button>
              </div>
            ) : (
              <div className="entry-actions">
                <Button
                  type="button"
                  variant="accent"
                  disabled={busy || !connected}
                  onClick={() => void run(() => client.createRoom(nickname.trim()))}
                >
                  {busy ? ar.sendingAction : ar.createRoom}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setLocalError(null);
                    setMode('join');
                  }}
                >
                  {ar.joinRoom}
                </Button>
              </div>
            )}

            {localError ? (
              <p
                role="alert"
                aria-live="assertive"
                className="text-center text-sm font-bold text-accent-rose"
              >
                {localError}
              </p>
            ) : null}
          </Card>

          {!connected ? (
            <p role="status" aria-live="polite" className="text-center text-sm text-muted">
              {ar.connecting}
            </p>
          ) : null}

          <p className="entry-footnote"><span aria-hidden="true">✓</span> من غير حساب <span aria-hidden="true">·</span> من غير تحميل <span aria-hidden="true">·</span> من موبايلك</p>
        </section>
      </HomeHero>
      <HomeStats />
      <HomeGameModes />
      <section id="game-guide" className="home-guide" aria-labelledby="guide-heading">
        <div className="guide-heading">
          <div><p className="section-eyebrow">الدليل الكامل</p><h2 id="guide-heading">كل اللي يناسب قعدتكم.</h2></div>
          <p>اعرفوا القوانين، اختاروا المواضيع، وسيبوا الباقي للمنافسة.</p>
        </div>
        <GameDiscovery defaultHowToPlayOpen={false} defaultCatalogOpen={false} />
      </section>
      <HomeFooter />
    </Screen>
  );
}
