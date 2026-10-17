import { TEAMS, type Category, type PlayerId, type RoomState, type RoomView } from '@game/shared';
import { ROUND_TYPES, getRoundType } from '@game/rounds';

const ROUND_TYPE_SUMMARY = ROUND_TYPES.map((t) => ({
  id: t.id,
  nameAr: t.nameAr,
  taglineAr: t.taglineAr,
  accent: t.accent,
}));

/**
 * Projects server state into what one player is allowed to see.
 *
 * This is the only path from RoomState to the wire, which is deliberate: there is exactly one
 * place a correct answer could leak, and it is covered by the redaction tests. Note what is
 * never copied across — `pendingContent` (raw questions with their answers) and the round's
 * internal state; the client only ever gets `type.view()` before the reveal.
 */
export function toView(
  state: RoomState,
  playerId: PlayerId,
  categories: Category[],
  serverNowMs: number = Date.now(),
): RoomView {
  const me = state.players.find((p) => p.id === playerId);
  const standingsById = new Map(state.standings.map((s) => [s.playerId, s]));
  const revealed =
    state.phase === 'round_result' || state.phase === 'podium' ? state.lastReveal : null;

  return {
    code: state.code,
    phase: state.phase,
    phaseEndsAtMs: state.phaseEndsAtMs,
    serverNowMs,
    you: {
      id: playerId,
      nickname: me?.nickname ?? '',
      isHost: state.hostId === playerId,
    },
    players: state.players.map((p) => ({
      id: p.id,
      nickname: p.nickname,
      connected: p.connected,
      isHost: state.hostId === p.id,
      total: standingsById.get(p.id)?.total ?? 0,
      rank: standingsById.get(p.id)?.rank ?? null,
      leftEarly: p.leftEarly,
      teamId: p.teamId,
      ready: Boolean(p.ready),
    })),
    config: state.config,
    round: buildRoundView(state, playerId),
    reveal: revealed,
    standings: state.standings,
    teamStandings: state.teamStandings,
    teams: state.config.teams ? TEAMS : [],
    lastRoundScores: state.lastRoundScores,
    suddenDeath: state.suddenDeath,
    winnerId: state.winnerId,
    winningTeamId: state.winningTeamId,
    endReason: state.endReason,
    availableCategories: categories,
    availableRoundTypes: ROUND_TYPE_SUMMARY,
  };
}

function buildRoundView(state: RoomState, playerId: PlayerId): RoomView['round'] {
  if (!state.roundTypeId) return null;
  const type = getRoundType(state.roundTypeId);
  const entry = state.playlist[state.roundIndex];
  const isSuddenDeath = state.phase === 'sudden_death' || state.phase === 'sudden_death_intro';

  // During the intro card there is no view yet — the card shows the type's name, tagline and
  // scoring rule, so players know the rules before the clock starts rather than after.
  const playing = state.phase === 'in_round' || state.phase === 'sudden_death';

  return {
    roundNo: state.roundNo,
    index: state.roundIndex + 1,
    total: state.playlist.length,
    typeId: type.id,
    nameAr: type.nameAr,
    taglineAr: type.taglineAr,
    scoringHintAr: type.scoringHintAr,
    accent: type.accent,
    weight: isSuddenDeath ? 1 : (entry?.weight ?? 1),
    isFinalRound: !isSuddenDeath && state.roundIndex === state.playlist.length - 1,
    view: playing && state.roundState ? type.view(state.roundState, playerId) : null,
  };
}
