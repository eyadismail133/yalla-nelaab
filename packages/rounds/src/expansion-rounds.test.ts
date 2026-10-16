import { describe, expect, it } from 'vitest';
import type { ContentItem, PlayerRef, RoundScore } from '@game/shared';
import { whoAmI } from './who-am-i.js';
import { ordering } from './ordering.js';
import { steal } from './steal.js';
import { bidding } from './bidding.js';
import { landGrab } from './land-grab.js';
import { describeIt } from './describe-it.js';
import { START_MS, makePlayers } from './test-drivers.js';

const points = (scores: RoundScore[], playerId: string) =>
  scores.find((s) => s.playerId === playerId)!.points;

const init = (players: PlayerRef[], durationMs: number) => ({
  players,
  startedAtMs: START_MS,
  endsAtMs: START_MS + durationMs,
});

describe('مين أنا؟ (who_am_i)', () => {
  const content: ContentItem[] = [
    {
      id: 'q1',
      categoryId: 'general',
      difficulty: 2,
      shape: 'progressive',
      hints: ['أنا حيوان', 'بعيش في الصحرا', 'بيقولوا عليا سفينة الصحرا'],
      answerAr: 'الجمل',
      aliases: ['جمل'],
    },
  ];

  const fresh = () => whoAmI.createState(content, init(makePlayers(3), whoAmI.durationMs));

  it('pays the ceiling for guessing on the first clue alone', () => {
    const state = whoAmI.reduce(fresh(), { kind: 'guess', text: 'الجمل' }, {
      playerId: 'p1',
      nowMs: START_MS + 500,
    }).state;
    expect(points(whoAmI.roundScores(state), 'p1')).toBe(200);
  });

  it('pays less once more clues have landed', () => {
    // The entire decision the round asks for: commit early and cheap, or wait and be sure.
    let state = fresh();
    state = whoAmI.onDeadline(state, { nowMs: START_MS + 9_000 }).state;
    state = whoAmI.onDeadline(state, { nowMs: START_MS + 18_000 }).state;
    expect(state.revealed).toBe(3);

    state = whoAmI.reduce(state, { kind: 'guess', text: 'الجمل' }, {
      playerId: 'p1',
      nowMs: START_MS + 19_000,
    }).state;
    expect(points(whoAmI.roundScores(state), 'p1')).toBe(100);
  });

  it('locks the score at the moment of the correct guess', () => {
    let state = whoAmI.reduce(fresh(), { kind: 'guess', text: 'الجمل' }, {
      playerId: 'p1',
      nowMs: START_MS + 500,
    }).state;
    // Later clues must not devalue a guess already banked.
    state = whoAmI.onDeadline(state, { nowMs: START_MS + 9_000 }).state;
    expect(points(whoAmI.roundScores(state), 'p1')).toBe(200);
  });

  it('only shows the clues released so far', () => {
    const view = whoAmI.view(fresh(), 'p1') as { hints: string[] };
    expect(view.hints).toEqual(['أنا حيوان']);
    expect(JSON.stringify(view)).not.toContain('سفينة الصحرا');
  });

  it('reveals one more clue on each deadline', () => {
    let state = fresh();
    // Nine seconds apart, not six: a clue needs to sit long enough for the room to argue
    // about it before the next one moves the ladder.
    expect(whoAmI.nextDeadline(state)).toBe(START_MS + 9_000);
    state = whoAmI.onDeadline(state, { nowMs: START_MS + 9_000 }).state;
    expect(state.revealed).toBe(2);
    expect(whoAmI.nextDeadline(state)).toBe(START_MS + 18_000);
    expect(whoAmI.isFinished(state)).toBe(false);
  });

  it('ends the round once the clues run out', () => {
    let state = fresh();
    for (let i = 0; i < 5; i += 1) {
      state = whoAmI.onDeadline(state, { nowMs: START_MS + whoAmI.durationMs }).state;
    }
    expect(whoAmI.isFinished(state)).toBe(true);
  });

  it('spends an attempt on a wrong guess but lets the player recover', () => {
    let state = whoAmI.reduce(fresh(), { kind: 'guess', text: 'الحصان' }, {
      playerId: 'p1',
      nowMs: START_MS + 500,
    }).state;
    expect(state.attempts['p1']).toHaveLength(1);

    state = whoAmI.reduce(state, { kind: 'guess', text: 'الجمل' }, {
      playerId: 'p1',
      nowMs: START_MS + 900,
    }).state;
    expect(points(whoAmI.roundScores(state), 'p1')).toBe(200);
  });

  it('locks a player out after two wrong guesses', () => {
    let state = fresh();
    for (const text of ['الحصان', 'الأسد', 'الجمل']) {
      state = whoAmI.reduce(state, { kind: 'guess', text }, { playerId: 'p1', nowMs: START_MS + 500 }).state;
    }
    expect(points(whoAmI.roundScores(state), 'p1')).toBe(0);
  });
});

