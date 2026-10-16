import { describe, expect, it } from 'vitest';
import type { AnyRoundType, ContentShape } from '@game/shared';
import {
  FINAL_ROUND_WEIGHT,
  NoEligibleRoundTypesError,
  generatePlaylist,
  suddenDeathType,
} from './playlist.js';
import { ROUND_TYPES, getRoundType } from './registry.js';
import { mulberry32 } from './test-drivers.js';

// Derived from the registry rather than listed by hand, so adding a round type that needs a
// new content shape does not silently drop it out of every test in this file.
const ALL_SHAPES: ContentShape[] = [...new Set(ROUND_TYPES.flatMap((t) => t.contentShapes))];
const MAX_MIN_PLAYERS = Math.max(...ROUND_TYPES.map((t) => t.minPlayers));

/**
 * A long type is one entry but two rounds of the match. Counting entries instead of slots is
 * what these assertions are actually about, so the conversion lives here rather than being
 * spelled out (and hardcoded to one type id) in each test.
 */
const slotsOf = (playlist: Array<{ roundTypeId: string }>, types = ROUND_TYPES) =>
  playlist.reduce((sum, e) => sum + (types.find((t) => t.id === e.roundTypeId)?.long ? 2 : 1), 0);

const build = (over: Partial<Parameters<typeof generatePlaylist>[0]> = {}) =>
  generatePlaylist({
    format: 'mixed',
    roundCount: 10,
    playerCount: MAX_MIN_PLAYERS,
    teams: true,
    availableShapes: ALL_SHAPES,
    rng: mulberry32(7),
    ...over,
  });

