import type { ContentItem, ContentShape } from './content.js';

export type PlayerId = string;

export interface PlayerRef {
  id: PlayerId;
  nickname: string;
  /** Away players still occupy a seat and are still ranked; they just score 0. */
  connected: boolean;
  /** Null outside team matches. Cooperative round types read this to pair players up. */
  teamId: string | null;
}

/**
 * The single most important number in the design.
 *
 * Every round type reaches this ceiling by a completely different internal formula — speed,
 * proximity, risk, patience. Different feel, identical weight. Without a shared ceiling the
 * match is decided by whoever happens to be good at the highest-scoring type, and the mixed
 * playlist stops being fair.
 *
 * `roundCeilingInvariant` in the test suite runs against every registered type and fails the
 * build if any of them can exceed this — including types added years from now.
 */
export const ROUND_MAX_POINTS = 200;

export interface RoundInit {
  players: PlayerRef[];
  startedAtMs: number;
  endsAtMs: number;
}

export interface ActionCtx {
  playerId: PlayerId;
  /** Server clock. Never trust a client-supplied timestamp — this is the anti-cheat anchor. */
  nowMs: number;
}

export interface DeadlineCtx {
  nowMs: number;
}

export interface StepResult<S> {
  state: S;
  events: RoundEvent[];
}

export type RoundEvent =
  | { type: 'player_locked'; playerId: PlayerId }
  | { type: 'hint_revealed'; index: number }
  | { type: 'sub_round_advanced'; index: number }
  | { type: 'all_locked' };

export interface RoundScore {
  playerId: PlayerId;
  /** Raw points before the playlist weight is applied. May be negative for risk-based types. */
  points: number;
  isCorrect: boolean;
  /** Time from round start to the player's decisive action; null if they never acted. */
  msTaken: number | null;
}

export type Pacing = 'fast' | 'thinking';

/**
 * A round type is a pure reducer. No sockets, no database, no clock — time arrives as data.
 *
 * That purity is what makes the prototype survive: these files are byte-identical before and
 * after Redis and Postgres are wired in, and each one is exhaustively testable in milliseconds.
 * Adding a game is one file here, one React component, one registry line.
 */
export interface RoundType<S = unknown, A = unknown> {
  id: string;
  nameAr: string;
  /** One line shown on the intro card, in Egyptian dialect. */
  taglineAr: string;
  /** How points work, in one line. Shown on the intro card so nobody is guessing the rules. */
  scoringHintAr: string;
  contentShapes: ContentShape[];
  /** How many content items one round consumes (quickfire plays five statements). */
  itemsPerRound: number;
  /**
   * Overrides `itemsPerRound` for a specific room size, for types whose board grows with the
   * party — قطع الأرض needs a bigger map for eight players or everybody ends on one square.
   *
   * Read through `itemsNeeded` rather than directly, so a type that does not declare it keeps
   * behaving exactly as before.
   */
  itemsFor?(playerCount: number): number;
  pacing: Pacing;
  /** Long types consume two playlist slots at weight 2 and are never placed last. */
  long: boolean;
  minPlayers: number;
  /**
   * Whether the type only works when the room is split into sides.
   *
   * A cooperative type has no meaning without a team: every player becomes their own
   * one-person side, which for وصّفهالي means everyone is their own describer, everyone is
   * shown the answer, and nobody is allowed to guess it. The round runs its full minute and
   * scores every player zero. The playlist must not be able to pick it in a solo match.
   */
  requiresTeams: boolean;
  durationMs: number;
  /**
   * How much of the shared result-screen budget this type's reveal deserves, as a multiplier.
   *
   * The gap between rounds is where the room actually talks — arguing about the answer, seeing
   * who fell for whose lie, watching the board swap places. A one-line MCQ answer is read in a
   * couple of seconds; الكذّابين puts nine lines and a vote tally on screen and is the funniest
   * moment in the match. Giving both the same window either rushes one or bores the other.
   *
   * Read through `revealMsFor`. Defaults to 1 — the engine's base result duration.
   */
  revealWeight?: number;
  /** Design-system accent token — each type visibly changes the screen. */
  accent: string;
  /** Whether the engine may use this type for a sudden-death tie-break. */
  supportsSuddenDeath: boolean;

  createState(content: ContentItem[], init: RoundInit): S;
  reduce(state: S, action: A, ctx: ActionCtx): StepResult<S>;
  onDeadline(state: S, ctx: DeadlineCtx): StepResult<S>;
  /** MUST NOT expose the correct answer to a player who has not locked in yet. */
  view(state: S, playerId: PlayerId): unknown;
  /** The full post-round reveal, sent to everyone once the round is resolved. */
  reveal(state: S): unknown;
  isFinished(state: S): boolean;

  /**
   * When the engine should next call `onDeadline` — the round's own end, or an earlier
   * internal step such as closing the writing phase of a bluffing round.
   *
   * This is the single source of truth for round timing: the engine reads it after creating
   * the state and after every action, so a type can move its own deadline forward when
   * everybody has already acted. Returns null only once the round is finished, an invariant
   * the shared test suite enforces for every registered type.
   */
  nextDeadline(state: S): number | null;

  roundScores(state: S): RoundScore[];
}

export type AnyRoundType = RoundType<any, any>;

/** How many content items this type needs for a room of this size. */
export function itemsNeeded(type: AnyRoundType, playerCount: number): number {
  return type.itemsFor?.(playerCount) ?? type.itemsPerRound;
}

/** How long this type's reveal stays on screen, given the engine's base result duration. */
export function revealMsFor(type: AnyRoundType, baseMs: number): number {
  return Math.round(baseMs * (type.revealWeight ?? 1));
}