describe('رتّب صح (ordering)', () => {
  const content: ContentItem[] = [
    {
      id: 'q1',
      categoryId: 'history',
      difficulty: 3,
      shape: 'ordering',
      textAr: 'رتّبهم من الأقدم للأحدث',
      items: ['ثورة يوليو', 'النكسة', 'حرب أكتوبر', 'كامب ديفيد'],
      labels: [],
    },
  ];

  const fresh = () => ordering.createState(content, init(makePlayers(3), ordering.durationMs));

  /** Taps the tiles that spell out `sequence`, whatever order the board shuffled into. */
  function play(sequence: string[], playerId = 'p1') {
    let state = fresh();
    for (const label of sequence) {
      state = ordering.reduce(state, { kind: 'place', index: state.shuffled.indexOf(label) }, {
        playerId,
        nowMs: START_MS + 1_000,
      }).state;
    }
    if (!ordering.isFinished(state)) {
      state = ordering.onDeadline(state, { nowMs: START_MS + ordering.durationMs }).state;
    }
    return state;
  }

  it('pays the ceiling for a perfect sequence', () => {
    const state = play(['ثورة يوليو', 'النكسة', 'حرب أكتوبر', 'كامب ديفيد']);
    expect(points(ordering.roundScores(state), 'p1')).toBe(200);
  });

  it('pays for each item that landed in the right place', () => {
    // Partial credit is what makes this round different: you assemble what you know instead of
    // knowing the whole answer or nothing.
    const state = play(['ثورة يوليو', 'النكسة', 'كامب ديفيد', 'حرب أكتوبر']);
    expect(points(ordering.roundScores(state), 'p1')).toBe(100);
  });

  it('pays nothing for a completely reversed sequence', () => {
    const state = play(['كامب ديفيد', 'حرب أكتوبر', 'النكسة', 'ثورة يوليو']);
    expect(points(ordering.roundScores(state), 'p1')).toBe(0);
  });

  it('shuffles the board so the stored order is not the answer key on screen', () => {
    const state = fresh();
    expect(state.shuffled).not.toEqual(state.item.items);
    expect([...state.shuffled].sort()).toEqual([...state.item.items].sort());
  });

  it('lets a player take back a tile', () => {
    let state = fresh();
    state = ordering.reduce(state, { kind: 'place', index: 0 }, { playerId: 'p1', nowMs: START_MS }).state;
    state = ordering.reduce(state, { kind: 'undo' }, { playerId: 'p1', nowMs: START_MS }).state;
    expect(state.arrangements['p1']).toEqual([]);
  });

  it('refuses to place the same tile twice', () => {
    let state = fresh();
    state = ordering.reduce(state, { kind: 'place', index: 0 }, { playerId: 'p1', nowMs: START_MS }).state;
    state = ordering.reduce(state, { kind: 'place', index: 0 }, { playerId: 'p1', nowMs: START_MS }).state;
    expect(state.arrangements['p1']).toEqual([0]);
  });

  it('locks automatically once every tile is placed', () => {
    let state = fresh();
    for (let i = 0; i < 4; i += 1) {
      state = ordering.reduce(state, { kind: 'place', index: i }, { playerId: 'p1', nowMs: START_MS }).state;
    }
    expect(state.lockedAtMs['p1']).toBeDefined();
  });

  it('scores a partial arrangement left when the clock ran out', () => {
    let state = fresh();
    const first = state.shuffled.indexOf('ثورة يوليو');
    state = ordering.reduce(state, { kind: 'place', index: first }, { playerId: 'p1', nowMs: START_MS }).state;
    state = ordering.onDeadline(state, { nowMs: START_MS + ordering.durationMs }).state;
    expect(points(ordering.roundScores(state), 'p1')).toBe(50);
  });
});