describe('generatePlaylist — mixed', () => {
  it('fills exactly the requested number of rounds', () => {
    expect(slotsOf(build({ roundCount: 5 }))).toBe(5);
    expect(slotsOf(build({ roundCount: 15 }))).toBe(15);
    expect(slotsOf(build({ roundCount: 20 }))).toBe(20);
  });

  it('holds up at the longest match length — قعدة كاملة', () => {
    // The same properties the 15-round tests check, but at the length that stresses usage
    // spread hardest: with more slots to fill, a type that dominates has more chances to show.
    for (let seed = 1; seed <= 100; seed += 1) {
      const playlist = build({ rng: mulberry32(seed), roundCount: 20 });
      for (let i = 1; i < playlist.length; i += 1) {
        expect(playlist[i]!.roundTypeId, `seed ${seed} at index ${i}`).not.toBe(
          playlist[i - 1]!.roundTypeId,
        );
      }
      const last = playlist[playlist.length - 1]!;
      expect(last.weight, `seed ${seed}`).toBe(FINAL_ROUND_WEIGHT);
      expect(getRoundType(last.roundTypeId).long, `seed ${seed}: final round is long`).toBe(false);
    }
  });

  it('never repeats a round type back to back', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const playlist = build({ rng: mulberry32(seed), roundCount: 15 });
      for (let i = 1; i < playlist.length; i += 1) {
        expect(playlist[i]!.roundTypeId, `seed ${seed} at index ${i}`).not.toBe(
          playlist[i - 1]!.roundTypeId,
        );
      }
    }
  });

  it('alternates pacing so the match breathes', () => {
    // With both fast and thinking types available, three identical-pacing rounds in a row
    // means the alternation rule has stopped working.
    for (let seed = 1; seed <= 100; seed += 1) {
      const playlist = build({ rng: mulberry32(seed), roundCount: 15 });
      const pacings = playlist.map((e) => getRoundType(e.roundTypeId).pacing);
      for (let i = 2; i < pacings.length; i += 1) {
        const run = pacings[i] === pacings[i - 1] && pacings[i - 1] === pacings[i - 2];
        expect(run, `seed ${seed}: three ${pacings[i]} rounds in a row at ${i}`).toBe(false);
      }
    }
  });

  it('lets none dominate a single match', () => {
    const playlist = build({ roundCount: 15 });
    const counts = new Map<string, number>();
    for (const entry of playlist) {
      counts.set(entry.roundTypeId, (counts.get(entry.roundTypeId) ?? 0) + 1);
    }

    // None should take over the match. Long types legitimately occupy two slots, so this is a
    // share cap rather than an exact-balance check.
    const busiest = Math.max(...counts.values());
    expect(busiest / playlist.length).toBeLessThan(0.4);
  });

  it('gives every eligible type a turn across an evening of matches', () => {
    // One 15-round match cannot fit all registered types even in principle once there are more
    // types than the longest match has slots for — six of them cost two slots each, so one of
    // everything needs more room than even a 20-round "قعدة كاملة" match has. What actually
    // matters is that nothing sits permanently on the bench across a whole night of matches,
    // so this checks the union across many playlists instead of coverage within one.
    const seen = new Set<string>();
    for (let seed = 1; seed <= 60; seed += 1) {
      const playlist = build({ roundCount: 15, rng: mulberry32(seed) });
      for (const entry of playlist) seen.add(entry.roundTypeId);
    }
    // A type nobody ever sees may as well not exist.
    expect(seen.size).toBe(ROUND_TYPES.length);
  });
  it('doubles the final round — سؤال الحسم', () => {
    const playlist = build();
    expect(playlist[playlist.length - 1]!.weight).toBe(FINAL_ROUND_WEIGHT);
  });

  it('leaves every non-final short round at weight 1', () => {
    const playlist = build();
    for (const entry of playlist.slice(0, -1)) {
      // A long type is worth two rounds because it takes the time of two.
      const expected = getRoundType(entry.roundTypeId).long ? 2 : 1;
      expect(entry.weight, entry.roundTypeId).toBe(expected);
    }
  });

  it('produces different orders for different matches with the same settings', () => {
    const a = build({ rng: mulberry32(1) }).map((e) => e.roundTypeId).join();
    const b = build({ rng: mulberry32(99) }).map((e) => e.roundTypeId).join();
    expect(a).not.toBe(b);
  });

  it('excludes types that need more players than the room has', () => {
    const soloHostile: AnyRoundType = { ...getRoundType('mcq_race'), id: 'needs_five', minPlayers: 5 };
    const playlist = generatePlaylist({
      format: 'mixed',
      roundCount: 6,
      playerCount: 2,
      teams: true,
      availableShapes: ALL_SHAPES,
      rng: mulberry32(3),
      types: [...ROUND_TYPES, soloHostile],
    });
    expect(playlist.map((e) => e.roundTypeId)).not.toContain('needs_five');
  });

  it('excludes types whose content shape has nothing behind it', () => {
    const playlist = build({ availableShapes: ['mcq', 'numeric'] });
    const used = new Set(playlist.map((e) => e.roundTypeId));
    expect(used.has('quickfire_tf')).toBe(false);
    expect(used.has('fill_blank')).toBe(false);
  });

  it('falls back to repeating a type when only one is available', () => {
    // Constrained by the registry rather than by shape: several types consume plain mcq now,
    // so filtering on shape no longer narrows things to one.
    const playlist = build({ types: [getRoundType('mcq_race')], roundCount: 4 });
    expect(playlist.map((e) => e.roundTypeId)).toEqual(Array(4).fill('mcq_race'));
  });

  it('refuses to build a playlist when nothing is eligible', () => {
    expect(() => build({ availableShapes: [] })).toThrow(NoEligibleRoundTypesError);
  });
});

