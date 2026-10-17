import type { GameTransport } from '../net/transport.js';

/** Client-side mirrors of what each round type's `view()` returns. */

export interface McqRaceView {
  textAr: string;
  options: string[];
  myChoice: number | null;
  hasAnswered: boolean;
  lockedCount: number;
  totalPlayers: number;
}

export interface NumericGuessView {
  textAr: string;
  unitAr: string | null;
  myGuess: number | null;
  hasGuessed: boolean;
  lockedCount: number;
  totalPlayers: number;
}

export interface QuickfireView {
  current: { index: number; textAr: string } | null;
  answeredCount: number;
  totalItems: number;
  isDone: boolean;
  progress: Array<{ playerId: string; answered: number }>;
}

export interface FillBlankView {
  textAr: string;
  myAttempts: string[];
  attemptsLeft: number;
  hasSolved: boolean;
  solvedCount: number;
  totalPlayers: number;
}

export interface RoundProps<V> {
  view: V;
  roundNo: number;
  client: GameTransport;
}

export type FibbingView =
  | {
      stage: 'writing';
      textAr: string;
      myLie: string | null;
      lockedCount: number;
      totalPlayers: number;
    }
  | {
      stage: 'voting';
      textAr: string;
      options: Array<{ id: string; textAr: string }>;
      /** Options this player wrote — shown, but not selectable. */
      myOptionIds: string[];
      myVote: string | null;
      lockedCount: number;
      totalPlayers: number;
    };

export interface WhoAmongUsView {
  textAr: string;
  candidates: string[];
  myVote: string | null;
  hasVoted: boolean;
  lockedCount: number;
  totalPlayers: number;
}

export interface WhoAmIView {
  hints: string[];
  totalHints: number;
  myAttempts: string[];
  attemptsLeft: number;
  hasSolved: boolean;
  pointsIfRightNow: number;
  /** Server-clock instant the next clue lands, or null once they are all out. */
  nextHintAtMs: number | null;
  /** What the answer will be worth once that clue lands. */
  pointsAfterNextHint: number | null;
  solvedCount: number;
  totalPlayers: number;
}

export interface OrderingView {
  textAr: string;
  items: string[];
  /** Indices into `items`, in the order this player tapped them. */
  myOrder: number[];
  isLocked: boolean;
  lockedCount: number;
  totalPlayers: number;
}

export type StealView =
  | {
      stage: 'answering';
      textAr: string;
      options: string[];
      myChoice: number | null;
      hasAnswered: boolean;
      lockedCount: number;
      totalPlayers: number;
    }
  | {
      stage: 'stealing';
      textAr: string;
      iWasCorrect: boolean;
      targets: string[];
      myTarget: string | null;
      hasActed: boolean;
      lockedCount: number;
      totalPlayers: number;
    };

export type BiddingView =
  | {
      stage: 'bidding';
      maxBid: number;
      pointsPerBid: number;
      totalQuestions: number;
      myBid: number | null;
      lockedCount: number;
      totalPlayers: number;
    }
  | {
      stage: 'answering';
      myBid: number | null;
      current: { index: number; textAr: string; options: string[] } | null;
      answeredCount: number;
      totalQuestions: number;
      isDone: boolean;
      totalPlayers: number;
    };

export interface LandGrabView {
  board: Array<{ cell: number; ownerId: string | null; failedByMe: boolean }>;
  openCell: { cell: number; textAr: string; options: string[] } | null;
  myCells: number;
  totalCells: number;
}

export interface DescribeItView {
  isDescriber: boolean;
  /** Only ever populated for the describer. */
  secretAr: string | null;
  clues: string[];
  rejectedCount: number;
  /** True only while the last clue this describer sent was rejected. */
  lastClueRejected: boolean;
  teamSolved: boolean;
  solvedTeams: number;
  totalTeams: number;
}

export interface OddOneOutView {
  puzzles: Array<{ textAr: string; items: string[] }>;
  /** Index-aligned with `puzzles`; null means that puzzle is still open. */
  myAnswers: Array<number | null>;
  isDone: boolean;
  lockedCount: number;
  totalPlayers: number;
}

export interface EmojiRushView {
  current: { index: number; emojis: string; hintAr: string | null; categoryId: string } | null;
  solvedCount: number;
  totalItems: number;
  isDone: boolean;
  progress: Array<{ playerId: string; count: number }>;
}

export interface LadderView {
  /** The value of banking at each rung, 1-indexed by how many are climbed. */
  ladder: readonly number[];
  rung: number;
  isBusted: boolean;
  isLocked: boolean;
  current: { textAr: string; options: string[] } | null;
  bankedValue: number | null;
  doneCount: number;
  totalPlayers: number;
}

export interface HigherLowerView {
  current: {
    index: number;
    a: { textAr: string; unitAr: string | null };
    b: { textAr: string; unitAr: string | null };
  } | null;
  answeredCount: number;
  totalPairs: number;
  isDone: boolean;
  progress: Array<{ playerId: string; answered: number }>;
}

export interface RelayView {
  myTeamId: string | null;
  myRung: number;
  otherTeams: Array<{ teamId: string; rung: number; asked: number }>;
  activePlayerId: string | null;
  canAnswer: boolean;
  current: { textAr: string; options: string[] } | null;
  askedCount: number;
  totalRungs: number;
}

export type WordRaceView =
  | {
      stage: 'writing';
      letter: string;
      fieldsAr: string[];
      /** Index-aligned with `fieldsAr`; null means that field is still blank. */
      myAnswers: Array<string | null>;
      lockedCount: number;
      totalPlayers: number;
    }
  | {
      stage: 'voting';
      letter: string;
      fieldsAr: string[];
      table: Array<{
        authorId: string;
        fields: Array<{ text: string | null; rejectedCount: number; rejectedByMe: boolean }>;
      }>;
      isReady: boolean;
      readyCount: number;
      totalPlayers: number;
    };
