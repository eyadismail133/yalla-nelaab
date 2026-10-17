import { z } from 'zod';
import type { PlayerId, PlayerRef, RoundScore } from './round-type.js';
import type { PlayerTotals, Standing, Team, TeamStanding } from './scoring.js';

/**
 * Party size.
 *
 * Eight rather than five because the rooms this is actually played in are family gatherings and
 * friend groups, and capping at five means somebody sits out and watches. Everything that had
 * to move to support it is listed in the README under "غرفة لحد 8" — the short version is that
 * a round type may now size itself to the room (`itemsFor`) instead of assuming a small one.
 *
 * Declared here rather than in the engine so the lobby can show the real cap instead of a
 * number hardcoded twice, which is how "الغرفة كاملة (5)" survived on screen past the change.
 */
export const MAX_PLAYERS = 8;
export const MIN_PLAYERS = 2;

export const MATCH_FORMATS = ['mixed', 'focused', 'tournament'] as const;
export type MatchFormat = (typeof MATCH_FORMATS)[number];

export const ROUND_COUNTS = [5, 10, 15, 20] as const;

export const matchConfigSchema = z.object({
  format: z.enum(MATCH_FORMATS).default('mixed'),
  categoryIds: z.array(z.string()).min(1),
  roundCount: z
    .union([z.literal(5), z.literal(10), z.literal(15), z.literal(20)])
    .default(10),
  /** Only used by the `focused` format. */
  roundTypeId: z.string().optional(),
  /** Splits the room into two sides that are ranked together. */
  teams: z.boolean().default(false),
});
export type MatchConfig = z.infer<typeof matchConfigSchema>;

export type RoomPhase =
  | 'lobby'
  | 'round_intro'
  | 'in_round'
  | 'round_result'
  | 'sudden_death_intro'
  | 'sudden_death'
  | 'podium';

export type EndReason = 'completed' | 'abandoned' | 'host_ended';

export interface PlaylistEntry {
  roundTypeId: string;
  /** 2 on the final "سؤال الحسم" round and on long types; 1 otherwise. */
  weight: number;
  /** Set by the `tournament` format to ramp difficulty; undefined means "any". */
  difficulty?: 1 | 2 | 3 | 4 | 5;
}

export const TEAMS: Team[] = [
  { id: 'team-a', nameAr: 'الفريق الأحمر', emoji: '🔴' },
  { id: 'team-b', nameAr: 'الفريق الأزرق', emoji: '🔵' },
];

export interface RoomPlayer extends PlayerRef {
  /**
   * Opaque reconnect secret — the whole of "auth" for a guest-only game.
   *
   * Returned once to the player who owns it and held in their tab, never in a view. It is
   * what `room:resume` trades for a seat, so it must never appear in another player's
   * payload — a leak would let anybody take over the seat and the score behind it.
   */
  token: string;
  joinedAtMs: number;
  disconnectedAtMs: number | null;
  leftEarly: boolean;
  ready?: boolean;
}

export interface SuddenDeathState {
  contenders: PlayerId[];
  attempt: number;
  resolvedWinner: PlayerId | null;
}

export interface RoomState {
  code: string;
  hostId: PlayerId;
  players: RoomPlayer[];
  config: MatchConfig;
  phase: RoomPhase;
  /** Absolute epoch ms at which the current phase should advance. Null = waits on a player. */
  phaseEndsAtMs: number | null;

  /**
   * Store-level optimistic-concurrency guard, bumped on EVERY transition. Two servers racing
   * to write the same room: the first wins, the second retries against fresh state.
   */
  version: number;

  /**
   * Round identity, bumped only when a new round (or sudden-death attempt) begins.
   *
   * This is what player actions are validated against — deliberately not `version`. Three
   * players answering simultaneously each bump `version`, so guarding actions on it would
   * accept the first answer and silently discard the rest. `roundNo` changes only when the
   * thing the player was actually looking at changes, which is the real staleness question.
   */
  roundNo: number;

  playlist: PlaylistEntry[];
  roundIndex: number;
  roundTypeId: string | null;
  roundState: unknown | null;
  /**
   * Content fetched during the intro card and consumed when play actually starts, so the round
   * clock begins when players can act rather than when the server decided to fetch.
   * Server-only — it holds correct answers and never reaches a RoomView.
   */
  pendingContent: unknown[] | null;
  roundStartedAtMs: number | null;
  lastRoundScores: RoundScore[] | null;
  lastReveal: unknown | null;

  totals: PlayerTotals[];
  standings: Standing[];
  /** Populated only in team matches; empty otherwise. */
  teamStandings: TeamStanding[];
  previousRanks: Record<PlayerId, number>;

  usedContentIds: string[];
  suddenDeath: SuddenDeathState | null;
  /**
   * Who gets the crown. Normally the sole rank-1 player; after a tie-break it is the
   * sudden-death victor while the scoreboard still honestly shows the tied totals.
   */
  winnerId: PlayerId | null;
  winningTeamId: string | null;
  endReason: EndReason | null;
  createdAtMs: number;
  updatedAtMs: number;
}

/** The per-player redacted projection pushed after every transition. */
export interface RoomView {
  code: string;
  phase: RoomPhase;
  phaseEndsAtMs: number | null;
  serverNowMs: number;
  you: { id: PlayerId; nickname: string; isHost: boolean };
  players: Array<{
    id: PlayerId;
    nickname: string;
    connected: boolean;
    isHost: boolean;
    total: number;
    rank: number | null;
    leftEarly: boolean;
    teamId: string | null;
    ready?: boolean;
  }>;
  config: MatchConfig;
  round: {
    /** Echo this back with every action so the server can drop taps from a finished round. */
    roundNo: number;
    index: number;
    total: number;
    typeId: string;
    nameAr: string;
    taglineAr: string;
    scoringHintAr: string;
    accent: string;
    weight: number;
    isFinalRound: boolean;
    view: unknown;
  } | null;
  reveal: unknown | null;
  standings: Standing[];
  teamStandings: TeamStanding[];
  teams: Team[];
  lastRoundScores: RoundScore[] | null;
  suddenDeath: SuddenDeathState | null;
  winnerId: PlayerId | null;
  winningTeamId: string | null;
  endReason: EndReason | null;
  availableCategories: Array<{ id: string; nameAr: string; emoji: string }>;
  availableRoundTypes: Array<{ id: string; nameAr: string; taglineAr: string; accent: string }>;
}
