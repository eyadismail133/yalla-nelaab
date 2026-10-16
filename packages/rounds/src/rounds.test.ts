import { describe, expect, it } from 'vitest';
import type { ContentItem, PlayerRef, RoundScore } from '@game/shared';
import { fillBlank } from './fill-blank.js';
import { mcqRace } from './mcq-race.js';
import { numericGuess } from './numeric-guess.js';
import { QUICKFIRE_ITEMS, quickfireTf } from './quickfire-tf.js';
import { START_MS, makePlayers } from './test-drivers.js';

const points = (scores: RoundScore[], playerId: string) =>
  scores.find((s) => s.playerId === playerId)!.points;

const init = (players: PlayerRef[], durationMs: number) => ({
  players,
  startedAtMs: START_MS,
  endsAtMs: START_MS + durationMs,
});

describe('سباق الإجابات (mcq_race)', () => {
  const content: ContentItem[] = [
    {
      id: 'q1',
      categoryId: 'football',
      difficulty: 2,
      shape: 'mcq',
      textAr: 'مين خد الكرة الذهبية سنة 2022؟',
      options: ['ميسي', 'بنزيما', 'رونالدو', 'مبابي'],
      correctIndex: 1,
    },
  ];

  const play = (answers: Array<{ id: string; choice: number; atMs: number }>) => {
    const players = makePlayers(3);
    let state = mcqRace.createState(content, init(players, mcqRace.durationMs));
    for (const a of answers) {
      state = mcqRace.reduce(state, { kind: 'answer', choice: a.choice }, {
        playerId: a.id,
        nowMs: a.atMs,
      }).state;
    }
    if (!mcqRace.isFinished(state)) {
      state = mcqRace.onDeadline(state, { nowMs: START_MS + mcqRace.durationMs }).state;
    }
    return mcqRace.roundScores(state);
  };

  it('gives a faster correct answer more points than a slower one', () => {
    const scores = play([
      { id: 'p1', choice: 1, atMs: START_MS + 1_000 },
      { id: 'p2', choice: 1, atMs: START_MS + 10_000 },
    ]);
    expect(points(scores, 'p1')).toBeGreaterThan(points(scores, 'p2'));
  });

  it('still awards the full base score to a correct answer at the buzzer', () => {
    // The core fairness property: knowing the answer is worth more than reacting fast.
    const scores = play([{ id: 'p1', choice: 1, atMs: START_MS + mcqRace.durationMs }]);
    expect(points(scores, 'p1')).toBe(120);
  });

  it('does not charge a player for the time it takes to read the question', () => {
    // Without the grace window the maximum was only reachable by answering before anybody
    // could have read four Arabic options, so the round paid for guessing fast.
    const scores = play([
      { id: 'p1', choice: 1, atMs: START_MS + 200 },
      { id: 'p2', choice: 1, atMs: START_MS + 3_000 },
    ]);
    expect(points(scores, 'p1')).toBe(200);
    expect(points(scores, 'p2')).toBe(200);
  });

  it('keeps two correct answers closer together than a correct one is to a wrong one', () => {
    // 120 + 80 rather than 100 + 100: two people who both knew it must never finish a whole
    // base score apart on thumb speed alone.
    const scores = play([
      { id: 'p1', choice: 1, atMs: START_MS },
      { id: 'p2', choice: 1, atMs: START_MS + mcqRace.durationMs },
      { id: 'p3', choice: 0, atMs: START_MS },
    ]);
    const betweenCorrect = points(scores, 'p1') - points(scores, 'p2');
    expect(betweenCorrect).toBeLessThan(points(scores, 'p2') - points(scores, 'p3'));
  });

  it('scores a fast wrong answer below a slow correct one', () => {
    const scores = play([
      { id: 'p1', choice: 3, atMs: START_MS },
      { id: 'p2', choice: 1, atMs: START_MS + 14_000 },
    ]);
    expect(points(scores, 'p1')).toBe(0);
    expect(points(scores, 'p2')).toBeGreaterThan(0);
  });

  it('keeps the first answer when a player tries to change it', () => {
    const scores = play([
      { id: 'p1', choice: 3, atMs: START_MS + 500 },
      { id: 'p1', choice: 1, atMs: START_MS + 600 },
    ]);
    expect(points(scores, 'p1')).toBe(0);
  });

  it('rejects an out-of-range choice', () => {
    const players = makePlayers(2);
    const state = mcqRace.createState(content, init(players, mcqRace.durationMs));
    const after = mcqRace.reduce(state, { kind: 'answer', choice: 9 }, {
      playerId: 'p1',
      nowMs: START_MS + 100,
    }).state;
    expect(after.answers).toEqual({});
  });

  it('closes the round as soon as everyone has answered', () => {
    const players = makePlayers(2);
    let state = mcqRace.createState(content, init(players, mcqRace.durationMs));
    state = mcqRace.reduce(state, { kind: 'answer', choice: 1 }, { playerId: 'p1', nowMs: START_MS }).state;
    expect(mcqRace.isFinished(state)).toBe(false);
    state = mcqRace.reduce(state, { kind: 'answer', choice: 0 }, { playerId: 'p2', nowMs: START_MS }).state;
    expect(mcqRace.isFinished(state)).toBe(true);
  });
});

