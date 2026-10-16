import type { AnyRoundType, ContentShape } from '@game/shared';
import { mcqRace } from './mcq-race.js';
import { numericGuess } from './numeric-guess.js';
import { quickfireTf } from './quickfire-tf.js';
import { fillBlank } from './fill-blank.js';
import { fibbing } from './fibbing.js';
import { whoAmongUs } from './who-among-us.js';
import { whoAmI } from './who-am-i.js';
import { ordering } from './ordering.js';
import { steal } from './steal.js';
import { bidding } from './bidding.js';
import { landGrab } from './land-grab.js';
import { describeIt } from './describe-it.js';
import { oddOneOut } from './odd-one-out.js';
import { emojiRush } from './emoji-rush.js';
import { ladder } from './ladder.js';
import { higherLower } from './higher-lower.js';
import { relay } from './relay.js';
import { wordRace } from './word-race.js';

/**
 * The registry lives in its own module rather than in the barrel file so that `playlist.ts`
 * can read it without importing the barrel — a cycle that leaves consumers seeing `undefined`
 * for anything the barrel re-exports.
 *
 * Adding a game is one entry here. The playlist generator, the sudden-death picker, and the
 * 200-point ceiling test all read from this list, so a new type is wired in and
 * balance-checked without touching the engine.
 */
export const ROUND_TYPES: AnyRoundType[] = [
  mcqRace,
  numericGuess,
  quickfireTf,
  fillBlank,
  fibbing,
  whoAmongUs,
  whoAmI,
  ordering,
  steal,
  bidding,
  landGrab,
  describeIt,
  oddOneOut,
  emojiRush,
  ladder,
  higherLower,
  relay,
  wordRace,
];

const BY_ID = new Map(ROUND_TYPES.map((t) => [t.id, t]));

export function getRoundType(id: string): AnyRoundType {
  const type = BY_ID.get(id);
  if (!type) throw new Error(`Unknown round type: ${id}`);
  return type;
}

export function hasRoundType(id: string): boolean {
  return BY_ID.has(id);
}

export function roundTypesForShapes(available: ContentShape[]): AnyRoundType[] {
  return ROUND_TYPES.filter((t) => t.contentShapes.every((s) => available.includes(s)));
}
