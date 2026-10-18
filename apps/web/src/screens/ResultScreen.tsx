import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { RoomView } from '@game/shared';
import { ar } from '../i18n/ar.js';
import type { GameTransport } from '../net/transport.js';
import { Button, Card, Screen } from '../ui/primitives.js';
import { useCountdown } from '../ui/useCountdown.js';
import { playerTint } from '../ui/playerColors.js';
import { REVEALS } from './reveals.js';
import { RoundActionStatus, useRoundAction } from '../rounds/useRoundAction.js';

export function ResultScreen({
  view,
  client,
  onError,
}: {
  view: RoomView;
  client: GameTransport;
  onError: (message: string) => void;
}) {
  const [skipping, setSkipping] = useState(false);
  const round = view.round!;
  const gained = new Map(view.lastRoundScores?.map((s) => [s.playerId, s.points]) ?? []);
  const remaining = useCountdown(client, view.phaseEndsAtMs);
  const readyAction = useRoundAction(client, round.roundNo);
  const ready = view.resultReady?.includes(view.you.id) || readyAction.submittedAction !== null;
  const connectedPlayers = view.players.filter((player) => player.connected && !player.leftEarly && !player.spectator);

  return (
    <Screen accent={round.accent}>
      <Card className="result-reveal text-center">
        <p className="text-sm text-muted">{ar.correctAnswer}</p>
        <Reveal typeId={round.typeId} reveal={view.reveal} view={view} />
      </Card>

      {view.teamStandings.length > 0 ? <TeamScoreboard view={view} /> : null}
      <Scoreboard view={view} gained={gained} />

      {/*
        The gap between rounds is the part of the evening people actually remember, so it is
        long enough to argue in — and the countdown says so out loud, because silence with no
        visible clock reads as the game having frozen. The host can end it early; nobody else
        can, or the loudest thumb in the room decides when the conversation is over.
      */}
      <div className="mt-auto flex flex-col items-center gap-2 pt-2">
        {!view.you.isSpectator ? <Button variant="accent" disabled={readyAction.pending || ready}
          onClick={() => void readyAction.act({ kind: 'result_ready' })}>
          {ready ? 'جاهز ✓' : 'جاهز للجولة الجاية'} ({connectedPlayers.filter((player) => view.resultReady?.includes(player.id)).length}/{connectedPlayers.length})
        </Button> : null}
        <RoundActionStatus error={readyAction.error} pending={readyAction.pending} />
        <p className="tabular text-sm text-muted">
          {ar.nextRoundIn} {Math.ceil(remaining / 1000)}
          {ar.secondsShort}
        </p>
        {view.you.isHost ? (
          <Button
            type="button"
            variant="ghost"
            disabled={skipping}
            onClick={async () => {
              if (skipping) return;
              setSkipping(true);
              try {
                const result = await client.skip();
                // A skip that lost the race to the sweeper is not worth a toast — the screen has
                // already moved on and the player can see it did.
                if (!result.ok && view.phase === 'round_result') onError(result.error);
              } catch (err) {
                if (view.phase === 'round_result') {
                  onError(err instanceof Error && err.message ? err.message : ar.actionFailed);
                }
              } finally {
                setSkipping(false);
              }
            }}
          >
            {skipping ? ar.sendingAction : ar.continueNow}
          </Button>
        ) : (
          <p className="text-center text-xs text-muted">{ar.discussHint}</p>
        )}
      </div>
    </Screen>
  );
}

/**
 * Dispatches to the renderer registered for this round type.
 *
 * The payload is typed `unknown` all the way from the server on purpose — it is whatever that
 * type's `reveal()` returned, and only the matching renderer knows its shape. The cast happens
 * here, once, at the boundary where the type id makes it safe.
 */
function Reveal({ typeId, reveal, view }: { typeId: string; reveal: unknown; view: RoomView }) {
  if (!reveal) return null;

  const Renderer = REVEALS[typeId];
  if (!Renderer) return null;

  const nameOf = (id: string) => view.players.find((p) => p.id === id)?.nickname ?? String(id);
  return <>{Renderer({ reveal: reveal as never, nameOf })}</>;
}

/** Team totals, shown above the individual board when a team match is running. */
export function TeamScoreboard({ view }: { view: RoomView }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-bold">{ar.teamScoreboard}</h2>
      {view.teamStandings.map((standing) => {
        const team = view.teams.find((t) => t.id === standing.teamId);
        const mine = view.players.find((p) => p.id === view.you.id)?.teamId === standing.teamId;
        return (
          <div
            key={standing.teamId}
            className={`flex items-center gap-3 rounded-2xl border px-4 py-3 ${
              mine ? 'border-[var(--accent)] bg-surface-2' : 'border-line bg-surface'
            }`}
          >
            <span className="text-2xl">{team?.emoji}</span>
            <span className="flex-1 truncate font-bold">{team?.nameAr}</span>
            <span className="tabular text-xl font-black">{standing.total}</span>
          </div>
        );
      })}
    </section>
  );
}

/**
 * The standings, with rank changes animated.
 *
 * `layout` on each row is what makes players physically swap places instead of teleporting —
 * seeing yourself climb past someone is the single most satisfying moment in a party game, and
 * it costs one prop.
 */
export function Scoreboard({
  view,
  gained,
}: {
  view: RoomView;
  gained?: Map<string, number>;
}) {
  const byId = new Map(view.players.map((p) => [p.id, p]));

  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-bold">{ar.scoreboard}</h2>
      <AnimatePresence initial={false}>
        {view.standings.map((standing) => {
          const player = byId.get(standing.playerId);
          const delta = gained?.get(standing.playerId);
          const isMe = standing.playerId === view.you.id;

          return (
            <motion.div
              key={standing.playerId}
              layout
              transition={{ type: 'spring', stiffness: 420, damping: 34 }}
              className={`flex items-center gap-3 rounded-2xl border px-4 py-3 ${
                isMe ? 'border-[var(--accent)] bg-surface-2' : 'border-line bg-surface'
              }`}
            >
              <span className="tabular w-6 text-center text-lg font-black text-muted">
                {standing.rank}
              </span>

              {/* Eight Arabic names in one weight is a wall of text. The seat colour is the
                  same one the player wears on the قطع الأرض board, so a glance is enough. */}
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ background: playerTint(view.players, standing.playerId) }}
              />

              <span className="flex-1 truncate font-bold">
                {player?.nickname}
                {player && !player.connected ? (
                  <span className="ms-2 text-xs text-accent-rose">{ar.away}</span>
                ) : null}
              </span>

              {standing.rankDelta ? (
                <span
                  className="tabular text-xs font-bold"
                  style={{
                    color:
                      standing.rankDelta > 0
                        ? 'var(--color-accent-emerald)'
                        : 'var(--color-accent-rose)',
                  }}
                >
                  {standing.rankDelta > 0 ? '▲' : '▼'}
                  {Math.abs(standing.rankDelta)}
                </span>
              ) : null}

              {delta !== undefined && delta !== 0 ? (
                <span
                  className="tabular text-sm font-black"
                  style={{
                    color: delta > 0 ? 'var(--color-accent-emerald)' : 'var(--color-accent-rose)',
                  }}
                >
                  {delta > 0 ? '+' : ''}
                  {delta}
                </span>
              ) : null}

              <span className="tabular w-14 text-end text-lg font-black">{standing.total}</span>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </section>
  );
}
