import { describe, expect, it } from 'vitest';
import type { ContentItem, PlayerRef, RoundScore } from '@game/shared';
import { TRUTH_OPTION_ID, fibbing, type FibbingState } from './fibbing.js';
import { whoAmongUs, type WhoAmongUsState } from './who-among-us.js';
import { START_MS, makePlayers } from './test-drivers.js';

const points = (scores: RoundScore[], playerId: string) =>
  scores.find((s) => s.playerId === playerId)!.points;

const init = (players: PlayerRef[], durationMs: number) => ({
  players,
  startedAtMs: START_MS,
  endsAtMs: START_MS + durationMs,
});

describe('الكذّابين (fibbing)', () => {
  const content: ContentItem[] = [
    {
      id: 'q1',
      categoryId: 'bluff',
      difficulty: 3,
      shape: 'open_answer',
      textAr: 'إيه أكتر فاكهة بتتزرع في العالم؟',
      answerAr: 'الطماطم',
      aliases: ['طماطم'],
    },
  ];

  /** Writes a lie for each player, which opens voting once the last one lands. */
  function writeAll(lies: Record<string, string>, playerCount = 3) {
    const players = makePlayers(playerCount);
    let state = fibbing.createState(content, init(players, fibbing.durationMs));
    for (const [playerId, text] of Object.entries(lies)) {
      state = fibbing.reduce(state, { kind: 'lie', text }, {
        playerId,
        nowMs: START_MS + 1_000,
      }).state;
    }
    return { state, players };
  }

  const optionOf = (state: FibbingState, authorId: string) =>
    state.options.find((o) => o.authorIds.includes(authorId))!;

  it('moves to voting once everyone has written', () => {
    const { state } = writeAll({ p1: 'الموز', p2: 'التفاح', p3: 'المانجو' });
    expect(state.stage).toBe('voting');
    // Three lies plus the truth.
    expect(state.options).toHaveLength(4);
  });

  it('does not wait out the writing clock when everyone is done', () => {
    // The deadline jumping forward is what the engine reads to start the vote early.
    const { state } = writeAll({ p1: 'الموز', p2: 'التفاح', p3: 'المانجو' });
    expect(fibbing.nextDeadline(state)).toBe(state.voteEndsAtMs);
    expect(state.voteEndsAtMs!).toBeLessThan(state.writeEndsAtMs + fibbing.durationMs);
  });

  it('includes the real answer among the options', () => {
    const { state } = writeAll({ p1: 'الموز', p2: 'التفاح', p3: 'المانجو' });
    const truth = state.options.find((o) => o.id === TRUTH_OPTION_ID)!;
    expect(truth.textAr).toBe('الطماطم');
    expect(truth.authorIds).toEqual([]);
  });

  it('hides the answer while players are still writing', () => {
    const players = makePlayers(3);
    const state = fibbing.createState(content, init(players, fibbing.durationMs));
    expect(JSON.stringify(fibbing.view(state, 'p1'))).not.toContain('الطماطم');
  });

  it('never tells a player who wrote which option', () => {
    // Knowing the author solves the round outright.
    const { state } = writeAll({ p1: 'الموز', p2: 'التفاح', p3: 'المانجو' });
    const view = JSON.stringify(fibbing.view(state, 'p2'));
    expect(view).not.toContain('authorIds');
    expect(view).not.toContain('p1');
    expect(view).not.toContain('p3');
  });

  it('scores 100 for finding the truth', () => {
    const { state } = writeAll({ p1: 'الموز', p2: 'التفاح', p3: 'المانجو' });
    let next = state;
    next = fibbing.reduce(next, { kind: 'vote', optionId: TRUTH_OPTION_ID }, {
      playerId: 'p1',
      nowMs: START_MS + 2_000,
    }).state;
    next = fibbing.onDeadline(next, { nowMs: START_MS + fibbing.durationMs }).state;

    expect(points(fibbing.roundScores(next), 'p1')).toBe(100);
  });

  it('pays the full fool bonus when everybody falls for one lie', () => {
    const { state } = writeAll({ p1: 'الموز', p2: 'التفاح', p3: 'المانجو' });
    const mine = optionOf(state, 'p1');

    let next = state;
    next = fibbing.reduce(next, { kind: 'vote', optionId: TRUTH_OPTION_ID }, { playerId: 'p1', nowMs: START_MS + 2_000 }).state;
    next = fibbing.reduce(next, { kind: 'vote', optionId: mine.id }, { playerId: 'p2', nowMs: START_MS + 2_100 }).state;
    next = fibbing.reduce(next, { kind: 'vote', optionId: mine.id }, { playerId: 'p3', nowMs: START_MS + 2_200 }).state;

    // 100 for the truth plus 100 for fooling both others: the ceiling, reached by a route no
    // other round type offers.
    expect(points(fibbing.roundScores(next), 'p1')).toBe(200);
  });

  it('scales the fool bonus by room size so the ceiling never moves', () => {
    const five = writeAll({ p1: 'أ', p2: 'ب', p3: 'ج', p4: 'د', p5: 'ه' }, 5);
    const mine = optionOf(five.state, 'p1');

    let next = five.state;
    for (const voter of ['p2', 'p3', 'p4', 'p5']) {
      next = fibbing.reduce(next, { kind: 'vote', optionId: mine.id }, {
        playerId: voter,
        nowMs: START_MS + 2_000,
      }).state;
    }
    // Four fooled out of four possible is still exactly 100, not 400.
    expect(points(fibbing.roundScores(next), 'p1')).toBe(100);
  });

  it('refuses to let a player vote for their own lie', () => {
    const { state } = writeAll({ p1: 'الموز', p2: 'التفاح', p3: 'المانجو' });
    const mine = optionOf(state, 'p1');
    const after = fibbing.reduce(state, { kind: 'vote', optionId: mine.id }, {
      playerId: 'p1',
      nowMs: START_MS + 2_000,
    }).state;
    expect(after.votes['p1']).toBeUndefined();
  });

  it('merges identical lies into one option and credits both authors', () => {
    const { state } = writeAll({ p1: 'الموز', p2: 'الموز', p3: 'المانجو' });
    // Two players writing "الموز" must not produce two identical rows — that would give it away.
    expect(state.options).toHaveLength(3);

    const shared = optionOf(state, 'p1');
    expect(shared.authorIds.sort()).toEqual(['p1', 'p2']);

    const after = fibbing.reduce(state, { kind: 'vote', optionId: shared.id }, {
      playerId: 'p3',
      nowMs: START_MS + 2_000,
    }).state;
    const scores = fibbing.roundScores(after);
    expect(points(scores, 'p1')).toBe(points(scores, 'p2'));
    expect(points(scores, 'p1')).toBeGreaterThan(0);
  });

  it('rewards a player whose lie happens to be the real answer', () => {
    const { state } = writeAll({ p1: 'طماطم', p2: 'التفاح', p3: 'المانجو' });
    expect(state.accidentalTruths).toContain('p1');
    // And the truth must not then appear twice in the list.
    expect(state.options).toHaveLength(3);

    const closed = fibbing.onDeadline(state, { nowMs: START_MS + fibbing.durationMs }).state;
    expect(points(fibbing.roundScores(closed), 'p1')).toBe(100);
  });

  it('closes the writing stage on the deadline even if nobody wrote', () => {
    const players = makePlayers(3);
    const fresh = fibbing.createState(content, init(players, fibbing.durationMs));
    const voting = fibbing.onDeadline(fresh, { nowMs: START_MS + 40_000 }).state;
    expect(voting.stage).toBe('voting');
    // Only the truth is on offer, which is a dull round but not a broken one.
    expect(voting.options).toHaveLength(1);
  });

  it('scores nothing for a player who did nothing', () => {
    const { state } = writeAll({ p1: 'الموز', p2: 'التفاح', p3: 'المانجو' });
    const closed = fibbing.onDeadline(state, { nowMs: START_MS + fibbing.durationMs }).state;
    expect(points(fibbing.roundScores(closed), 'p2')).toBe(0);
  });
});

