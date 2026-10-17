import { useRef, useState } from 'react';
import { GameDiscovery } from '../experience/index.js';
import { ar } from '../i18n/ar.js';
import { saveSession } from '../net/client.js';
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
    <Screen>
      <header className="mt-2 text-center">
        <h1 className="text-5xl font-black tracking-tight" style={{ color: 'var(--accent)' }}>
          {ar.appName}
        </h1>
        <p className="mt-2 text-muted">{ar.tagline}</p>
      </header>

      <Card className="flex flex-col gap-4">
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
          <>
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
          </>
        ) : (
          <>
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
          </>
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

      {/* Compact collapsed discovery & 18-game catalog below prominent create/join card */}
      <GameDiscovery defaultHowToPlayOpen={false} defaultCatalogOpen={false} />
    </Screen>
  );
}
