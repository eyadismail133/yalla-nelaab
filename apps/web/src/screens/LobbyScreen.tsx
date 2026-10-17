import { useRef, useState } from 'react';
import { MAX_PLAYERS, MIN_PLAYERS, type MatchConfig, type MatchFormat, type RoomView } from '@game/shared';
import { ROUND_TYPES, getRoundType } from '@game/rounds';
import {
  GameDiscovery,
  MatchPresets,
  evaluateGameEligibility,
  type GameEligibility,
} from '../experience/index.js';
import { ar } from '../i18n/ar.js';
import type { GameTransport } from '../net/transport.js';
import { InvitationPanel } from '../ui/InvitationPanel.js';
import { playerTint } from '../ui/playerColors.js';
import { Button, Card, Pill, Screen } from '../ui/primitives.js';

/**
 * The four settings, labelled by how long the match feels rather than by an exact count.
 *
 * `roundCount` is a budget of round slots, and a long type such as قطع الأرض spends two of
 * them — that is deliberate, because a sixty-second round really is two rounds worth of a
 * match.
 */
export const MATCH_LENGTHS = [
  { roundCount: 5 as const, label: ar.matchLengthShort },
  { roundCount: 10 as const, label: ar.matchLengthMedium },
  { roundCount: 15 as const, label: ar.matchLengthLong },
  { roundCount: 20 as const, label: ar.matchLengthEpic },
] as const;

export const FORMATS: ReadonlyArray<{ id: MatchFormat; label: string; hint: string }> = [
  { id: 'mixed', label: ar.formatMixed, hint: ar.formatMixedHint },
  { id: 'focused', label: ar.formatFocused, hint: ar.formatFocusedHint },
  { id: 'tournament', label: ar.formatTournament, hint: ar.formatTournamentHint },
];

export function countConnectedPlayers(players: RoomView['players']): number {
  return players.filter((p) => p.connected && !p.leftEarly).length;
}

export function countReadyConnectedPlayers(players: RoomView['players']): number {
  return players.filter((p) => p.connected && !p.leftEarly && Boolean(p.ready)).length;
}

export interface FocusedRoundChoice {
  id: string;
  nameAr: string;
  taglineAr: string;
  accent: string;
  eligibility: GameEligibility;
}

export function evaluateFocusedRoundChoices(
  availableRoundTypes: RoomView['availableRoundTypes'],
  connectedPlayerCount: number,
  teams: boolean,
): FocusedRoundChoice[] {
  const canonicalById = new Map(ROUND_TYPES.map((t) => [t.id, t]));
  return availableRoundTypes.map((type) => {
    const canonical = canonicalById.get(type.id) ?? getRoundType(type.id);
    return {
      id: type.id,
      nameAr: type.nameAr,
      taglineAr: type.taglineAr,
      accent: type.accent,
      eligibility: evaluateGameEligibility(canonical, {
        playerCount: connectedPlayerCount,
        teams,
      }),
    };
  });
}

export interface LobbyConfigSummary {
  formatLabelAr: string;
  formatDetailAr: string;
  lengthLabelAr: string;
  teamsLabelAr: string;
  categoriesSummaryAr: string;
  selectedCategories: Array<{ id: string; nameAr: string; emoji: string }>;
}

export function summarizeLobbyConfig(
  view: Pick<RoomView, 'config' | 'availableCategories' | 'availableRoundTypes'>,
): LobbyConfigSummary {
  const formatMeta = FORMATS.find((f) => f.id === view.config.format) ?? FORMATS[0]!;
  const focusedType =
    view.config.format === 'focused' && view.config.roundTypeId
      ? view.availableRoundTypes.find((t) => t.id === view.config.roundTypeId)
      : undefined;

  const formatLabelAr =
    view.config.format === 'focused' && focusedType
      ? `${formatMeta.label}: ${focusedType.nameAr}`
      : formatMeta.label;

  const lengthMeta =
    MATCH_LENGTHS.find((l) => l.roundCount === view.config.roundCount) ?? MATCH_LENGTHS[1]!;
  const lengthLabelAr = `${lengthMeta.label} (~${view.config.roundCount} ${ar.round})`;

  const teamsLabelAr = view.config.teams ? 'فرق (فريقين ضد بعض)' : 'فردي (كل لاعب لنفسه)';

  const selectedSet = new Set(view.config.categoryIds);
  const selectedCategories = view.availableCategories.filter((c) => selectedSet.has(c.id));
  const allSelected =
    view.availableCategories.length > 0 &&
    selectedCategories.length === view.availableCategories.length;

  const categoriesSummaryAr = allSelected
    ? `كل المجالات (${selectedCategories.length})`
    : `${selectedCategories.length} من ${view.availableCategories.length} مجال`;

  return {
    formatLabelAr,
    formatDetailAr: focusedType ? focusedType.taglineAr : formatMeta.hint,
    lengthLabelAr,
    teamsLabelAr,
    categoriesSummaryAr,
    selectedCategories,
  };
}

