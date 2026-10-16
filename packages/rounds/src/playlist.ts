import type {
  AnyRoundType,
  ContentShape,
  Difficulty,
  MatchFormat,
  PlaylistEntry,
} from '@game/shared';
import { ROUND_TYPES } from './registry.js';

export const FINAL_ROUND_WEIGHT = 2;

export interface PlaylistInput {
  format: MatchFormat;
  roundCount: number;
  playerCount: number;
  /** Whether the room is split into sides. Cooperative types are unplayable without it. */
  teams: boolean;
  /** Shapes that actually have enough approved content for the chosen categories. */
  availableShapes: ContentShape[];
  /** Required by the `focused` format. */
  roundTypeId?: string;
  rng?: () => number;
  types?: AnyRoundType[];
}

export class NoEligibleRoundTypesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoEligibleRoundTypesError';
  }
}

function eligibleTypes(input: PlaylistInput): AnyRoundType[] {
  const all = input.types ?? ROUND_TYPES;
  return all.filter(
    (t) =>
      t.minPlayers <= input.playerCount &&
      (input.teams || !t.requiresTeams) &&
      t.contentShapes.every((shape) => input.availableShapes.includes(shape)),
  );
}

/** Difficulty ramp for the tournament format: gentle opening, hard finish. */
function tournamentDifficulty(index: number, total: number): Difficulty {
  if (total <= 1) return 3;
  const ratio = index / (total - 1);
  return (Math.min(5, Math.max(1, Math.round(1 + ratio * 4))) as Difficulty);
}

/**
 * Builds the round order for a match.
 *
 * The rules exist to fight the one failure mode this whole product has: a match that feels
 * like the same question ten times. Concretely —
 *
 *  - never the same type twice in a row, so the screen always changes;
 *  - alternate `fast` and `thinking` pacing, so the match breathes instead of exhausting;
 *  - spread usage evenly rather than picking at random, because pure randomness clusters;
 *  - the final round is always ×2 and always a type every player can still win from — a
 *    turn-based finale leaves an eliminated player watching, which is a terrible last memory.
 */
export function generatePlaylist(input: PlaylistInput): PlaylistEntry[] {
  const rng = input.rng ?? Math.random;
  const eligible = eligibleTypes(input);

  if (eligible.length === 0) {
    throw new NoEligibleRoundTypesError(
      'مفيش نوع لعبة يقدر يشتغل بعدد اللاعبين دول والأسئلة المتاحة',
    );
  }

  if (input.format === 'focused') {
    const chosen = eligible.find((t) => t.id === input.roundTypeId);
    if (!chosen) {
      throw new NoEligibleRoundTypesError(`نوع اللعبة "${input.roundTypeId}" مش متاح دلوقتي`);
    }
    return Array.from({ length: input.roundCount }, (_, i) => ({
      roundTypeId: chosen.id,
      weight: i === input.roundCount - 1 ? FINAL_ROUND_WEIGHT : 1,
    }));
  }

  const entries: PlaylistEntry[] = [];
  const usage = new Map<string, number>(eligible.map((t) => [t.id, 0]));
  let slotsUsed = 0;
  let previous: AnyRoundType | null = null;

  while (slotsUsed < input.roundCount) {
    const slotsLeft = input.roundCount - slotsUsed;
    const isFinalSlot = slotsLeft === 1;

    let candidates = eligible.filter((t) => (t.long ? 2 : 1) <= slotsLeft);
    // A long type occupies two slots, so it lands in the finale whenever two or fewer remain —
    // and a turn-based finale leaves an eliminated player watching the match get decided.
    if (slotsLeft <= 2) {
      const short = candidates.filter((t) => !t.long);
      if (short.length > 0) candidates = short;
    }
    // Never repeat back-to-back — unless there is genuinely nothing else available.
    const withoutRepeat = candidates.filter((t) => t.id !== previous?.id);
    if (withoutRepeat.length > 0) candidates = withoutRepeat;

    if (candidates.length === 0) {
      throw new NoEligibleRoundTypesError('مقدرناش نكوّن ترتيب جولات بالإعدادات دي');
    }

    const scored = candidates.map((type) => {
      let score = 0;
      if (previous && type.pacing !== previous.pacing) score += 100;
      // Weighted so that two uses (−120) outweigh the pacing bonus (+100). Without that,
      // pacing alternation alone lets one type take every other slot in a long match.
      score -= (usage.get(type.id) ?? 0) * 60;
      score += rng() * 10; // tiny jitter so two matches with the same settings still differ
      return { type, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const chosen = scored[0]!.type;

    const slotCost = chosen.long ? 2 : 1;
    entries.push({
      roundTypeId: chosen.id,
      weight: isFinalSlot ? FINAL_ROUND_WEIGHT : chosen.long ? 2 : 1,
      ...(input.format === 'tournament'
        ? // Ramped by slot, not by entry: a long type fills two slots, so counting entries
          // makes the ladder finish short of the top in any match containing one.
          { difficulty: tournamentDifficulty(slotsUsed, input.roundCount) }
        : {}),
    });

    usage.set(chosen.id, (usage.get(chosen.id) ?? 0) + 1);
    slotsUsed += slotCost;
    previous = chosen;
  }

  const last = entries[entries.length - 1];
  if (last) last.weight = FINAL_ROUND_WEIGHT;

  return entries;
}

/** Picks the type used for a sudden-death tie-break. */
export function suddenDeathType(types: AnyRoundType[] = ROUND_TYPES): AnyRoundType {
  const candidate = types.find((t) => t.supportsSuddenDeath);
  if (!candidate) throw new NoEligibleRoundTypesError('مفيش نوع لعبة صالح لفك التعادل');
  return candidate;
}