describe('السرقة (steal)', () => {
  const content: ContentItem[] = [
    {
      id: 'q1',
      categoryId: 'football',
      difficulty: 2,
      shape: 'mcq',
      textAr: 'مين كسب كأس العالم 2022؟',
      options: ['فرنسا', 'البرازيل', 'الأرجنتين', 'ألمانيا'],
      correctIndex: 2,
    },
  ];

  function answered(choices: Record<string, number>) {
    let state = steal.createState(content, init(makePlayers(3), steal.durationMs));
    for (const [playerId, choice] of Object.entries(choices)) {
      state = steal.reduce(state, { kind: 'answer', choice }, { playerId, nowMs: START_MS + 1_000 }).state;
    }
    if (state.stage === 'answering') {
      state = steal.onDeadline(state, { nowMs: START_MS + 15_000 }).state;
    }
    return state;
  }

  it('pays a plain correct answer', () => {
    const state = answered({ p1: 2, p2: 2, p3: 2 });
    const closed = steal.onDeadline(state, { nowMs: START_MS + steal.durationMs }).state;
    expect(points(steal.roundScores(closed), 'p1')).toBe(120);
  });

  it('pays the ceiling for robbing somebody who got it wrong', () => {
    let state = answered({ p1: 2, p2: 0, p3: 0 });
    state = steal.reduce(state, { kind: 'steal', targetId: 'p2' }, { playerId: 'p1', nowMs: START_MS + 5_000 }).state;
    expect(points(steal.roundScores(state), 'p1')).toBe(200);
  });

  it('takes points off the victim', () => {
    let state = answered({ p1: 2, p2: 0, p3: 0 });
    state = steal.reduce(state, { kind: 'steal', targetId: 'p2' }, { playerId: 'p1', nowMs: START_MS + 5_000 }).state;
    expect(points(steal.roundScores(state), 'p2')).toBe(-40);
  });

  it('punishes a thief who picked somebody that was right', () => {
    // The gamble: you cannot see who slipped up, so a bad read costs you.
    let state = answered({ p1: 2, p2: 2, p3: 0 });
    state = steal.reduce(state, { kind: 'steal', targetId: 'p2' }, { playerId: 'p1', nowMs: START_MS + 5_000 }).state;
    expect(points(steal.roundScores(state), 'p1')).toBe(80);
    expect(points(steal.roundScores(state), 'p2')).toBe(120);
  });

  it('refuses to let a wrong answerer steal', () => {
    let state = answered({ p1: 0, p2: 2, p3: 0 });
    state = steal.reduce(state, { kind: 'steal', targetId: 'p2' }, { playerId: 'p1', nowMs: START_MS + 5_000 }).state;
    expect(state.steals['p1']).toBeUndefined();
  });

  it('never tells a player how anybody else answered', () => {
    const state = answered({ p1: 2, p2: 0, p3: 0 });
    const view = JSON.stringify(steal.view(state, 'p1'));
    expect(view).not.toContain('correctIndex');
    expect(view).not.toContain('answers');
    // Knowing you were right is necessary — it is what unlocks stealing.
    expect(view).toContain('iWasCorrect');
  });

  it('ends the stage once everyone who could act has passed', () => {
    let state = answered({ p1: 2, p2: 2, p3: 0 });
    state = steal.reduce(state, { kind: 'pass' }, { playerId: 'p1', nowMs: START_MS + 5_000 }).state;
    expect(steal.isFinished(state)).toBe(false);
    state = steal.reduce(state, { kind: 'pass' }, { playerId: 'p2', nowMs: START_MS + 5_100 }).state;
    expect(steal.isFinished(state)).toBe(true);
  });

  it('skips the stealing stage entirely when nobody was right', () => {
    const state = answered({ p1: 0, p2: 1, p3: 3 });
    expect(steal.isFinished(state)).toBe(true);
  });
});