export function LobbyScreen({
  view,
  client,
  onError,
  onLeave,
}: {
  view: RoomView;
  client: GameTransport;
  onError: (message: string) => void;
  onLeave: () => void;
}) {
  const [configBusy, setConfigBusy] = useState(false);
  const [readyBusy, setReadyBusy] = useState(false);
  const [kickBusyId, setKickBusyId] = useState<string | null>(null);
  const [startBusy, setStartBusy] = useState(false);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const configLockRef = useRef(false);
  const readyLockRef = useRef(false);
  const startLockRef = useRef(false);

  const isHost = view.you.isHost;
  const me = view.players.find((p) => p.id === view.you.id);
  const myReady = Boolean(me?.ready);

  const connectedCount = countConnectedPlayers(view.players);
  const readyConnectedCount = countReadyConnectedPlayers(view.players);
  const focusedChoices = evaluateFocusedRoundChoices(
    view.availableRoundTypes,
    connectedCount,
    view.config.teams,
  );

  const selectedFocusedChoice =
    view.config.format === 'focused'
      ? focusedChoices.find((c) => c.id === view.config.roundTypeId)
      : undefined;

  const focusedReady =
    view.config.format !== 'focused' || Boolean(selectedFocusedChoice?.eligibility.eligible);
  const canStart = connectedCount >= MIN_PLAYERS && focusedReady;

  const configSummary = summarizeLobbyConfig(view);

  const reportError = (msg: string) => {
    setLocalError(msg);
    onError(msg);
  };

  const patch = async (change: Partial<MatchConfig> & Record<string, unknown>) => {
    if (configLockRef.current || configBusy) return;
    configLockRef.current = true;
    setConfigBusy(true);
    setLocalError(null);
    try {
      const result = await client.configure(change);
      if (!result.ok) {
        reportError(result.error);
      }
    } catch (err) {
      reportError(err instanceof Error && err.message ? err.message : ar.actionFailed);
    } finally {
      configLockRef.current = false;
      setConfigBusy(false);
    }
  };

  const handleToggleReady = async () => {
    if (readyLockRef.current || readyBusy) return;
    readyLockRef.current = true;
    setReadyBusy(true);
    setLocalError(null);
    try {
      const result = await client.setReady(!myReady);
      if (!result.ok) {
        reportError(result.error);
      }
    } catch (err) {
      reportError(err instanceof Error && err.message ? err.message : ar.actionFailed);
    } finally {
      readyLockRef.current = false;
      setReadyBusy(false);
    }
  };

  const handleKick = async (playerId: string) => {
    if (kickBusyId !== null || startBusy) return;
    setKickBusyId(playerId);
    setLocalError(null);
    try {
      const result = await client.kick(playerId);
      if (!result.ok) {
        reportError(result.error);
      }
    } catch (err) {
      reportError(err instanceof Error && err.message ? err.message : ar.actionFailed);
    } finally {
      setKickBusyId(null);
    }
  };

  const handleStart = async () => {
    if (startLockRef.current || startBusy || !canStart) return;
    startLockRef.current = true;
    setStartBusy(true);
    setLocalError(null);
    try {
      const result = await client.start();
      if (!result.ok) {
        reportError(result.error);
      }
    } catch (err) {
      reportError(err instanceof Error && err.message ? err.message : ar.actionFailed);
    } finally {
      startLockRef.current = false;
      setStartBusy(false);
    }
  };

  const handleLeave = () => {
    if (leaveBusy) return;
    setLeaveBusy(true);
    onLeave();
  };

  return (
    <Screen className="pb-0">
      <div className="flex items-center justify-between">
        {/* Without this there is no way out of a room short of closing the tab. */}
        <button
          type="button"
          disabled={leaveBusy}
          onClick={handleLeave}
          className="-ms-2 grid size-11 place-items-center rounded-xl text-2xl text-muted active:bg-surface-2 disabled:opacity-40"
          aria-label={ar.backHome}
        >
          ←
        </button>
        <span className="text-sm font-bold text-muted">{ar.lobby}</span>
        <span className="size-11" />
      </div>

      {/* Invitation panel with selectable URL, room code, clipboard, native share, WhatsApp, and local QR */}
      <InvitationPanel code={view.code} onError={onError} />

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-bold">
            {ar.players}{' '}
            <span className="tabular text-muted">
              ({connectedCount}/{MAX_PLAYERS})
            </span>
          </h2>
          <span className="tabular text-xs font-bold text-muted">
            جاهزين: {readyConnectedCount} / {connectedCount}
          </span>
        </div>

        <div className="flex flex-col gap-2">
          {view.players.map((player) => {
            const isPlayerReady = Boolean(player.ready);
            return (
              <div
                key={player.id}
                className="flex items-center gap-2.5 rounded-2xl border border-line bg-surface py-2 pe-2 ps-3.5"
              >
                {/* The seat colour a player will wear on every screen for the whole match. */}
                <span
                  className="grid size-10 shrink-0 place-items-center rounded-full text-lg font-black"
                  style={{
                    background: playerTint(view.players, player.id),
                    color: 'var(--color-ink)',
                  }}
                >
                  {player.nickname.slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1 truncate font-bold">{player.nickname}</span>
                {player.teamId ? (
                  <span className="shrink-0 text-lg">
                    {view.teams.find((t) => t.id === player.teamId)?.emoji}
                  </span>
                ) : null}
                {player.isHost ? (
                  <span className="shrink-0 rounded-full bg-surface-2 px-2 py-1 text-xs font-bold text-muted">
                    {ar.host}
                  </span>
                ) : null}
                {!player.connected ? (
                  <span className="shrink-0 rounded-full bg-surface-2 px-2.5 py-1 text-xs font-bold text-accent-rose">
                    {ar.away}
                  </span>
                ) : (
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${
                      isPlayerReady
                        ? 'bg-surface-2 text-accent-emerald'
                        : 'bg-surface-2 text-muted'
                    }`}
                  >
                    {isPlayerReady ? ar.ready : ar.notReady}
                  </span>
                )}
                {isHost && !player.isHost ? (
                  <button
                    type="button"
                    disabled={kickBusyId === player.id || startBusy}
                    onClick={() => void handleKick(player.id)}
                    aria-label={`${ar.kick} ${player.nickname}`}
                    className="grid size-11 shrink-0 place-items-center rounded-xl text-lg text-muted active:bg-surface-2 disabled:opacity-40"
                  >
                    ✕
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>

        {/* Own readiness toggle for both host and guests */}
        <div className="flex flex-col gap-1.5">
          <Button
            type="button"
            variant={myReady ? 'ghost' : 'accent'}
            disabled={readyBusy}
            aria-pressed={myReady}
            onClick={() => void handleToggleReady()}
          >
            {readyBusy ? ar.sendingAction : myReady ? ar.markUnready : ar.markReady}
          </Button>
          <p className="text-center text-xs text-muted">{ar.readyStatusHint}</p>
        </div>
      </section>

      {isHost ? (
        <>
          <MatchPresets
            availableCategoryIds={view.availableCategories.map((c) => c.id)}
            currentConfig={view.config}
            playerCount={connectedCount}
            disabled={configBusy || startBusy}
            onSelect={(presetConfig) => {
              // Presets send a fresh serializable mixed config ({ format: 'mixed', roundCount, teams, categoryIds }).
              // Engine normalization deletes any prior focused `roundTypeId` whenever resulting `format !== 'focused'`.
              void patch(presetConfig);
            }}
          />

          <Card className="flex flex-col gap-5">
            <h2 className="font-bold">{ar.settings}</h2>

            <Field label={ar.format}>
              <div className="grid grid-cols-3 gap-2">
                {FORMATS.map((format) => (
                  <Choice
                    key={format.id}
                    active={view.config.format === format.id}
                    disabled={configBusy}
                    onClick={() => {
                      if (format.id === 'focused') {
                        const defaultRoundTypeId =
                          selectedFocusedChoice?.eligibility.eligible
                            ? selectedFocusedChoice.id
                            : (focusedChoices.find((c) => c.eligibility.eligible)?.id ??
                              focusedChoices[0]?.id);
                        void patch(
                          defaultRoundTypeId
                            ? { format: 'focused', roundTypeId: defaultRoundTypeId }
                            : { format: 'focused' },
                        );
                      } else {
                        void patch({ format: format.id });
                      }
                    }}
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
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {focusedChoices.map((choice) => {
                    const active = view.config.roundTypeId === choice.id;
                    const eligible = choice.eligibility.eligible;
                    return (
                      <button
                        key={choice.id}
                        type="button"
                        disabled={configBusy || !eligible}
                        aria-pressed={active}
                        onClick={() => {
                          if (!eligible) return;
                          void patch({ format: 'focused', roundTypeId: choice.id });
                        }}
                        className={`flex min-h-14 flex-col items-start justify-between gap-1 rounded-xl border p-3 text-start text-sm transition ${
                          active
                            ? 'border-[var(--accent)] bg-surface-2 text-body'
                            : eligible
                              ? 'border-line bg-surface text-body hover:border-muted'
                              : 'border-dashed border-line bg-surface/50 text-muted opacity-55'
                        }`}
                      >
                        <div className="flex w-full flex-wrap items-center justify-between gap-1">
                          <span className="font-bold">{choice.nameAr}</span>
                          <span className="tabular rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-bold text-muted">
                            {choice.eligibility.badgeAr}
                          </span>
                        </div>
                        <span className="text-xs leading-snug text-muted">{choice.taglineAr}</span>
                        {!eligible ? (
                          <span className="text-[11px] font-bold text-accent-amber">
                            {choice.eligibility.statusAr}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </Field>
            ) : null}

            <Field label={ar.teams}>
              <button
                type="button"
                disabled={configBusy}
                aria-pressed={view.config.teams}
                onClick={() => void patch({ teams: !view.config.teams })}
                className={`flex min-h-14 w-full items-center gap-3 rounded-xl border px-4 text-start transition disabled:opacity-45 ${
                  view.config.teams
                    ? 'border-[var(--accent)] bg-surface-2'
                    : 'border-line text-muted'
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
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {MATCH_LENGTHS.map((length) => (
                  <Choice
                    key={length.roundCount}
                    active={view.config.roundCount === length.roundCount}
                    disabled={configBusy}
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
                      type="button"
                      disabled={configBusy}
                      aria-pressed={active}
                      onClick={() => {
                        const next = active
                          ? view.config.categoryIds.filter((id) => id !== category.id)
                          : [...view.config.categoryIds, category.id];
                        if (next.length === 0) return reportError('لازم مجال واحد على الأقل');
                        void patch({ categoryIds: next });
                      }}
                      className={`min-h-11 rounded-full border px-4 text-sm font-bold transition disabled:opacity-45 ${
                        active
                          ? 'border-[var(--accent)] bg-surface-2 text-body'
                          : 'border-line text-muted'
                      }`}
                    >
                      {category.emoji} {category.nameAr}
                    </button>
                  );
                })}
              </div>
            </Field>
          </Card>
        </>
      ) : (
        /* Guest view of actual selected format, match length, teams, and topics */
        <Card className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-bold">{ar.guestSettingsSummary}</h2>
            <Pill>{configSummary.lengthLabelAr}</Pill>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="rounded-2xl border border-line bg-surface-2 px-3.5 py-2.5">
              <span className="block text-xs text-muted">{ar.format}</span>
              <span className="block font-bold text-body">{configSummary.formatLabelAr}</span>
              <span className="mt-0.5 block text-xs text-muted">{configSummary.formatDetailAr}</span>
            </div>

            <div className="rounded-2xl border border-line bg-surface-2 px-3.5 py-2.5">
              <span className="block text-xs text-muted">{ar.teams}</span>
              <span className="block font-bold text-body">{configSummary.teamsLabelAr}</span>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted">{ar.categories}</span>
              <span className="tabular text-xs font-bold text-muted">
                {configSummary.categoriesSummaryAr}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {configSummary.selectedCategories.map((cat) => (
                <span
                  key={cat.id}
                  className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 px-3 py-1 text-xs font-bold text-body"
                >
                  <span aria-hidden="true">{cat.emoji}</span>
                  <span>{cat.nameAr}</span>
                </span>
              ))}
            </div>
          </div>
        </Card>
      )}

      {/* Browsable catalog with live room eligibility context */}
      <GameDiscovery
        playerCount={connectedCount}
        teams={view.config.teams}
        defaultCatalogOpen={false}
        defaultHowToPlayOpen={false}
      />

      {localError ? (
        <p
          role="alert"
          aria-live="assertive"
          className="text-center text-sm font-bold text-accent-rose"
        >
          {localError}
        </p>
      ) : null}

      {/*
        Pinned to the viewport, not the end of the page. The settings panel is taller than a
        phone screen, so a start button in normal flow sits below the fold — the host has to
        scroll past every option to reach the one control that matters.
      */}
      <div className="sticky bottom-0 -mx-4 mt-auto bg-ink/90 px-4 pb-6 pt-3 backdrop-blur">
        {isHost ? (
          <Button
            type="button"
            variant="accent"
            disabled={!canStart || startBusy || configBusy}
            onClick={() => void handleStart()}
          >
            {startBusy
              ? ar.sendingAction
              : connectedCount < MIN_PLAYERS
                ? ar.needMorePlayers
                : !focusedReady
                  ? (selectedFocusedChoice?.eligibility.statusAr ?? 'اختار لعبة مناسبة لعدد اللاعيبة')
                  : ar.startMatch}
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
  disabled = false,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={active}
      onClick={onClick}
      className={`min-h-14 rounded-xl border px-2 py-2 text-center text-sm transition disabled:opacity-45 ${
        active ? 'border-[var(--accent)] bg-surface-2 text-body' : 'border-line text-muted'
      }`}
    >
      {children}
    </button>
  );
}