describe('خمّن التاريخ (numeric_guess)', () => {
  const content: ContentItem[] = [
    {
      id: 'q1',
      categoryId: 'history',
      difficulty: 3,
      shape: 'numeric',
      textAr: 'سنة كام اتفتحت قناة السويس؟',
      correctValue: 1869,
      tolerance: 2,
    },
  ];

  const play = (guesses: Array<{ id: string; value: number }>, playerCount = 3) => {
    const players = makePlayers(playerCount);
    let state = numericGuess.createState(content, init(players, numericGuess.durationMs));
    for (const [i, g] of guesses.entries()) {
      state = numericGuess.reduce(state, { kind: 'guess', value: g.value }, {
        playerId: g.id,
        nowMs: START_MS + i * 100,
      }).state;
    }
    if (!numericGuess.isFinished(state)) {
      state = numericGuess.onDeadline(state, { nowMs: START_MS + numericGuess.durationMs }).state;
    }
    return numericGuess.roundScores(state);
  };

  it('awards the bullseye inside the tolerance band', () => {
    const scores = play([{ id: 'p1', value: 1870 }]);
    expect(points(scores, 'p1')).toBe(200);
  });

  it('ranks misses by proximity, not by who typed first', () => {
    const scores = play([
      { id: 'p1', value: 1900 },
      { id: 'p2', value: 1875 },
      { id: 'p3', value: 1500 },
    ]);
    expect(points(scores, 'p2')).toBe(150);
    expect(points(scores, 'p1')).toBe(110);
    expect(points(scores, 'p3')).toBe(80);
  });

  it('gives equally-distant guesses the same points', () => {
    // Guessing 4 low and 4 high are equally good; splitting them by typing speed would
    // contradict this round being about accuracy rather than reflexes.
    const scores = play([
      { id: 'p1', value: 1865 },
      { id: 'p2', value: 1873 },
    ]);
    expect(points(scores, 'p1')).toBe(points(scores, 'p2'));
  });

  it('scores nothing for a player who never guessed', () => {
    const scores = play([{ id: 'p1', value: 1869 }]);
    expect(points(scores, 'p3')).toBe(0);
    expect(scores.find((s) => s.playerId === 'p3')!.msTaken).toBeNull();
  });

  it('does not reward a wild guess beyond the ladder', () => {
    const scores = play(
      [
        { id: 'p1', value: 1869 },
        { id: 'p2', value: 1870 },
        { id: 'p3', value: 3000 },
      ],
      3,
    );
    expect(points(scores, 'p3')).toBe(150);
  });
});

describe('صح ولا غلط (quickfire_tf)', () => {
  const content: ContentItem[] = Array.from({ length: QUICKFIRE_ITEMS }, (_, i) => ({
    id: `s${i}`,
    categoryId: 'general',
    difficulty: 2,
    shape: 'boolean' as const,
    textAr: `عبارة ${i}`,
    isTrue: i % 2 === 0,
  }));

  const playSequence = (playerId: string, values: boolean[]) => {
    const players = makePlayers(2);
    let state = quickfireTf.createState(content, init(players, quickfireTf.durationMs));
    for (const [i, value] of values.entries()) {
      state = quickfireTf.reduce(state, { kind: 'judge', index: i, value }, {
        playerId,
        nowMs: START_MS + i * 500,
      }).state;
    }
    state = quickfireTf.onDeadline(state, { nowMs: START_MS + quickfireTf.durationMs }).state;
    return quickfireTf.roundScores(state);
  };

  it('scores a clean sweep at the ceiling', () => {
    const scores = playSequence('p1', [true, false, true, false, true]);
    expect(points(scores, 'p1')).toBe(200);
    expect(scores.find((s) => s.playerId === 'p1')!.isCorrect).toBe(true);
  });

  it('subtracts for a wrong judgement', () => {
    // Four right and one wrong is 160 − 20, not 160. The penalty is what makes the round a
    // risk decision rather than a reflex test.
    const scores = playSequence('p1', [true, false, true, false, false]);
    expect(points(scores, 'p1')).toBe(140);
  });

  it('can drive a reckless player negative', () => {
    const scores = playSequence('p1', [false, true, false, true, false]);
    expect(points(scores, 'p1')).toBe(-100);
  });

  it('scores only what a player got through when the clock beat them', () => {
    const scores = playSequence('p1', [true, false]);
    expect(points(scores, 'p1')).toBe(80);
    expect(scores.find((s) => s.playerId === 'p1')!.isCorrect).toBe(false);
  });

  it('refuses to let a player skip ahead to a statement they have not been shown', () => {
    const players = makePlayers(2);
    const state = quickfireTf.createState(content, init(players, quickfireTf.durationMs));
    const after = quickfireTf.reduce(state, { kind: 'judge', index: 3, value: true }, {
      playerId: 'p1',
      nowMs: START_MS + 100,
    }).state;
    expect(after.cursor['p1']).toBe(0);
  });

  it('lets players progress independently rather than in lockstep', () => {
    const players = makePlayers(2);
    let state = quickfireTf.createState(content, init(players, quickfireTf.durationMs));
    for (let i = 0; i < 3; i += 1) {
      state = quickfireTf.reduce(state, { kind: 'judge', index: i, value: true }, {
        playerId: 'p1',
        nowMs: START_MS + i * 100,
      }).state;
    }
    expect(state.cursor['p1']).toBe(3);
    expect(state.cursor['p2']).toBe(0);
  });

  it('shows a player only their current statement', () => {
    const players = makePlayers(2);
    const state = quickfireTf.createState(content, init(players, quickfireTf.durationMs));
    const view = quickfireTf.view(state, 'p1') as { current: { index: number; textAr: string } };
    expect(view.current.index).toBe(0);
    expect(JSON.stringify(view)).not.toContain('عبارة 4');
  });
});

