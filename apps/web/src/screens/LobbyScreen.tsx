import { useState } from 'react';
import { MAX_PLAYERS, type MatchFormat, type RoomView } from '@game/shared';
import { ar } from '../i18n/ar.js';
import { Button, Card, Screen } from '../ui/primitives.js';
import { playerTint } from '../ui/playerColors.js';
import type { GameClient } from '../net/client.js';

/**
 * The three settings, labelled by how long the match feels rather than by an exact count.
 *
 * `roundCount` is a budget of round slots, and a long type such as قطع الأرض spends two of
 * them — that is deliberate, because a sixty-second round really is two rounds worth of a
 * match. But it means picking "10" produced eight rounds, and the header then said "جولة 1 من
 * 8" to a host who had just asked for ten. Naming the control after what it controls, and
 * marking the number approximate, removes a promise the engine was never going to keep.
 */
const MATCH_LENGTHS = [
  { roundCount: 5 as const, label: ar.matchLengthShort },
  { roundCount: 10 as const, label: ar.matchLengthMedium },
  { roundCount: 15 as const, label: ar.matchLengthLong },
  { roundCount: 20 as const, label: ar.matchLengthEpic },
];

const FORMATS: Array<{ id: MatchFormat; label: string; hint: string }> = [
  { id: 'mixed', label: ar.formatMixed, hint: ar.formatMixedHint },
  { id: 'focused', label: ar.formatFocused, hint: ar.formatFocusedHint },
  { id: 'tournament', label: ar.formatTournament, hint: ar.formatTournamentHint },
];

