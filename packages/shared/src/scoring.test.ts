import { describe, expect, it } from 'vitest';
import {
  accumulate,
  detectTie,
  emptyTotals,
  rankPlayers,
  rankTeams,
  scoreRound,
  speedBonus,
} from './scoring.js';
import type { RoundScore } from './round-type.js';

const START = 1_000_000;
const END = START + 15_000;

describe('speedBonus', () => {
  it('awards the full bonus for an instant answer', () => {
    expect(speedBonus(START, START, END, 100)).toBe(100);
  });

  it('awards nothing at the deadline', () => {
    expect(speedBonus(END, START, END, 100)).toBe(0);
  });

  it('awards half at the midpoint', () => {
    expect(speedBonus(START + 7_500, START, END, 100)).toBe(50);
  });

  it('clamps answers arriving after the deadline instead of going negative', () => {
    expect(speedBonus(END + 5_000, START, END, 100)).toBe(0);
  });

  it('clamps answers claiming to predate the round start', () => {
    expect(speedBonus(START - 5_000, START, END, 100)).toBe(100);
  });

  it('does not divide by zero on a zero-length round', () => {
    expect(speedBonus(START, START, START, 100)).toBe(100);
  });

  describe('with a reading-grace window', () => {
    const GRACE = 3_000;

    it('pays the full bonus anywhere inside the grace window', () => {
      // The point of the window: nobody is charged for the seconds it takes to read the
      // question, so the maximum is reachable by knowing rather than by pre-tapping.
      expect(speedBonus(START, START, END, 100, GRACE)).toBe(100);
      expect(speedBonus(START + GRACE, START, END, 100, GRACE)).toBe(100);
    });

    it('starts decaying only once the window has passed', () => {
      expect(speedBonus(START + GRACE + 1_000, START, END, 100, GRACE)).toBeLessThan(100);
    });

    it('still reaches exactly zero at the deadline', () => {
      expect(speedBonus(END, START, END, 100, GRACE)).toBe(0);
    });

    it('decays across the remaining window, not the whole round', () => {
      // Halfway between the end of the grace and the deadline is half the bonus.
      const halfway = START + GRACE + (END - START - GRACE) / 2;
      expect(speedBonus(halfway, START, END, 100, GRACE)).toBe(50);
    });

    it('never pays less than the ungraced curve for the same answer', () => {
      for (let at = 0; at <= 15_000; at += 500) {
        expect(speedBonus(START + at, START, END, 100, GRACE)).toBeGreaterThanOrEqual(
          speedBonus(START + at, START, END, 100),
        );
      }
    });

    it('survives a grace window longer than the round itself', () => {
      expect(speedBonus(START + 10_000, START, END, 100, 60_000)).toBe(100);
    });
  });
});

describe('scoreRound', () => {
  const raw: RoundScore[] = [{ playerId: 'a', points: 180, isCorrect: true, msTaken: 2_000 }];

  it('passes points through at weight 1', () => {
    expect(scoreRound(raw, 1)[0]!.points).toBe(180);
  });

  it('doubles points on the سؤال الحسم round', () => {
    expect(scoreRound(raw, 2)[0]!.points).toBe(360);
  });

  it('clamps a round type that tries to exceed the ceiling', () => {
    const cheat: RoundScore[] = [{ playerId: 'a', points: 5_000, isCorrect: true, msTaken: 1 }];
    expect(scoreRound(cheat, 1)[0]!.points).toBe(200);
  });

  it('preserves negative points from risk-based types', () => {
    const penalty: RoundScore[] = [{ playerId: 'a', points: -60, isCorrect: false, msTaken: 900 }];
    expect(scoreRound(penalty, 1)[0]!.points).toBe(-60);
  });
});

describe('accumulate', () => {
  it('folds a round into running totals', () => {
    const totals = emptyTotals(['a', 'b']);
    const next = accumulate(
      totals,
      [
        { playerId: 'a', points: 150, isCorrect: true, msTaken: 3_000 },
        { playerId: 'b', points: 0, isCorrect: false, msTaken: null },
      ],
      15_000,
    );
    expect(next).toEqual([
      { playerId: 'a', total: 150, correctCount: 1, totalMs: 3_000 },
      // Charged the whole round, not zero — see the no-answer test below.
      { playerId: 'b', total: 0, correctCount: 0, totalMs: 15_000 },
    ]);
  });

  it('leaves a player absent from the round untouched', () => {
    const totals = [{ playerId: 'a', total: 90, correctCount: 1, totalMs: 500 }];
    expect(accumulate(totals, [], 15_000)).toEqual(totals);
  });

  /**
   * Caught in a real match: two players finished 0–0 and the one who never touched the screen
   * was crowned, because an unanswered round used to contribute 0ms and `totalMs` breaks ties
   * ascending. Doing nothing must never be the fastest way to play.
   */
  it('charges a no-answer the full round rather than rewarding it', () => {
    const totals = emptyTotals(['tried', 'afk']);
    const next = accumulate(
      totals,
      [
        { playerId: 'tried', points: 0, isCorrect: false, msTaken: 4_000 },
        { playerId: 'afk', points: 0, isCorrect: false, msTaken: null },
      ],
      15_000,
    );

    const standings = rankPlayers(next);
    expect(standings[0]!.playerId).toBe('tried');
    expect(standings[1]!.playerId).toBe('afk');
  });

  it('keeps players level when a round tracks no times at all', () => {
    // Shapes like poll have no notion of speed, so every player reports null. Charging them all
    // the same amount must leave the tie-break exactly where it was.
    const totals = emptyTotals(['a', 'b']);
    const next = accumulate(
      totals,
      [
        { playerId: 'a', points: 100, isCorrect: true, msTaken: null },
        { playerId: 'b', points: 100, isCorrect: true, msTaken: null },
      ],
      20_000,
    );
    expect(next[0]!.totalMs).toBe(next[1]!.totalMs);
    expect(rankPlayers(next).map((s) => s.rank)).toEqual([1, 1]);
  });
});