describe('المزايدة (bidding)', () => {
  const content: ContentItem[] = Array.from({ length: 4 }, (_, i) => ({
    id: `q${i}`,
    categoryId: 'general',
    difficulty: 2,
    shape: 'mcq' as const,
    textAr: `سؤال ${i}`,
    options: ['أ', 'ب', 'ج', 'د'],
    correctIndex: i % 4,
  }));

  function play(bid: number, correctCount: number, playerId = 'p1') {
    let state = bidding.createState(content, init(makePlayers(2), bidding.durationMs));
    for (const id of ['p1', 'p2']) {
      state = bidding.reduce(state, { kind: 'bid', amount: id === playerId ? bid : 1 }, {
        id: '',
        playerId: id,
        nowMs: START_MS + 1_000,
      } as never).state;
    }
    for (let i = 0; i < 4; i += 1) {
      const choice = i < correctCount ? i % 4 : (i + 1) % 4;
      state = bidding.reduce(state, { kind: 'answer', index: i, choice }, {
        playerId,
        nowMs: START_MS + 14_000 + i,
      }).state;
    }
    if (!bidding.isFinished(state)) {
      state = bidding.onDeadline(state, { nowMs: START_MS + bidding.durationMs }).state;
    }
    return state;
  }

  it('pays the bid when the player delivers it', () => {
    expect(points(bidding.roundScores(play(3, 3)), 'p1')).toBe(150);
  });

  it('pays the ceiling for a maximum bid delivered in full', () => {
    expect(points(bidding.roundScores(play(4, 4)), 'p1')).toBe(200);
  });

  it('pays nothing for missing the bid by one', () => {
    // All-or-nothing is the point: a safe small bid beats a greedy one you cannot make.
    expect(points(bidding.roundScores(play(4, 3)), 'p1')).toBe(0);
  });

  it('pays the bid, not the performance, when a player overdelivers', () => {
    expect(points(bidding.roundScores(play(2, 4)), 'p1')).toBe(100);
  });

  it('rejects a bid outside the allowed range', () => {
    let state = bidding.createState(content, init(makePlayers(2), bidding.durationMs));
    state = bidding.reduce(state, { kind: 'bid', amount: 9 }, { playerId: 'p1', nowMs: START_MS }).state;
    expect(state.bids['p1']).toBeUndefined();
  });

  it('hides the questions while bidding is open', () => {
    const state = bidding.createState(content, init(makePlayers(2), bidding.durationMs));
    const view = JSON.stringify(bidding.view(state, 'p1'));
    expect(view).not.toContain('سؤال 0');
    expect(view).not.toContain('correctIndex');
  });

  it('shows one question at a time once answering starts', () => {
    let state = bidding.createState(content, init(makePlayers(2), bidding.durationMs));
    for (const id of ['p1', 'p2']) {
      state = bidding.reduce(state, { kind: 'bid', amount: 2 }, { playerId: id, nowMs: START_MS }).state;
    }
    const view = JSON.stringify(bidding.view(state, 'p1'));
    expect(view).toContain('سؤال 0');
    expect(view).not.toContain('سؤال 3');
  });
});