export function LobbyScreen({
  view,
  client,
  onError,
  onLeave,
}: {
  view: RoomView;
  client: GameClient;
  onError: (message: string) => void;
  onLeave: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const isHost = view.you.isHost;
  const canStart = view.players.length >= 2;

  const copyLink = async () => {
    const link = `${window.location.origin}/?code=${view.code}`;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // Clipboard is blocked outside a secure context — which includes plain-http LAN testing,
      // exactly where this feature matters most. Show the code instead of failing silently.
      onError(`انسخ الكود يدوي: ${view.code}`);
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const patch = async (change: Record<string, unknown>) => {
    const result = await client.configure(change);
    if (!result.ok) onError(result.error);
  };

  return (
    <Screen className="pb-0">
      <div className="flex items-center justify-between">
        {/* Without this there is no way out of a room short of closing the tab. */}
        <button
          onClick={onLeave}
          className="-ms-2 grid size-11 place-items-center rounded-xl text-2xl text-muted active:bg-surface-2"
          aria-label={ar.backHome}
        >
          ←
        </button>
        <span className="text-sm text-muted">{ar.lobby}</span>
        <span className="size-11" />
      </div>

      <Card className="text-center">
        <p className="text-sm text-muted">{ar.roomCode}</p>
        <p
          className="tabular my-2 text-5xl font-black tracking-[0.3em]"
          style={{ color: 'var(--accent)' }}
        >
          {view.code}
        </p>
        <Button variant="ghost" onClick={copyLink}>
          {copied ? ar.linkCopied : ar.copyLink}
        </Button>
      </Card>

      <section>
        <h2 className="mb-2 font-bold">
          {ar.players} <span className="tabular text-muted">
            ({view.players.length}/{MAX_PLAYERS})
          </span>
        </h2>
        <div className="flex flex-col gap-2">
          {view.players.map((player) => (
            <div
              key={player.id}
              className="flex items-center gap-3 rounded-2xl border border-line bg-surface py-2 pe-2 ps-4"
            >
              {/* The seat colour a player will wear on every screen for the whole match. */}
              <span
                className="grid size-10 shrink-0 place-items-center rounded-full text-lg font-black"
                style={{ background: playerTint(view.players, player.id), color: 'var(--color-ink)' }}
              >
                {player.nickname.slice(0, 1)}
              </span>
              <span className="flex-1 truncate font-bold">{player.nickname}</span>
              {player.teamId ? (
                <span className="shrink-0 text-lg">
                  {view.teams.find((t) => t.id === player.teamId)?.emoji}
                </span>
              ) : null}
              {player.isHost ? (
                <span className="shrink-0 rounded-full bg-surface-2 px-2 py-1 text-xs text-muted">
                  {ar.host}
                </span>
              ) : null}
              {!player.connected ? (
                <span className="shrink-0 text-xs text-accent-rose">{ar.away}</span>
              ) : null}
              {isHost && !player.isHost ? (
                // A full-size target: a 16px text link beside a name is both hard to hit on
                // purpose and easy to hit by accident.
                <button
                  onClick={() => void client.kick(player.id)}
                  aria-label={`${ar.kick} ${player.nickname}`}
                  className="grid size-11 shrink-0 place-items-center rounded-xl text-lg text-muted active:bg-surface-2"
                >
                  ✕
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      {isHost ? (
        <Card className="flex flex-col gap-5">
          <h2 className="font-bold">{ar.settings}</h2>

          <Field label={ar.format}>
            <div className="grid grid-cols-3 gap-2">
              {FORMATS.map((format) => (
                <Choice
                  key={format.id}
                  active={view.config.format === format.id}
                  onClick={() => void patch({ format: format.id })}
                >
                  <span className="block font-bold">{format.label}</span>
                  <span className="mt-0.5 block text-xs leading-tight opacity-70">
                    {format.hint}
                  </span>
                </Choice>
              ))}
            </div>
          </Field>

          {view.config.format === 'focused' ? (
            <Field label="اللعبة">
              <div className="grid grid-cols-2 gap-2">
                {view.availableRoundTypes.map((type) => (
                  <Choice
                    key={type.id}
                    active={view.config.roundTypeId === type.id}
                    onClick={() => void patch({ roundTypeId: type.id })}
                  >
                    {type.nameAr}
                  </Choice>
                ))}
              </div>
            </Field>
          ) : null}

          <Field label={ar.teams}>
            <button
              onClick={() => void patch({ teams: !view.config.teams })}
              className={`flex min-h-14 w-full items-center gap-3 rounded-xl border px-4 text-start transition ${
                view.config.teams ? 'border-[var(--accent)] bg-surface-2' : 'border-line text-muted'
              }`}
            >
              <span className="text-xl">{view.config.teams ? '✅' : '⬜'}</span>
              <span className="flex-1">
                <span className="block font-bold">{ar.teamsOn}</span>
                <span className="block text-xs opacity-70">{ar.teamsHint}</span>
              </span>
            </button>
          </Field>

          <Field label={ar.matchLength}>
            <div className="grid grid-cols-3 gap-2">
              {MATCH_LENGTHS.map((length) => (
                <Choice
                  key={length.roundCount}
                  active={view.config.roundCount === length.roundCount}
                  onClick={() => void patch({ roundCount: length.roundCount })}
                >
                  <span className="block font-bold">{length.label}</span>
                  <span className="tabular mt-0.5 block text-xs opacity-70">
                    ~{length.roundCount} {ar.round}
                  </span>
                </Choice>
              ))}
            </div>
            <p className="text-xs text-muted">{ar.matchLengthHint}</p>
          </Field>

          <Field label={ar.categories}>
            <div className="flex flex-wrap gap-2">
              {view.availableCategories.map((category) => {
                const active = view.config.categoryIds.includes(category.id);
                return (
                  <button
                    key={category.id}
                    onClick={() => {
                      const next = active
                        ? view.config.categoryIds.filter((id) => id !== category.id)
                        : [...view.config.categoryIds, category.id];
                      if (next.length === 0) return onError('لازم مجال واحد على الأقل');
                      void patch({ categoryIds: next });
                    }}
                    className={`min-h-11 rounded-full border px-4 text-sm font-bold transition ${
                      active ? 'border-[var(--accent)] bg-surface-2' : 'border-line text-muted'
                    }`}
                  >
                    {category.emoji} {category.nameAr}
                  </button>
                );
              })}
            </div>
          </Field>
        </Card>
      ) : null}

      {/*
        Pinned to the viewport, not the end of the page. The settings panel is taller than a
        phone screen, so a start button in normal flow sits below the fold — the host has to
        scroll past every option to reach the one control that matters.
      */}
      <div className="sticky bottom-0 -mx-4 mt-auto bg-ink/90 px-4 pb-6 pt-3 backdrop-blur">
        {isHost ? (
          <Button
            variant="accent"
            disabled={!canStart}
            onClick={async () => {
              const result = await client.start();
              if (!result.ok) onError(result.error);
            }}
          >
            {canStart ? ar.startMatch : ar.needMorePlayers}
          </Button>
        ) : (
          <p className="py-3 text-center text-muted">{ar.waitingForHost}</p>
        )}
      </div>
    </Screen>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm text-muted">{label}</span>
      {children}
    </div>
  );
}

function Choice({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`min-h-14 rounded-xl border px-2 py-2 text-center text-sm transition ${
        active ? 'border-[var(--accent)] bg-surface-2 text-body' : 'border-line text-muted'
      }`}
    >
      {children}
    </button>
  );
}