describe('مين فينا؟ (who_among_us)', () => {
  const content: ContentItem[] = [
    {
      id: 'q1',
      categoryId: 'friends',
      difficulty: 1,
      shape: 'poll',
      textAr: 'مين أكتر واحد فينا بيتأخر؟',
    },
  ];

  function voteAll(votes: Record<string, string>, playerCount = 3) {
    const players = makePlayers(playerCount);
    let state: WhoAmongUsState = whoAmongUs.createState(content, init(players, whoAmongUs.durationMs));
    for (const [playerId, targetId] of Object.entries(votes)) {
      state = whoAmongUs.reduce(state, { kind: 'vote', targetId }, {
        playerId,
        nowMs: START_MS + 1_000,
      }).state;
    }
    if (!whoAmongUs.isFinished(state)) {
      state = whoAmongUs.onDeadline(state, { nowMs: START_MS + whoAmongUs.durationMs }).state;
    }
    return state;
  }

  it('pays the ceiling when the room is unanimous', () => {
    const state = voteAll({ p1: 'p2', p2: 'p2', p3: 'p2' });
    expect(points(whoAmongUs.roundScores(state), 'p1')).toBe(200);
  });

  it('pays partially when the room splits', () => {
    // Agreeing with one of two others is worth half, not nothing — a near-miss on a split vote
    // should still count for something.
    const state = voteAll({ p1: 'p2', p2: 'p2', p3: 'p1' });
    expect(points(whoAmongUs.roundScores(state), 'p1')).toBe(100);
  });

  it('pays nothing to a lone opinion', () => {
    const state = voteAll({ p1: 'p3', p2: 'p1', p3: 'p2' });
    expect(points(whoAmongUs.roundScores(state), 'p1')).toBe(0);
  });

  it('allows voting for yourself', () => {
    const state = voteAll({ p1: 'p1', p2: 'p1', p3: 'p1' });
    expect(points(whoAmongUs.roundScores(state), 'p1')).toBe(200);
  });

  it('scores nothing for a player who never voted', () => {
    const state = voteAll({ p1: 'p2', p2: 'p2' });
    const scores = whoAmongUs.roundScores(state);
    expect(points(scores, 'p3')).toBe(0);
    expect(scores.find((s) => s.playerId === 'p3')!.msTaken).toBeNull();
  });

  it('rejects a vote for somebody who is not in the room', () => {
    const players = makePlayers(3);
    const state = whoAmongUs.createState(content, init(players, whoAmongUs.durationMs));
    const after = whoAmongUs.reduce(state, { kind: 'vote', targetId: 'stranger' }, {
      playerId: 'p1',
      nowMs: START_MS + 500,
    }).state;
    expect(after.votes).toEqual({});
  });

  it('keeps the running tally secret until the reveal', () => {
    const players = makePlayers(3);
    let state = whoAmongUs.createState(content, init(players, whoAmongUs.durationMs));
    state = whoAmongUs.reduce(state, { kind: 'vote', targetId: 'p2' }, {
      playerId: 'p1',
      nowMs: START_MS + 500,
    }).state;

    // Showing who is winning mid-round would just make everyone pile on.
    const view = JSON.stringify(whoAmongUs.view(state, 'p3'));
    expect(view).not.toContain('tally');
    expect(view).not.toContain('votes');

    expect(JSON.stringify(whoAmongUs.reveal(state))).toContain('p2');
  });

  it('ranks the reveal tally by vote count', () => {
    const state = voteAll({ p1: 'p2', p2: 'p2', p3: 'p1' });
    const reveal = whoAmongUs.reveal(state) as { tally: Array<{ targetId: string; count: number }> };
    expect(reveal.tally[0]!.targetId).toBe('p2');
    expect(reveal.tally[0]!.count).toBe(2);
  });
});