describe('قطع الأرض (land_grab)', () => {
  const content: ContentItem[] = Array.from({ length: 9 }, (_, i) => ({
    id: `q${i}`,
    categoryId: 'general',
    difficulty: 2,
    shape: 'mcq' as const,
    textAr: `مربع ${i}`,
    options: ['أ', 'ب', 'ج', 'د'],
    correctIndex: i % 4,
  }));

  const fresh = () => landGrab.createState(content, init(makePlayers(3), landGrab.durationMs));

  function claim(state: ReturnType<typeof fresh>, playerId: string, cells: number[]) {
    let next = state;
    for (const cell of cells) {
      next = landGrab.reduce(next, { kind: 'open', cell }, { playerId, nowMs: START_MS + 1_000 }).state;
      next = landGrab.reduce(next, { kind: 'answer', cell, choice: cell % 4 }, {
        playerId,
        nowMs: START_MS + 1_100,
      }).state;
    }
    return next;
  }

  it('pays the ceiling for taking the whole board', () => {
    const state = claim(fresh(), 'p1', [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(points(landGrab.roundScores(state), 'p1')).toBe(200);
  });

  it('pays territory in proportion to squares held', () => {
    const state = claim(fresh(), 'p1', [0, 1]);
    // Two of nine squares, no line yet.
    expect(points(landGrab.roundScores(state), 'p1')).toBe(40);
  });

  it('adds a bonus for completing a line', () => {
    const withLine = claim(fresh(), 'p1', [0, 1, 2]);
    const withoutLine = claim(fresh(), 'p1', [0, 1, 3]);
    expect(points(landGrab.roundScores(withLine), 'p1')).toBeGreaterThan(
      points(landGrab.roundScores(withoutLine), 'p1'),
    );
  });

  describe('board size follows the room', () => {
    const bigContent: ContentItem[] = Array.from({ length: 16 }, (_, i) => ({
      id: `big-q${i}`,
      categoryId: 'general',
      difficulty: 2,
      shape: 'mcq' as const,
      textAr: `مربع كبير ${i}`,
      options: ['أ', 'ب', 'ج', 'د'],
      correctIndex: i % 4,
    }));

    it('asks for nine squares in a small room and sixteen in a big one', () => {
      // Nine squares between eight people is one each: the round decides nothing and the line
      // bonus is arithmetically unreachable for everybody.
      expect(landGrab.itemsFor!(2)).toBe(9);
      expect(landGrab.itemsFor!(5)).toBe(9);
      expect(landGrab.itemsFor!(6)).toBe(16);
      expect(landGrab.itemsFor!(8)).toBe(16);
    });

    it('plays the bigger board a room of eight would actually get', () => {
      const players = makePlayers(8);
      let state = landGrab.createState(bigContent, init(players, landGrab.durationMs));
      expect((landGrab.view(state, 'p1') as { totalCells: number }).totalCells).toBe(16);

      // Two squares each is roughly the density the round was tuned at on the small board.
      for (const [i, player] of players.entries()) {
        for (const cell of [i * 2, i * 2 + 1]) {
          state = landGrab.reduce(state, { kind: 'open', cell }, {
            playerId: player.id,
            nowMs: START_MS + 1_000,
          }).state;
          state = landGrab.reduce(state, { kind: 'answer', cell, choice: cell % 4 }, {
            playerId: player.id,
            nowMs: START_MS + 1_100,
          }).state;
        }
      }

      const scores = landGrab.roundScores(state);
      for (const score of scores) expect(score.points).toBeGreaterThan(0);
      expect(landGrab.isFinished(state)).toBe(true);
    });

    it('still pays exactly the ceiling for taking the whole big board', () => {
      // The shared 200-point ceiling has to hold on every board size, or a big room quietly
      // makes this round worth less than every other type in the playlist.
      const players = makePlayers(8);
      let state = landGrab.createState(bigContent, init(players, landGrab.durationMs));
      for (let cell = 0; cell < 16; cell += 1) {
        state = landGrab.reduce(state, { kind: 'open', cell }, {
          playerId: 'p1',
          nowMs: START_MS + 1_000,
        }).state;
        state = landGrab.reduce(state, { kind: 'answer', cell, choice: cell % 4 }, {
          playerId: 'p1',
          nowMs: START_MS + 1_100,
        }).state;
      }
      expect(points(landGrab.roundScores(state), 'p1')).toBe(200);
    });

    it('awards a line on the 4×4 board, which a hardcoded 3×3 table would miss', () => {
      const players = makePlayers(8);
      let state = landGrab.createState(bigContent, init(players, landGrab.durationMs));
      // The top row of a 4×4 board is cells 0–3; on a 3×3 table those are not a line at all.
      for (const cell of [0, 1, 2, 3]) {
        state = landGrab.reduce(state, { kind: 'open', cell }, {
          playerId: 'p1',
          nowMs: START_MS + 1_000,
        }).state;
        state = landGrab.reduce(state, { kind: 'answer', cell, choice: cell % 4 }, {
          playerId: 'p1',
          nowMs: START_MS + 1_100,
        }).state;
      }
      // Four of sixteen squares is 45 points of territory, plus the 20 line bonus.
      expect(points(landGrab.roundScores(state), 'p1')).toBe(65);
    });

    it('refuses a board that is not square', () => {
      expect(() =>
        landGrab.createState(bigContent.slice(0, 12), init(makePlayers(6), landGrab.durationMs)),
      ).toThrow();
    });
  });

  it('locks a square a player got wrong so they cannot grind it', () => {
    let state = fresh();
    state = landGrab.reduce(state, { kind: 'open', cell: 0 }, { playerId: 'p1', nowMs: START_MS }).state;
    state = landGrab.reduce(state, { kind: 'answer', cell: 0, choice: 3 }, { playerId: 'p1', nowMs: START_MS }).state;
    expect(state.failed['p1']).toContain(0);

    state = landGrab.reduce(state, { kind: 'open', cell: 0 }, { playerId: 'p1', nowMs: START_MS }).state;
    expect(state.attempting['p1']).toBeNull();
  });

  it('leaves a square open for others after somebody fails it', () => {
    let state = fresh();
    state = landGrab.reduce(state, { kind: 'open', cell: 0 }, { playerId: 'p1', nowMs: START_MS }).state;
    state = landGrab.reduce(state, { kind: 'answer', cell: 0, choice: 3 }, { playerId: 'p1', nowMs: START_MS }).state;

    const taken = claim(state, 'p2', [0]);
    expect(taken.owners[0]).toBe('p2');
  });

  it('releases a player without penalty when somebody else takes the square first', () => {
    // Losing a race is the game; being punished for reading the question is not.
    let state = fresh();
    state = landGrab.reduce(state, { kind: 'open', cell: 0 }, { playerId: 'p1', nowMs: START_MS }).state;
    state = claim(state, 'p2', [0]);

    state = landGrab.reduce(state, { kind: 'answer', cell: 0, choice: 0 }, { playerId: 'p1', nowMs: START_MS }).state;
    expect(state.attempting['p1']).toBeNull();
    expect(state.failed['p1']).toEqual([]);
  });

  it('only shows the question for the square a player opened', () => {
    let state = fresh();
    state = landGrab.reduce(state, { kind: 'open', cell: 2 }, { playerId: 'p1', nowMs: START_MS }).state;
    const view = JSON.stringify(landGrab.view(state, 'p1'));
    expect(view).toContain('مربع 2');
    expect(view).not.toContain('مربع 5');
  });

  it('ends the round when the board is full', () => {
    const state = claim(fresh(), 'p1', [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(landGrab.isFinished(state)).toBe(true);
  });
});

describe('وصّفهالي (describe_it)', () => {
  const content: ContentItem[] = [
    {
      id: 'q1',
      categoryId: 'general',
      difficulty: 2,
      shape: 'open_answer',
      textAr: 'وصّف الكلمة',
      answerAr: 'الأهرامات',
      aliases: ['الاهرامات'],
    },
  ];

  const fresh = () => describeIt.createState(content, init(makePlayers(4), describeIt.durationMs));

  const describerOfTeamA = () => fresh().describerOf['team-a']!;
  const guesserOfTeamA = () => ['p1', 'p3'].find((id) => id !== describerOfTeamA())!;

  it('gives exactly one describer per team', () => {
    const state = fresh();
    expect(Object.keys(state.describerOf).sort()).toEqual(['team-a', 'team-b']);
    expect(['p1', 'p3']).toContain(state.describerOf['team-a']);
    expect(['p2', 'p4']).toContain(state.describerOf['team-b']);
  });

  it('shows the secret word to the describer only', () => {
    const state = fresh();
    const describerView = JSON.stringify(describeIt.view(state, describerOfTeamA()));
    const guesserView = JSON.stringify(describeIt.view(state, guesserOfTeamA()));

    expect(describerView).toContain('الأهرامات');
    // The whole round collapses if a guesser can read the answer out of their own payload.
    expect(guesserView).not.toContain('الأهرامات');
  });

  it('keeps one team\'s clues away from the other team', () => {
    let state = fresh();
    state = describeIt.reduce(state, { kind: 'clue', text: 'مباني قديمة في الجيزة' }, {
      playerId: describerOfTeamA(),
      nowMs: START_MS + 1_000,
    }).state;

    const opponent = describeIt.view(state, fresh().describerOf['team-b']!);
    expect(JSON.stringify(opponent)).not.toContain('مباني قديمة في الجيزة');
  });

  it('rejects a clue containing the word itself', () => {
    let state = fresh();
    const describer = describerOfTeamA();
    state = describeIt.reduce(state, { kind: 'clue', text: 'الأهرامات في الجيزة' }, {
      playerId: describer,
      nowMs: START_MS + 1_000,
    }).state;

    expect(state.clues['team-a']).toEqual([]);
    expect(state.rejectedClues[describer]).toBe(1);
  });

  it('rejects a clue containing an alias of the word', () => {
    let state = fresh();
    state = describeIt.reduce(state, { kind: 'clue', text: 'الاهرامات حلوة' }, {
      playerId: describerOfTeamA(),
      nowMs: START_MS + 1_000,
    }).state;
    expect(state.clues['team-a']).toEqual([]);
  });

  it('pays the whole team when a guesser gets it', () => {
    const state = describeIt.reduce(fresh(), { kind: 'guess', text: 'الأهرامات' }, {
      playerId: guesserOfTeamA(),
      nowMs: START_MS + 5_000,
    }).state;

    const scores = describeIt.roundScores(state);
    // Describer included — the round is a team effort and splitting the credit starts arguments.
    expect(points(scores, 'p1')).toBe(200);
    expect(points(scores, 'p3')).toBe(200);
    expect(points(scores, 'p2')).toBe(0);
  });

  it('pays the second team less than the first', () => {
    let state = describeIt.reduce(fresh(), { kind: 'guess', text: 'الأهرامات' }, {
      playerId: guesserOfTeamA(),
      nowMs: START_MS + 5_000,
    }).state;

    const teamBGuesser = ['p2', 'p4'].find((id) => id !== state.describerOf['team-b'])!;
    state = describeIt.reduce(state, { kind: 'guess', text: 'الأهرامات' }, {
      playerId: teamBGuesser,
      nowMs: START_MS + 9_000,
    }).state;

    const scores = describeIt.roundScores(state);
    expect(points(scores, teamBGuesser)).toBe(130);
  });

  it('stops the describer from guessing their own word', () => {
    const state = describeIt.reduce(fresh(), { kind: 'guess', text: 'الأهرامات' }, {
      playerId: describerOfTeamA(),
      nowMs: START_MS + 1_000,
    }).state;
    expect(state.solvedOrder).toEqual([]);
  });

  it('ends the round once both teams have it', () => {
    let state = fresh();
    state = describeIt.reduce(state, { kind: 'guess', text: 'الأهرامات' }, {
      playerId: guesserOfTeamA(),
      nowMs: START_MS + 5_000,
    }).state;
    const teamBGuesser = ['p2', 'p4'].find((id) => id !== state.describerOf['team-b'])!;
    state = describeIt.reduce(state, { kind: 'guess', text: 'الأهرامات' }, {
      playerId: teamBGuesser,
      nowMs: START_MS + 6_000,
    }).state;

    expect(describeIt.isFinished(state)).toBe(true);
  });
});

describe('وصّفهالي — clue filtering', () => {
  const cannes: ContentItem[] = [
    {
      id: 'q-cannes',
      categoryId: 'cinema',
      difficulty: 3,
      shape: 'open_answer',
      textAr: 'إيه اسم مهرجان السينما الأشهر في فرنسا؟',
      answerAr: 'مهرجان كان',
      aliases: ['كان'],
    },
  ];

  const start = () => describeIt.createState(cannes, init(makePlayers(4), describeIt.durationMs));

  const clue = (text: string) => {
    const state = start();
    return describeIt.reduce(state, { kind: 'clue', text }, {
      playerId: state.describerOf['team-a']!,
      nowMs: START_MS + 1_000,
    }).state;
  };

  it('blocks a clue carrying a distinctive word from the answer', () => {
    expect(clue('بيتعمل في مهرجان كل سنة').clues['team-a']).toEqual([]);
  });

  it('allows a common short word that happens to be part of the answer', () => {
    // "كان" is half the answer and also the commonest verb in Arabic. Policing it rejects
    // ordinary sentences and makes the describer think the game is broken.
    expect(clue('الفيلم ده كان حلو أوي').clues['team-a']).toHaveLength(1);
  });

  it('still blocks the answer said outright, however short', () => {
    expect(clue('كان').clues['team-a']).toEqual([]);
  });
});
