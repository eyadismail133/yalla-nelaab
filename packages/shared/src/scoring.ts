import { ROUND_MAX_POINTS, type PlayerId, type RoundScore } from './round-type.js';

export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * Speed bonus that holds flat through a reading window, then decays linearly to zero.
 *
 * Two properties matter, and the grace window is what buys the second one:
 *
 *  1. A correct answer submitted at the very last instant still earns the full base score, so
 *     speed differentiates but knowledge decides. A fast wrong answer never beats a slow
 *     correct one.
 *  2. Reading the question is not slowness. Without `graceMs` the bonus starts draining the
 *     instant the round opens, so the maximum is only reachable by somebody who taps before
 *     they could possibly have read four Arabic options — the round pays for reflexes and for
 *     a good phone connection instead of for knowing the answer. Nothing decays until the
 *     grace window has passed, which is roughly how long reading actually takes.
 */
export function speedBonus(
  answeredAtMs: number,
  startedAtMs: number,
  endsAtMs: number,
  maxBonus: number,
  graceMs = 0,
): number {
  const total = endsAtMs - startedAtMs;
  if (total <= 0) return maxBonus;

  const elapsed = clamp(answeredAtMs, startedAtMs, endsAtMs) - startedAtMs;
  const grace = clamp(graceMs, 0, total);
  if (elapsed <= grace) return maxBonus;

  const decayWindow = total - grace;
  if (decayWindow <= 0) return maxBonus;
  return Math.round(maxBonus * ((total - elapsed) / decayWindow));
}

/**
 * Applies the playlist weight (2 on the final "سؤال الحسم" round) and enforces the ceiling.
 *
 * The clamp is a backstop, not the primary guarantee — the ceiling invariant test is. But a
 * bug in one round type should cost that round's balance, not the whole match.
 */
export function scoreRound(raw: RoundScore[], weight: number): RoundScore[] {
  return raw.map((s) => ({
    ...s,
    points: clamp(s.points, -ROUND_MAX_POINTS, ROUND_MAX_POINTS) * weight,
  }));
}

export interface PlayerTotals {
  playerId: PlayerId;
  total: number;
  correctCount: number;
  /** Sum of response times across rounds — the second-to-last tie-break. */
  totalMs: number;
}

export interface Standing extends PlayerTotals {
  rank: number;
  /** Positive = climbed since the previous round. Null on the first round. */
  rankDelta: number | null;
}

/**
 * Folds a resolved round's scores into the running totals.
 *
 * `noAnswerMs` is what a player who never acted is charged for the round, and it has to be the
 * round's full length rather than zero. `totalMs` is a tie-break sorted *ascending*, so counting
 * silence as zero milliseconds makes it the fastest possible time — a player who sits out every
 * round ends on 0 points with a perfect 0ms and beats everyone else who also ended on 0. That is
 * not a corner case: a 0–0 match handed the win to the player who never touched the screen, and
 * an away player scoring 0 for missed rounds hits it every time.
 */
export function accumulate(
  totals: PlayerTotals[],
  round: RoundScore[],
  noAnswerMs: number,
): PlayerTotals[] {
  const byId = new Map(round.map((s) => [s.playerId, s]));
  return totals.map((t) => {
    const s = byId.get(t.playerId);
    if (!s) return t;
    return {
      playerId: t.playerId,
      total: t.total + s.points,
      correctCount: t.correctCount + (s.isCorrect ? 1 : 0),
      totalMs: t.totalMs + (s.msTaken ?? noAnswerMs),
    };
  });
}

/**
 * Ranks by total, then correct count, then speed. Equal on all three genuinely share a rank
 * (standard competition ranking: 1, 2, 2, 4).
 */
export function rankPlayers(
  totals: PlayerTotals[],
  previousRanks?: Map<PlayerId, number>,
): Standing[] {
  const sorted = [...totals].sort(
    (a, b) => b.total - a.total || b.correctCount - a.correctCount || a.totalMs - b.totalMs,
  );

  const standings: Standing[] = [];
  for (const [i, entry] of sorted.entries()) {
    const prev = standings[i - 1];
    const tiedWithPrev =
      prev !== undefined &&
      prev.total === entry.total &&
      prev.correctCount === entry.correctCount &&
      prev.totalMs === entry.totalMs;

    const rank = tiedWithPrev ? prev.rank : i + 1;
    const previousRank = previousRanks?.get(entry.playerId);
    standings.push({
      ...entry,
      rank,
      rankDelta: previousRank === undefined ? null : previousRank - rank,
    });
  }
  return standings;
}

/**
 * Sudden death fires only for a tie at the top — a shared 4th place is not worth interrupting
 * the podium for. Returns null when there is a clear winner.
 */
export function detectTie(standings: Standing[]): PlayerId[] | null {
  const leaders = standings.filter((s) => s.rank === 1);
  return leaders.length > 1 ? leaders.map((s) => s.playerId) : null;
}

export function emptyTotals(playerIds: PlayerId[]): PlayerTotals[] {
  return playerIds.map((playerId) => ({ playerId, total: 0, correctCount: 0, totalMs: 0 }));
}

export interface Team {
  id: string;
  nameAr: string;
  emoji: string;
}

export interface TeamStanding {
  teamId: string;
  /** Mean of the members' totals — see the note on `rankTeams`. */
  total: number;
  rank: number;
  memberIds: PlayerId[];
}

/**
 * Ranks teams by the MEAN of their members' scores, not the sum.
 *
 * Summing would hand a three-player team a standing win over a two-player team that played
 * better, and rooms rarely split evenly — five players means 3 against 2. Averaging makes team
 * size irrelevant to the result, so the host can put friends together without accidentally
 * deciding the match in the lobby.
 */
export function rankTeams(
  totals: PlayerTotals[],
  membership: Map<PlayerId, string>,
  teamIds: string[],
): TeamStanding[] {
  const scored = teamIds.map((teamId) => {
    const members = totals.filter((t) => membership.get(t.playerId) === teamId);
    const sum = members.reduce((acc, m) => acc + m.total, 0);
    return {
      teamId,
      total: members.length ? Math.round(sum / members.length) : 0,
      memberIds: members.map((m) => m.playerId),
    };
  });

  scored.sort((a, b) => b.total - a.total);

  const standings: TeamStanding[] = [];
  for (const [i, entry] of scored.entries()) {
    const previous = standings[i - 1];
    const rank = previous && previous.total === entry.total ? previous.rank : i + 1;
    standings.push({ ...entry, rank });
  }
  return standings;
}