describe('generatePlaylist — long types', () => {
  const longType: AnyRoundType = {
    ...getRoundType('mcq_race'),
    id: 'quiz_xo',
    long: true,
    pacing: 'thinking',
  };
  const withLong = [...ROUND_TYPES, longType];

  it('never places a long type in the final slot', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const playlist = generatePlaylist({
        format: 'mixed',
        roundCount: 10,
        playerCount: 4,
        teams: true,
        availableShapes: ALL_SHAPES,
        rng: mulberry32(seed),
        types: withLong,
      });
      expect(playlist[playlist.length - 1]!.roundTypeId, `seed ${seed}`).not.toBe('quiz_xo');
    }
  });

  it('counts a long type as two rounds so the match does not overrun', () => {
    const playlist = generatePlaylist({
      format: 'mixed',
      roundCount: 10,
      playerCount: 4,
      teams: true,
      availableShapes: ALL_SHAPES,
      rng: mulberry32(5),
      types: withLong,
    });
    expect(slotsOf(playlist, withLong)).toBe(10);
  });
});

describe('generatePlaylist — focused', () => {
  it('uses the chosen type for every round', () => {
    const playlist = build({ format: 'focused', roundTypeId: 'numeric_guess', roundCount: 5 });
    expect(playlist.map((e) => e.roundTypeId)).toEqual(Array(5).fill('numeric_guess'));
  });

  it('still doubles the final round', () => {
    const playlist = build({ format: 'focused', roundTypeId: 'mcq_race', roundCount: 5 });
    expect(playlist[4]!.weight).toBe(FINAL_ROUND_WEIGHT);
  });

  it('rejects an unknown type', () => {
    expect(() => build({ format: 'focused', roundTypeId: 'nope' })).toThrow(
      NoEligibleRoundTypesError,
    );
  });
});

describe('generatePlaylist — tournament', () => {
  it('ramps difficulty from easy to hard', () => {
    const playlist = build({ format: 'tournament', roundCount: 10 });
    expect(playlist[0]!.difficulty).toBe(1);
    expect(playlist[playlist.length - 1]!.difficulty).toBe(5);
  });

  it('never steps difficulty backwards', () => {
    const playlist = build({ format: 'tournament', roundCount: 15 });
    const difficulties = playlist.map((e) => e.difficulty!);
    for (let i = 1; i < difficulties.length; i += 1) {
      expect(difficulties[i]!).toBeGreaterThanOrEqual(difficulties[i - 1]!);
    }
  });

  it('still obeys the no-repeat rule', () => {
    const playlist = build({ format: 'tournament', roundCount: 12 });
    for (let i = 1; i < playlist.length; i += 1) {
      expect(playlist[i]!.roundTypeId).not.toBe(playlist[i - 1]!.roundTypeId);
    }
  });
});

describe('suddenDeathType', () => {
  it('picks a type flagged for tie-breaks', () => {
    expect(suddenDeathType().supportsSuddenDeath).toBe(true);
  });

  it('throws when no type supports a tie-break', () => {
    const none = ROUND_TYPES.map((t) => ({ ...t, supportsSuddenDeath: false }));
    expect(() => suddenDeathType(none)).toThrow(NoEligibleRoundTypesError);
  });
});

describe('generatePlaylist — cooperative types', () => {
  const teamType = ROUND_TYPES.find((t) => t.requiresTeams)!;

  /**
   * A cooperative type in a solo match is not merely unbalanced, it is unplayable: every
   * player becomes their own one-person side, so everyone describes and nobody may guess.
   * The round burns its full minute and scores the whole room zero.
   */
  it('never picks a type that needs teams when the room is not split', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const playlist = build({ teams: false, rng: mulberry32(seed), roundCount: 15 });
      expect(playlist.map((e) => e.roundTypeId), `seed ${seed}`).not.toContain(teamType.id);
    }
  });

  it('picks it once the room is split', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 100; seed += 1) {
      for (const entry of build({ teams: true, rng: mulberry32(seed), roundCount: 15 })) {
        seen.add(entry.roundTypeId);
      }
    }
    expect(seen.has(teamType.id)).toBe(true);
  });

  it('refuses a focused match on a team type in a solo room', () => {
    expect(() => build({ format: 'focused', roundTypeId: teamType.id, teams: false })).toThrow(
      NoEligibleRoundTypesError,
    );
  });
});