describe('rankPlayers', () => {
  it('ranks by total descending', () => {
    const standings = rankPlayers([
      { playerId: 'a', total: 100, correctCount: 1, totalMs: 100 },
      { playerId: 'b', total: 300, correctCount: 2, totalMs: 100 },
    ]);
    expect(standings.map((s) => s.playerId)).toEqual(['b', 'a']);
    expect(standings.map((s) => s.rank)).toEqual([1, 2]);
  });

  it('breaks an equal total by correct count, then by speed', () => {
    const standings = rankPlayers([
      { playerId: 'slow', total: 200, correctCount: 2, totalMs: 9_000 },
      { playerId: 'fast', total: 200, correctCount: 2, totalMs: 3_000 },
      { playerId: 'lucky', total: 200, correctCount: 1, totalMs: 1_000 },
    ]);
    expect(standings.map((s) => s.playerId)).toEqual(['fast', 'slow', 'lucky']);
  });

  it('shares a rank when players are equal on every criterion, and skips the next rank', () => {
    const standings = rankPlayers([
      { playerId: 'a', total: 200, correctCount: 2, totalMs: 1_000 },
      { playerId: 'b', total: 200, correctCount: 2, totalMs: 1_000 },
      { playerId: 'c', total: 50, correctCount: 0, totalMs: 4_000 },
    ]);
    expect(standings.map((s) => s.rank)).toEqual([1, 1, 3]);
  });

  it('reports rank movement against the previous round', () => {
    const previous = new Map([
      ['a', 3],
      ['b', 1],
    ]);
    const standings = rankPlayers(
      [
        { playerId: 'a', total: 400, correctCount: 3, totalMs: 100 },
        { playerId: 'b', total: 100, correctCount: 1, totalMs: 100 },
      ],
      previous,
    );
    expect(standings.find((s) => s.playerId === 'a')!.rankDelta).toBe(2);
    expect(standings.find((s) => s.playerId === 'b')!.rankDelta).toBe(-1);
  });

  it('reports no movement on the first round', () => {
    const standings = rankPlayers([{ playerId: 'a', total: 0, correctCount: 0, totalMs: 0 }]);
    expect(standings[0]!.rankDelta).toBeNull();
  });
});

describe('detectTie', () => {
  it('fires for a tie at the top', () => {
    const standings = rankPlayers([
      { playerId: 'a', total: 200, correctCount: 2, totalMs: 1_000 },
      { playerId: 'b', total: 200, correctCount: 2, totalMs: 1_000 },
    ]);
    expect(detectTie(standings)).toEqual(['a', 'b']);
  });

  it('ignores a tie below first place', () => {
    const standings = rankPlayers([
      { playerId: 'winner', total: 500, correctCount: 4, totalMs: 900 },
      { playerId: 'a', total: 200, correctCount: 2, totalMs: 1_000 },
      { playerId: 'b', total: 200, correctCount: 2, totalMs: 1_000 },
    ]);
    expect(detectTie(standings)).toBeNull();
  });

  it('returns null when there is a clear winner', () => {
    const standings = rankPlayers([
      { playerId: 'a', total: 300, correctCount: 3, totalMs: 500 },
      { playerId: 'b', total: 100, correctCount: 1, totalMs: 500 },
    ]);
    expect(detectTie(standings)).toBeNull();
  });
});

describe('rankTeams', () => {
  const membership = new Map([
    ['a1', 'team-a'],
    ['a2', 'team-a'],
    ['a3', 'team-a'],
    ['b1', 'team-b'],
    ['b2', 'team-b'],
  ]);
  const teamIds = ['team-a', 'team-b'];

  const totals = (scores: Record<string, number>) =>
    Object.entries(scores).map(([playerId, total]) => ({
      playerId,
      total,
      correctCount: 0,
      totalMs: 0,
    }));

  it('ranks by the average, not the sum', () => {
    // Team A has three players and more points in total; team B played better per head and
    // should win. Summing would let the host decide the match by picking team sizes.
    const standings = rankTeams(
      totals({ a1: 100, a2: 100, a3: 100, b1: 200, b2: 200 }),
      membership,
      teamIds,
    );
    expect(standings[0]!.teamId).toBe('team-b');
    expect(standings[0]!.total).toBe(200);
    expect(standings[1]!.total).toBe(100);
  });

  it('is unaffected by uneven team sizes when play is equal', () => {
    const standings = rankTeams(
      totals({ a1: 150, a2: 150, a3: 150, b1: 150, b2: 150 }),
      membership,
      teamIds,
    );
    expect(standings[0]!.total).toBe(standings[1]!.total);
    expect(standings.every((s) => s.rank === 1)).toBe(true);
  });

  it('lists the members of each team', () => {
    const standings = rankTeams(totals({ a1: 10, b1: 20 }), membership, teamIds);
    expect(standings.find((s) => s.teamId === 'team-a')!.memberIds).toEqual(['a1']);
  });

  it('scores an empty team zero rather than dividing by zero', () => {
    const standings = rankTeams(totals({ a1: 100 }), membership, teamIds);
    expect(standings.find((s) => s.teamId === 'team-b')!.total).toBe(0);
  });
});