describe('الكلمة الناقصة (fill_blank)', () => {
  const content: ContentItem[] = [
    {
      id: 'q1',
      categoryId: 'proverbs',
      difficulty: 2,
      shape: 'fill_blank',
      textAr: 'القرد في عين أمه ____',
      answerAr: 'غزال',
      aliases: ['غزالة'],
    },
  ];

  const play = (submissions: Array<{ id: string; text: string; atMs: number }>) => {
    const players = makePlayers(3);
    let state = fillBlank.createState(content, init(players, fillBlank.durationMs));
    for (const s of submissions) {
      state = fillBlank.reduce(state, { kind: 'submit', text: s.text }, {
        playerId: s.id,
        nowMs: s.atMs,
      }).state;
    }
    if (!fillBlank.isFinished(state)) {
      state = fillBlank.onDeadline(state, { nowMs: START_MS + fillBlank.durationMs }).state;
    }
    return { scores: fillBlank.roundScores(state), state };
  };

  it('pays both solvers the same when the gap between them is imperceptible', () => {
    // The old rule handed 50 points to whoever landed first, which in a room of eight told
    // seven people they were too slow over a gap nobody in the room could feel.
    const { scores } = play([
      { id: 'p1', text: 'غزال', atMs: START_MS + 1_000 },
      { id: 'p2', text: 'غزال', atMs: START_MS + 5_000 },
    ]);
    expect(points(scores, 'p1')).toBe(200);
    expect(points(scores, 'p2')).toBe(200);
  });

  it('still pays a genuinely quicker recall more than a slow one', () => {
    const { scores } = play([
      { id: 'p1', text: 'غزال', atMs: START_MS + 1_000 },
      { id: 'p2', text: 'غزال', atMs: START_MS + 20_000 },
    ]);
    expect(points(scores, 'p1')).toBeGreaterThan(points(scores, 'p2'));
    expect(points(scores, 'p2')).toBeGreaterThanOrEqual(150);
  });

  it('accepts a declared alias', () => {
    const { scores } = play([{ id: 'p1', text: 'غزالة', atMs: START_MS + 1_000 }]);
    expect(points(scores, 'p1')).toBe(200);
  });

  it('accepts an answer spelled without the usual hamza or ta-marbuta', () => {
    const { scores } = play([{ id: 'p1', text: ' غزاله ', atMs: START_MS + 1_000 }]);
    expect(points(scores, 'p1')).toBe(200);
  });

  it('lets a player recover from a typo within three attempts', () => {
    const { scores } = play([
      { id: 'p1', text: 'حمار', atMs: START_MS + 500 },
      { id: 'p1', text: 'غزال', atMs: START_MS + 1_500 },
    ]);
    expect(points(scores, 'p1')).toBe(200);
  });

  it('locks a player out after three wrong attempts', () => {
    const { scores, state } = play([
      { id: 'p1', text: 'أ', atMs: START_MS + 100 },
      { id: 'p1', text: 'ب', atMs: START_MS + 200 },
      { id: 'p1', text: 'ج', atMs: START_MS + 300 },
      { id: 'p1', text: 'غزال', atMs: START_MS + 400 },
    ]);
    expect(state.attempts['p1']).toHaveLength(3);
    expect(points(scores, 'p1')).toBe(0);
  });

  it('ignores an empty submission without consuming an attempt', () => {
    const { state } = play([{ id: 'p1', text: '   ', atMs: START_MS + 100 }]);
    expect(state.attempts['p1']).toHaveLength(0);
  });

  it('tells a player how many others have solved it but not who', () => {
    const players = makePlayers(3);
    let state = fillBlank.createState(content, init(players, fillBlank.durationMs));
    state = fillBlank.reduce(state, { kind: 'submit', text: 'غزال' }, {
      playerId: 'p1',
      nowMs: START_MS + 100,
    }).state;
    const view = fillBlank.view(state, 'p2') as { solvedCount: number };
    expect(view.solvedCount).toBe(1);
    expect(JSON.stringify(view)).not.toContain('p1');
  });
});
