import { useState } from 'react';
import { ar } from '../i18n/ar.js';
import { Button, Card, Screen, TextField } from '../ui/primitives.js';
import type { GameClient } from '../net/client.js';
import { saveSession } from '../net/client.js';

export function HomeScreen({
  client,
  connected,
  onError,
  initialCode,
}: {
  client: GameClient;
  connected: boolean;
  onError: (message: string) => void;
  initialCode: string;
}) {
  const [nickname, setNickname] = useState('');
  const [code, setCode] = useState(initialCode);
  const [mode, setMode] = useState<'menu' | 'join'>(initialCode ? 'join' : 'menu');
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<{ ok: boolean } & Record<string, unknown>>) => {
    if (!nickname.trim()) return onError('اكتب اسمك الأول');
    setBusy(true);
    const result = await fn();
    setBusy(false);
    if (!result.ok) return onError(String(result.error ?? 'حصلت مشكلة'));
    saveSession({
      code: String(result.code),
      playerId: String(result.playerId),
      token: String(result.token),
    });
  };

  return (
    <Screen className="justify-center">
      <header className="mb-2 text-center">
        <h1 className="text-5xl font-black tracking-tight" style={{ color: 'var(--accent)' }}>
          {ar.appName}
        </h1>
        <p className="mt-2 text-muted">{ar.tagline}</p>
      </header>

      <Card className="flex flex-col gap-4">
        <label className="flex flex-col gap-2">
          <span className="font-bold">{ar.nickname}</span>
          <TextField
            value={nickname}
            maxLength={16}
            onChange={(e) => setNickname(e.target.value)}
            placeholder={ar.nicknamePlaceholder}
          />
        </label>

        {mode === 'join' ? (
          <>
            <label className="flex flex-col gap-2">
              <span className="font-bold">{ar.roomCode}</span>
              <TextField
                value={code}
                maxLength={5}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder={ar.roomCodePlaceholder}
                className="tabular text-center text-2xl font-black tracking-[0.4em]"
              />
            </label>
            <Button
              variant="accent"
              disabled={busy || !connected || code.trim().length !== 5}
              onClick={() => run(() => client.joinRoom(code.trim(), nickname))}
            >
              {ar.join}
            </Button>
            <Button variant="ghost" onClick={() => setMode('menu')}>
              رجوع
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="accent"
              disabled={busy || !connected}
              onClick={() => run(() => client.createRoom(nickname))}
            >
              {ar.createRoom}
            </Button>
            <Button variant="ghost" onClick={() => setMode('join')}>
              {ar.joinRoom}
            </Button>
          </>
        )}
      </Card>

      {!connected ? <p className="text-center text-sm text-muted">{ar.connecting}</p> : null}
    </Screen>
  );
}
