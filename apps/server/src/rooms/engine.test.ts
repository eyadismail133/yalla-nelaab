import { beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { RoomState } from '@game/shared';
import { getRoundType } from '@game/rounds';
import { JsonSource } from '../content/json-source.js';
import { MemoryStore } from './memory-store.js';
import { MatchEngine, EngineError, MAX_PLAYERS } from './engine.js';
import { VersionConflictError } from './store.js';
import { toView } from './view.js';

const SEED_DIR = fileURLToPath(new URL('../../../../content/seed', import.meta.url));
const content = new JsonSource(SEED_DIR);

const INTRO_MS = 3_500;
const RESULT_MS = 6_000;

/** Controllable clock — the engine takes `now` as a dependency precisely so tests can do this. */
class Clock {
  constructor(public value = 1_700_000_000_000) {}
  now = () => this.value;
  advance(ms: number) {
    this.value += ms;
    return this.value;
  }
}

function setup(overrides: Partial<ConstructorParameters<typeof MatchEngine>[2]> = {}) {
  const clock = new Clock();
  const store = new MemoryStore();
  const engine = new MatchEngine(store, content, {
    introMs: INTRO_MS,
    resultMs: RESULT_MS,
    now: clock.now,
    ...overrides,
  });
  return { clock, store, engine };
}

interface RoomOpts {
  playerCount?: number;
  roundCount?: 5 | 10 | 15;
  /**
   * Pinning the format to a single type makes outcomes deterministic — a mixed playlist picks
   * different types per run, and a scoring assertion built on that would pass or fail by luck.
   */
  roundTypeId?: string;
}

async function seatedRoom({ playerCount = 3, roundCount = 5, roundTypeId }: RoomOpts = {}) {
  const ctx = setup();
  const host = await ctx.engine.createRoom('يوسف', {
    roundCount,
    ...(roundTypeId ? { format: 'focused' as const, roundTypeId } : {}),
  });
  const joins = [];
  for (let i = 1; i < playerCount; i += 1) {
    joins.push(await ctx.engine.join(host.state.code, `لاعب ${i}`));
  }
  const ids = [host.playerId, ...joins.map((j) => j.playerId)];
  return { ...ctx, code: host.state.code, host, joins, ids };
}

/** Everyone answers the current round correctly. */
async function answerRoundCorrectly(
  engine: MatchEngine,
  store: MemoryStore,
  code: string,
  playerIds: string[],
) {
  for (const playerId of playerIds) {
    const fresh = (await store.get(code))!;
    if (fresh.phase !== 'in_round' && fresh.phase !== 'sudden_death') break;
    const round = fresh.roundState as any;

    switch (fresh.roundTypeId) {
      case 'mcq_race':
        await engine.submitAction(code, playerId, fresh.roundNo, {
          kind: 'answer',
          choice: round.item.correctIndex,
        });
        break;
      case 'numeric_guess':
        await engine.submitAction(code, playerId, fresh.roundNo, {
          kind: 'guess',
          value: round.item.correctValue,
        });
        break;
      case 'fill_blank':
        await engine.submitAction(code, playerId, fresh.roundNo, {
          kind: 'submit',
          text: round.item.answerAr,
        });
        break;
      case 'quickfire_tf':
        for (let i = 0; i < 5; i += 1) {
          const now = (await store.get(code))!;
          if (now.phase !== 'in_round') break;
          await engine.submitAction(code, playerId, now.roundNo, {
            kind: 'judge',
            index: i,
            value: (now.roundState as any).items[i].isTrue,
          });
        }
        break;
      case 'who_among_us':
        await engine.submitAction(code, playerId, fresh.roundNo, {
          kind: 'vote',
          targetId: round.playerIds[0],
        });
        break;
      case 'fibbing':
        // Two stages, so the whole room writes before anybody can vote.
        await engine.submitAction(code, playerId, fresh.roundNo, {
          kind: 'lie',
          text: `كذبة ${playerId}`,
        });
        break;
      case 'who_am_i':
        await engine.submitAction(code, playerId, fresh.roundNo, {
          kind: 'guess',
          text: round.item.answerAr,
        });
        break;
      case 'ordering':
        // Tap the shuffled tiles back into the stored correct order.
        for (const label of round.item.items as string[]) {
          const now = (await store.get(code))!;
          if (now.phase !== 'in_round') break;
          await engine.submitAction(code, playerId, now.roundNo, {
            kind: 'place',
            index: (now.roundState as any).shuffled.indexOf(label),
          });
        }
        break;
      case 'land_grab':
        // The board sizes itself to the room, so the loop reads its length rather than nine.
        for (let cell = 0; cell < (round.items as unknown[]).length; cell += 1) {
          const now = (await store.get(code))!;
          if (now.phase !== 'in_round') break;
          const board = now.roundState as any;
          if (board.owners[cell] !== undefined) continue;
          await engine.submitAction(code, playerId, now.roundNo, { kind: 'open', cell });
          await engine.submitAction(code, playerId, now.roundNo, {
            kind: 'answer',
            cell,
            choice: board.items[cell].correctIndex,
          });
        }
        break;
      case 'bidding':
        await engine.submitAction(code, playerId, fresh.roundNo, { kind: 'bid', amount: 1 });
        break;
      case 'steal':
        await engine.submitAction(code, playerId, fresh.roundNo, {
          kind: 'answer',
          choice: round.item.correctIndex,
        });
        break;
      case 'odd_one_out':
        for (let i = 0; i < (round.items as unknown[]).length; i += 1) {
          const now = (await store.get(code))!;
          if (now.phase !== 'in_round') break;
          const state = now.roundState as any;
          await engine.submitAction(code, playerId, now.roundNo, {
            kind: 'answer',
            index: i,
            choice: state.items[i].oddIndex,
          });
        }
        break;
      case 'emoji_rush':
        for (let i = 0; i < 5; i += 1) {
          const now = (await store.get(code))!;
          if (now.phase !== 'in_round') break;
          const state = now.roundState as any;
          const cursor = state.cursor[playerId] ?? 0;
          if (cursor >= 5) break;
          await engine.submitAction(code, playerId, now.roundNo, {
            kind: 'submit',
            text: state.items[cursor].answerAr,
          });
        }
        break;
      case 'ladder':
        for (let i = 0; i < 5; i += 1) {
          const now = (await store.get(code))!;
          if (now.phase !== 'in_round') break;
          const state = now.roundState as any;
          if (state.busted[playerId] || state.locked[playerId]) break;
          const rung = state.rung[playerId] ?? 0;
          await engine.submitAction(code, playerId, now.roundNo, {
            kind: 'answer',
            choice: state.items[rung].correctIndex,
          });
        }
        break;
      case 'higher_lower':
        for (let i = 0; i < 4; i += 1) {
          const now = (await store.get(code))!;
          if (now.phase !== 'in_round') break;
          const state = now.roundState as any;
          const cursor = state.cursor[playerId] ?? 0;
          if (cursor >= state.pairs.length) break;
          const pair = state.pairs[cursor];
          await engine.submitAction(code, playerId, now.roundNo, {
            kind: 'choose',
            index: cursor,
            side: pair[0].correctValue > pair[1].correctValue ? 'a' : 'b',
          });
        }
        break;
      case 'relay': {
        // Turns pass between teammates, so at most one action lands per pass through this
        // player — the outer loop's next pass (or the round's own timeout) carries the rest.
        const teamId = round.teamOf[playerId];
        const asked = round.asked[teamId] ?? 0;
        const item = round.itemsByTeam?.[teamId]?.[asked];
        if (item) {
          await engine.submitAction(code, playerId, fresh.roundNo, {
            kind: 'answer',
            choice: item.correctIndex,
          });
        }
        break;
      }
      case 'word_race':
        for (let field = 0; field < (round.item.fieldsAr as string[]).length; field += 1) {
          const now = (await store.get(code))!;
          if (now.phase !== 'in_round') break;
          const state = now.roundState as any;
          if (state.stage !== 'writing') break;
          await engine.submitAction(code, playerId, now.roundNo, {
            kind: 'write',
            field,
            text: `${state.letter}-${playerId}-${field}`,
          });
        }
        break;
      default:
        throw new Error(`Test helper cannot play round type ${fresh.roundTypeId}`);
    }
  }

  // Two-stage types need a second pass, because the later stage does not open until the whole
  // room has finished the first one.
  const afterFirstStage = (await store.get(code))!;
  if (afterFirstStage.phase !== 'in_round') return;

  for (const playerId of playerIds) {
    const now = (await store.get(code))!;
    if (now.phase !== 'in_round') break;
    const round = now.roundState as any;

    switch (now.roundTypeId) {
      case 'fibbing':
        await engine.submitAction(code, playerId, now.roundNo, {
          kind: 'vote',
          optionId: 'truth',
        });
        break;
      case 'steal':
        // Everyone answered correctly, so there is nobody worth robbing.
        await engine.submitAction(code, playerId, now.roundNo, { kind: 'pass' });
        break;
      case 'bidding':
        for (let i = 0; i < 4; i += 1) {
          const step = (await store.get(code))!;
          if (step.phase !== 'in_round') break;
          await engine.submitAction(code, playerId, step.roundNo, {
            kind: 'answer',
            index: i,
            choice: (step.roundState as any).items[i].correctIndex,
          });
        }
        break;
      case 'word_race':
        await engine.submitAction(code, playerId, now.roundNo, { kind: 'ready' });
        break;
      default:
        break;
    }
    void round;
  }
}

/**
 * Runs a whole match to its terminal phase.
 *
 * `answerers` defaults to everybody. Pass a subset when the test needs a decisive result: with
 * a shared 200-point ceiling and a controllable clock, a room where everyone plays perfectly at
 * the same instant is a genuine tie, and the match correctly goes to sudden death instead of
 * the podium.
 */
async function playWholeMatch(
  engine: MatchEngine,
  store: MemoryStore,
  clock: Clock,
  code: string,
  ids: string[],
  rounds: number,
  answerers: string[] = ids,
) {
  for (let round = 0; round < rounds; round += 1) {
    clock.advance(INTRO_MS);
    await engine.tick();
    await answerRoundCorrectly(engine, store, code, answerers);

    const mid = (await store.get(code))!;
    if (mid.phase === 'in_round') {
      clock.advance(getRoundType(mid.roundTypeId!).durationMs + 10);
      await engine.tick();
    }
    // Read the deadline rather than assuming RESULT_MS: a type's `revealWeight` stretches its
    // result screen, and a fixed advance silently leaves the match parked on a reveal.
    await runOutPhase(engine, store, clock, code);
  }
  return (await store.get(code))!;
}

/** Advances the clock to whatever the room says its current phase ends at, then ticks. */
async function runOutPhase(
  engine: MatchEngine,
  store: MemoryStore,
  clock: Clock,
  code: string,
): Promise<void> {
  const state = (await store.get(code))!;
  if (state.phaseEndsAtMs === null) return;
  clock.advance(Math.max(0, state.phaseEndsAtMs - clock.value) + 10);
  await engine.tick();
}

describe('lobby', () => {
  it('creates a room with a joinable code', async () => {
    const { engine } = setup();
    const { state, playerId, token } = await engine.createRoom('يوسف');
    expect(state.code).toHaveLength(5);
    expect(state.hostId).toBe(playerId);
    expect(token.length).toBeGreaterThan(8);
    expect(state.phase).toBe('lobby');
  });

  it('seats joiners in the same room', async () => {
    const { store, code, ids } = await seatedRoom({ playerCount: 3 });
    const state = (await store.get(code))!;
    expect(state.players.map((p) => p.id).sort()).toEqual([...ids].sort());
    expect(state.totals).toHaveLength(3);
  });

  it('rejects a duplicate nickname so the scoreboard stays readable', async () => {
    const { engine, code } = await seatedRoom({ playerCount: 2 });
    await expect(engine.join(code, 'يوسف')).rejects.toThrow(EngineError);
  });

  it('rejects a duplicate nickname regardless of casing or padding', async () => {
    const { engine, code } = await seatedRoom({ playerCount: 2 });
    await expect(engine.join(code, '  يوسف ')).rejects.toThrow(EngineError);
  });

  it('caps the room at the maximum party size', async () => {
    const { engine, code } = await seatedRoom({ playerCount: MAX_PLAYERS });
    await expect(engine.join(code, 'زيادة')).rejects.toThrow(EngineError);
  });

  it('refuses to start below the minimum party size', async () => {
    const { engine, code, host } = await seatedRoom({ playerCount: 1 });
    await expect(engine.start(code, host.playerId)).rejects.toThrow(EngineError);
  });

  it('only lets the host start', async () => {
    const { engine, code, joins } = await seatedRoom();
    await expect(engine.start(code, joins[0]!.playerId)).rejects.toThrow(EngineError);
  });

  it('only lets the host change settings', async () => {
    const { engine, code, joins } = await seatedRoom();
    await expect(engine.configure(code, joins[0]!.playerId, { roundCount: 15 })).rejects.toThrow(
      EngineError,
    );
  });

  it('lets the host kick a player', async () => {
    const { engine, code, host, joins } = await seatedRoom();
    const state = await engine.kick(code, host.playerId, joins[0]!.playerId);
    expect(state.players.map((p) => p.id)).not.toContain(joins[0]!.playerId);
  });

  it('stops the host kicking themselves', async () => {
    const { engine, code, host } = await seatedRoom();
    await expect(engine.kick(code, host.playerId, host.playerId)).rejects.toThrow(EngineError);
  });

  it('refuses joins once the match is under way', async () => {
    const { engine, code, host } = await seatedRoom();
    await engine.start(code, host.playerId);
    await expect(engine.join(code, 'متأخر')).rejects.toThrow(EngineError);
  });

  it('refuses a configuration with no categories', async () => {
    const { engine, code, host } = await seatedRoom();
    await expect(engine.configure(code, host.playerId, { categoryIds: [] })).rejects.toThrow();
  });
});

describe('match flow', () => {
  it('builds a playlist and opens on the intro card', async () => {
    const { engine, code, host } = await seatedRoom({ roundCount: 5 });
    const state = await engine.start(code, host.playerId);

    // Slots rather than entries: a long type such as الكذّابين is one entry but two rounds.
    const slots = state.playlist.reduce(
      (sum, e) => sum + (getRoundType(e.roundTypeId).long ? 2 : 1),
      0,
    );
    expect(slots).toBe(5);
    expect(state.phase).toBe('round_intro');
    expect(state.roundState).toBeNull();
  });

  it('mixes round types within a single match', async () => {
    // The whole product thesis: one match should not be the same game ten times.
    const { engine, code, host } = await seatedRoom({ roundCount: 10 });
    const state = await engine.start(code, host.playerId);
    const used = new Set(state.playlist.map((e) => e.roundTypeId));
    expect(used.size).toBeGreaterThan(1);
  });

  it('starts the round clock when play begins, not when content was fetched', async () => {
    const { engine, code, host, clock, store } = await seatedRoom();
    await engine.start(code, host.playerId);

    // A sweeper that fires late must not eat into the players' round time.
    clock.advance(INTRO_MS + 2_000);
    await engine.tick();

    const state = (await store.get(code))!;
    const type = getRoundType(state.roundTypeId!);
    expect(state.phase).toBe('in_round');
    expect(state.roundStartedAtMs).toBe(clock.value);

    // The deadline comes from the round type, not from its total duration — a two-stage type
    // schedules the end of its first stage so the engine wakes up to advance it.
    expect(state.phaseEndsAtMs).toBe(type.nextDeadline(state.roundState));
    expect(state.phaseEndsAtMs!).toBeGreaterThan(clock.value);
    expect(state.phaseEndsAtMs!).toBeLessThanOrEqual(clock.value + type.durationMs);
  });

  it('resolves the round as soon as everyone has answered', async () => {
    const { engine, code, host, ids, clock, store } = await seatedRoom();
    await engine.start(code, host.playerId);
    clock.advance(INTRO_MS);
    await engine.tick();

    await answerRoundCorrectly(engine, store, code, ids);

    const state = (await store.get(code))!;
    expect(state.phase).toBe('round_result');
    expect(state.lastRoundScores).toHaveLength(3);
  });

  it('resolves the round on the deadline when players go quiet', async () => {
    const { engine, code, host, clock, store } = await seatedRoom();
    await engine.start(code, host.playerId);
    clock.advance(INTRO_MS);
    await engine.tick();

    const type = getRoundType((await store.get(code))!.roundTypeId!);

    // A multi-stage type burns one deadline per stage, so an abandoned bluffing round needs
    // the writing window to lapse and then the voting window.
    for (let stage = 0; stage < 4; stage += 1) {
      if ((await store.get(code))!.phase !== 'in_round') break;
      clock.advance(type.durationMs + 100);
      await engine.tick();
    }

    const state = (await store.get(code))!;
    expect(state.phase).toBe('round_result');
    for (const score of state.lastRoundScores!) expect(score.points).toBe(0);
  });

  it('reaches the podium after the final round and crowns a winner', async () => {
    const { engine, code, host, ids, clock, store } = await seatedRoom({
      playerCount: 2,
      roundCount: 5,
      roundTypeId: 'fill_blank',
    });
    await engine.start(code, host.playerId);
    // Only the host answers, so the match has a clear winner instead of a perfect tie.
    const state = await playWholeMatch(engine, store, clock, code, ids, 5, [ids[0]!]);

    expect(state.phase).toBe('podium');
    expect(state.endReason).toBe('completed');
    expect(state.winnerId).toBe(ids[0]);
  });

  it('pays the final round double', async () => {
    const { engine, code, host, ids, clock, store } = await seatedRoom({
      playerCount: 2,
      roundCount: 5,
      roundTypeId: 'mcq_race',
    });
    await engine.start(code, host.playerId);
    const state = await playWholeMatch(engine, store, clock, code, ids, 5);

    // Four rounds at the 200 ceiling plus a doubled fifth = 1200, not 1000. This is the
    // comeback mechanic: a player two rounds behind can still take the match on the last one.
    const total = state.standings.find((s) => s.playerId === ids[0])!.total;
    expect(total).toBe(1_200);
  });

  it('never repeats a question inside one match', async () => {
    const { engine, code, host, ids, clock, store } = await seatedRoom({ roundCount: 15 });
    await engine.start(code, host.playerId);
    const state = await playWholeMatch(engine, store, clock, code, ids, 15);

    expect(new Set(state.usedContentIds).size).toBe(state.usedContentIds.length);
  });

  it('tracks rank movement between rounds', async () => {
    const { engine, code, host, ids, clock, store } = await seatedRoom({
      playerCount: 3,
      roundCount: 5,
      roundTypeId: 'mcq_race',
    });
    await engine.start(code, host.playerId);

    clock.advance(INTRO_MS);
    await engine.tick();
    await answerRoundCorrectly(engine, store, code, [ids[1]!]);
    clock.advance(getRoundType('mcq_race').durationMs + 10);
    await engine.tick();

    const first = (await store.get(code))!;
    expect(first.standings[0]!.playerId).toBe(ids[1]);
    expect(first.standings[0]!.rankDelta).toBeNull();

    clock.advance(RESULT_MS);
    await engine.tick();
    clock.advance(INTRO_MS);
    await engine.tick();
    await answerRoundCorrectly(engine, store, code, [ids[2]!, ids[0]!]);
    clock.advance(getRoundType('mcq_race').durationMs + 10);
    await engine.tick();

    const second = (await store.get(code))!;
    expect(second.standings.some((s) => (s.rankDelta ?? 0) !== 0)).toBe(true);
  });
});

describe('action guards', () => {
  it('ignores an action carrying a stale round number', async () => {
    const { engine, code, host, clock, store } = await seatedRoom();
    await engine.start(code, host.playerId);
    clock.advance(INTRO_MS);
    await engine.tick();

    const before = (await store.get(code))!;
    const after = await engine.submitAction(code, host.playerId, before.roundNo - 1, {
      kind: 'answer',
      choice: 0,
    });
    expect(JSON.stringify(after.roundState)).toBe(JSON.stringify(before.roundState));
  });

  it('keeps the round number stable while players answer', async () => {
    // Regression guard. Actions were once validated against the store's version counter, which
    // every answer bumps — so the first simultaneous answer landed and the rest were silently
    // discarded. Round identity must not move just because somebody else acted.
    const { engine, code, host, ids, clock, store } = await seatedRoom({
      playerCount: 3,
      roundTypeId: 'mcq_race',
    });
    await engine.start(code, host.playerId);
    clock.advance(INTRO_MS);
    await engine.tick();

    const opened = (await store.get(code))!;
    await engine.submitAction(code, ids[0]!, opened.roundNo, { kind: 'answer', choice: 0 });

    const after = (await store.get(code))!;
    expect(after.roundNo).toBe(opened.roundNo);
    expect(after.version).toBeGreaterThan(opened.version);
  });

  it('advances the round number when a new round begins', async () => {
    const { engine, code, host, ids, clock, store } = await seatedRoom({
      playerCount: 2,
      roundTypeId: 'mcq_race',
    });
    await engine.start(code, host.playerId);
    const first = (await store.get(code))!.roundNo;

    clock.advance(INTRO_MS);
    await engine.tick();
    await answerRoundCorrectly(engine, store, code, ids);
    clock.advance(RESULT_MS);
    await engine.tick();

    expect((await store.get(code))!.roundNo).toBeGreaterThan(first);
  });

  it('ignores actions while the intro card is showing', async () => {
    const { engine, code, host, store } = await seatedRoom();
    await engine.start(code, host.playerId);
    const before = (await store.get(code))!;
    const after = await engine.submitAction(code, host.playerId, before.roundNo, {
      kind: 'answer',
      choice: 0,
    });
    expect(after.roundState).toBeNull();
  });

  it('ignores actions once the match is over', async () => {
    const { engine, code, host, ids, clock, store } = await seatedRoom({
      playerCount: 2,
      roundCount: 5,
      roundTypeId: 'fill_blank',
    });
    await engine.start(code, host.playerId);
    const done = await playWholeMatch(engine, store, clock, code, ids, 5, [ids[0]!]);

    const after = await engine.submitAction(code, ids[0]!, done.roundNo, {
      kind: 'submit',
      text: 'حاجة',
    });
    expect(after.phase).toBe('podium');
  });

  it('lands every simultaneous answer and resolves the round exactly once', async () => {
    const { engine, code, host, ids, clock, store } = await seatedRoom({
      playerCount: 3,
      roundTypeId: 'mcq_race',
    });
    await engine.start(code, host.playerId);
    clock.advance(INTRO_MS);
    await engine.tick();

    const state = (await store.get(code))!;
    const correct = (state.roundState as any).item.correctIndex;

    // Three players tapping at the same instant. This is the race the per-room mutex exists
    // for: without it two of these read the same state and one write disappears.
    await Promise.all(
      ids.map((id) =>
        engine.submitAction(code, id, state.roundNo, { kind: 'answer', choice: correct }),
      ),
    );

    const after = (await store.get(code))!;
    expect(after.phase).toBe('round_result');
    expect(after.lastRoundScores).toHaveLength(3);
    for (const score of after.lastRoundScores!) expect(score.isCorrect).toBe(true);
  });
});

describe('disconnects and host transfer', () => {
  it("holds a disconnected player's seat and score", async () => {
    const { engine, code, joins, store } = await seatedRoom();
    await engine.setConnected(code, joins[0]!.playerId, false);
    const state = (await store.get(code))!;
    const player = state.players.find((p) => p.id === joins[0]!.playerId)!;
    expect(player.connected).toBe(false);
    expect(player.leftEarly).toBe(false);
    expect(state.players).toHaveLength(3);
  });

  it('restores a player who reconnects with their token', async () => {
    const { engine, code, joins } = await seatedRoom();
    await engine.setConnected(code, joins[0]!.playerId, false);
    const resumed = await engine.resume(code, joins[0]!.token);
    expect(resumed.playerId).toBe(joins[0]!.playerId);
    expect(resumed.state.players.find((p) => p.id === joins[0]!.playerId)!.connected).toBe(true);
  });

  it('keeps a reconnecting player\'s score intact', async () => {
    const { engine, code, host, ids, clock, store } = await seatedRoom({
      playerCount: 3,
      roundTypeId: 'mcq_race',
    });
    await engine.start(code, host.playerId);
    clock.advance(INTRO_MS);
    await engine.tick();
    await answerRoundCorrectly(engine, store, code, ids);
    clock.advance(RESULT_MS);
    await engine.tick();

    const before = (await store.get(code))!.totals.find((t) => t.playerId === ids[1])!.total;
    expect(before).toBeGreaterThan(0);

    await engine.setConnected(code, ids[1]!, false);
    const resumed = await engine.resume(code, (await seatedRoomToken(store, code, ids[1]!))!);
    expect(resumed.state.totals.find((t) => t.playerId === ids[1])!.total).toBe(before);
  });

  it('rejects a resume with an unknown token', async () => {
    const { engine, code } = await seatedRoom();
    await expect(engine.resume(code, 'not-a-real-token')).rejects.toThrow(EngineError);
  });

  it('transfers the host to the longest-seated player when the host drops', async () => {
    const { engine, code, host, joins, store } = await seatedRoom();
    await engine.setConnected(code, host.playerId, false);
    const state = (await store.get(code))!;
    expect(state.hostId).toBe(joins[0]!.playerId);
  });

  it('lets the new host actually start the match', async () => {
    // Host transfer is only meaningful if the successor has real authority — otherwise the
    // room is dead in a different way.
    const { engine, code, host, joins } = await seatedRoom();
    await engine.setConnected(code, host.playerId, false);
    const state = await engine.start(code, joins[0]!.playerId);
    expect(state.phase).toBe('round_intro');
  });

  it('leaves the host in place when everyone has gone', async () => {
    const { engine, code, host, joins, store } = await seatedRoom({ playerCount: 2 });
    await engine.setConnected(code, host.playerId, false);
    await engine.setConnected(code, joins[0]!.playerId, false);
    expect((await store.get(code))!.players.every((p) => !p.connected)).toBe(true);
  });

  it('drops a seat from the lobby once the grace period expires', async () => {
    const { engine, code, joins, clock, store } = await seatedRoom();
    await engine.setConnected(code, joins[0]!.playerId, false);
    clock.advance(91_000);
    await engine.reapDisconnected(code);
    expect((await store.get(code))!.players).toHaveLength(2);
  });

  it('ends the match when only one player is left connected', async () => {
    const { engine, code, host, joins, clock, store } = await seatedRoom({ playerCount: 2 });
    await engine.start(code, host.playerId);
    clock.advance(INTRO_MS);
    await engine.tick();

    await engine.setConnected(code, joins[0]!.playerId, false);
    const state = (await store.get(code))!;
    expect(state.phase).toBe('podium');
    expect(state.endReason).toBe('abandoned');
    expect(state.winnerId).toBeNull();
  });

  it('does not end a lobby just because one player disconnects', async () => {
    const { engine, code, joins, store } = await seatedRoom({ playerCount: 2 });
    await engine.setConnected(code, joins[0]!.playerId, false);
    expect((await store.get(code))!.phase).toBe('lobby');
  });

  it('removes a leaving player from the lobby entirely', async () => {
    const { engine, code, joins, store } = await seatedRoom();
    await engine.leave(code, joins[0]!.playerId);
    expect((await store.get(code))!.players).toHaveLength(2);
  });
});

async function seatedRoomToken(store: MemoryStore, code: string, playerId: string) {
  return (await store.get(code))!.players.find((p) => p.id === playerId)?.token;
}

describe('a room of eight', () => {
  it('seats the full party', async () => {
    const { store, code } = await seatedRoom({ playerCount: MAX_PLAYERS });
    expect((await store.get(code))!.players).toHaveLength(8);
  });

  it('plays a whole match through without stalling', async () => {
    // The party cap moved from five to eight, and several round types size themselves to the
    // room. This is the cheap guard that the combination actually runs: a type that asks for a
    // board it cannot fill, or a stage that never closes with eight people in it, hangs the
    // match on a screen that never advances.
    const { engine, code, host, ids, clock, store } = await seatedRoom({
      playerCount: MAX_PLAYERS,
      roundCount: 10,
    });
    await engine.start(code, host.playerId);
    const state = await playWholeMatch(engine, store, clock, code, ids, 12, [ids[0]!]);

    expect(state.phase).toBe('podium');
    expect(state.endReason).toBe('completed');
    expect(state.standings).toHaveLength(8);
  });

  it('gives قطع الأرض a sixteen-square board instead of one square each', async () => {
    const { engine, code, host, clock, store } = await seatedRoom({
      playerCount: MAX_PLAYERS,
      roundCount: 5,
      roundTypeId: 'land_grab',
    });
    await engine.start(code, host.playerId);
    clock.advance(INTRO_MS);
    await engine.tick();

    const board = (await store.get(code))!.roundState as { items: unknown[] };
    expect(board.items).toHaveLength(16);
  });

  it('gives الكذّابين longer to read a nine-line vote list', async () => {
    const short = await voteWindowFor(3);
    const long = await voteWindowFor(MAX_PLAYERS);
    expect(long).toBeGreaterThan(short);
  });

  /** Runs fibbing's writing stage to completion and reports how long voting then gets. */
  async function voteWindowFor(playerCount: number) {
    const { engine, code, host, ids, clock, store } = await seatedRoom({
      playerCount,
      roundCount: 5,
      roundTypeId: 'fibbing',
    });
    await engine.start(code, host.playerId);
    clock.advance(INTRO_MS);
    await engine.tick();

    for (const playerId of ids) {
      const now = (await store.get(code))!;
      await engine.submitAction(code, playerId, now.roundNo, {
        kind: 'lie',
        text: `كذبة ${playerId}`,
      });
    }

    const voting = (await store.get(code))!.roundState as {
      stage: string;
      voteEndsAtMs: number;
    };
    expect(voting.stage).toBe('voting');
    return voting.voteEndsAtMs - clock.value;
  }
});

describe('the gap between rounds', () => {
  /** Plays one round of a pinned type and returns how long its result screen lasts. */
  async function revealWindowFor(roundTypeId: string) {
    const { engine, code, host, ids, clock, store } = await seatedRoom({
      playerCount: 3,
      roundCount: 5,
      roundTypeId,
    });
    await engine.start(code, host.playerId);
    clock.advance(INTRO_MS);
    await engine.tick();
    await answerRoundCorrectly(engine, store, code, ids);

    const mid = (await store.get(code))!;
    if (mid.phase === 'in_round') {
      clock.advance(getRoundType(mid.roundTypeId!).durationMs + 10);
      await engine.tick();
    }

    const result = (await store.get(code))!;
    expect(result.phase).toBe('round_result');
    return result.phaseEndsAtMs! - clock.value;
  }

  it('holds a one-line answer for the base window', async () => {
    expect(await revealWindowFor('mcq_race')).toBe(RESULT_MS);
  });

  it('holds a reveal with more to argue about for longer', async () => {
    // الكذّابين puts every lie and the whole vote tally on screen. Reading that in the time it
    // takes to read one MCQ answer is the difference between the funniest moment of the match
    // and a screen that flicks past.
    expect(await revealWindowFor('fibbing')).toBeGreaterThan(await revealWindowFor('mcq_race'));
  });

  it('lets the host cut it short when the room is already done talking', async () => {
    const { engine, code, host, ids, clock, store } = await seatedRoom({
      playerCount: 3,
      roundCount: 5,
      roundTypeId: 'mcq_race',
    });
    await engine.start(code, host.playerId);
    clock.advance(INTRO_MS);
    await engine.tick();
    await answerRoundCorrectly(engine, store, code, ids);
    expect((await store.get(code))!.phase).toBe('round_result');

    const after = await engine.skipPhase(code, host.playerId);
    expect(after.phase).toBe('round_intro');
    expect(after.roundIndex).toBe(1);
  });

  it('lets the host cut the intro card short too', async () => {
    const { engine, code, host } = await seatedRoom({ playerCount: 3, roundCount: 5 });
    await engine.start(code, host.playerId);
    const after = await engine.skipPhase(code, host.playerId);
    expect(after.phase).toBe('in_round');
  });

  it('gives a skipped round its full clock rather than the remainder of the intro', async () => {
    const { engine, code, host, clock } = await seatedRoom({
      playerCount: 3,
      roundCount: 5,
      roundTypeId: 'mcq_race',
    });
    await engine.start(code, host.playerId);
    const after = await engine.skipPhase(code, host.playerId);
    expect(after.phaseEndsAtMs).toBe(clock.value + getRoundType('mcq_race').durationMs);
  });

  it('refuses a skip from anybody but the host', async () => {
    const { engine, code, host, joins } = await seatedRoom({ playerCount: 3, roundCount: 5 });
    await engine.start(code, host.playerId);
    await expect(engine.skipPhase(code, joins[0]!.playerId)).rejects.toThrow(EngineError);
  });

  it('refuses to skip a round that is being played', async () => {
    // Otherwise a host who has already answered can close the round on everybody else.
    const { engine, code, host, clock } = await seatedRoom({ playerCount: 3, roundCount: 5 });
    await engine.start(code, host.playerId);
    clock.advance(INTRO_MS);
    await engine.tick();
    await expect(engine.skipPhase(code, host.playerId)).rejects.toThrow(EngineError);
  });
});

describe('sudden death', () => {
  /**
   * Two players answering every mcq_race round correctly at the same instant get identical
   * speed bonuses, so the match is guaranteed to finish level. That determinism is the point —
   * it is what lets these tests assert rather than skip.
   */
  async function tiedMatch() {
    const ctx = await seatedRoom({ playerCount: 2, roundCount: 5, roundTypeId: 'mcq_race' });
    await ctx.engine.start(ctx.code, ctx.host.playerId);
    const state = await playWholeMatch(ctx.engine, ctx.store, ctx.clock, ctx.code, ctx.ids, 5);
    return { ...ctx, state };
  }

  it('fires when the leaders finish level', async () => {
    const { state, ids } = await tiedMatch();
    expect(state.phase).toBe('sudden_death_intro');
    expect([...state.suddenDeath!.contenders].sort()).toEqual([...ids].sort());
    expect(state.suddenDeath!.attempt).toBe(1);
  });

  it('crowns whoever answers correctly first', async () => {
    const { engine, store, clock, code, ids } = await tiedMatch();

    clock.advance(INTRO_MS);
    await engine.tick();
    const playing = (await store.get(code))!;
    expect(playing.phase).toBe('sudden_death');

    await engine.submitAction(code, ids[1]!, playing.roundNo, {
      kind: 'answer',
      choice: (playing.roundState as any).item.correctIndex,
    });

    let state = (await store.get(code))!;
    if (state.phase !== 'podium') {
      clock.advance(getRoundType(state.roundTypeId!).durationMs + 10);
      await engine.tick();
      state = (await store.get(code))!;
    }
    expect(state.phase).toBe('podium');
    expect(state.winnerId).toBe(ids[1]);
  });

  it('keeps the scoreboard showing the honest tie', async () => {
    const { engine, store, clock, code, ids, state: tied } = await tiedMatch();
    const totalsBefore = JSON.stringify(tied.totals);

    clock.advance(INTRO_MS);
    await engine.tick();
    const playing = (await store.get(code))!;
    await engine.submitAction(code, ids[0]!, playing.roundNo, {
      kind: 'answer',
      choice: (playing.roundState as any).item.correctIndex,
    });

    const after = (await store.get(code))!;
    // Sudden-death points must never inflate the totals — the tie is what actually happened.
    expect(JSON.stringify(after.totals)).toBe(totalsBefore);
    expect(after.standings.filter((s) => s.rank === 1)).toHaveLength(2);
    expect(after.winnerId).toBe(ids[0]);
  });

  it('retries with a new question when nobody answers correctly', async () => {
    const { engine, store, clock, code } = await tiedMatch();

    clock.advance(INTRO_MS);
    await engine.tick();
    let state = (await store.get(code))!;
    const firstQuestion = (state.roundState as any).item.id;

    clock.advance(getRoundType(state.roundTypeId!).durationMs + 10);
    await engine.tick();

    state = (await store.get(code))!;
    expect(state.phase).toBe('sudden_death_intro');
    expect(state.suddenDeath!.attempt).toBe(2);

    clock.advance(INTRO_MS);
    await engine.tick();
    expect(((await store.get(code))!.roundState as any).item.id).not.toBe(firstQuestion);
  });

  it('stops retrying after three failed attempts', async () => {
    const { engine, store, clock, code } = await tiedMatch();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      clock.advance(INTRO_MS);
      await engine.tick();
      const state = (await store.get(code))!;
      if (state.phase !== 'sudden_death') break;
      clock.advance(getRoundType(state.roundTypeId!).durationMs + 10);
      await engine.tick();
    }

    const state = (await store.get(code))!;
    expect(state.phase).toBe('podium');
    // Genuinely inseparable players share the win rather than being split arbitrarily.
    expect(state.winnerId).toBeNull();
  });
});

describe('rematch', () => {
  async function finishedMatch() {
    const ctx = await seatedRoom({ playerCount: 2, roundCount: 5, roundTypeId: 'fill_blank' });
    await ctx.engine.start(ctx.code, ctx.host.playerId);
    // Host-only, so the match ends on the podium rather than in a tie-break.
    const state = await playWholeMatch(
      ctx.engine,
      ctx.store,
      ctx.clock,
      ctx.code,
      ctx.ids,
      5,
      [ctx.ids[0]!],
    );
    return { ...ctx, state };
  }

  it('returns the room to the lobby with scores cleared', async () => {
    const { engine, code, state } = await finishedMatch();
    expect(state.phase).toBe('podium');

    const after = await engine.rematch(code, state.hostId);
    expect(after.phase).toBe('lobby');
    expect(after.totals.every((t) => t.total === 0)).toBe(true);
    expect(after.standings).toEqual([]);
    expect(after.winnerId).toBeNull();
  });

  it('keeps used questions excluded so a rematch is not a replay', async () => {
    const { engine, code, state } = await finishedMatch();
    const after = await engine.rematch(code, state.hostId);
    expect(after.usedContentIds.length).toBeGreaterThan(0);
  });

  it('still excludes them once the second match actually starts', async () => {
    // The gap the previous test left open: `rematch` preserved the ids and `start` cleared them
    // one step later, so the exclusion survived exactly until the moment it mattered. A group
    // playing three matches in one sitting saw the same questions again from match two.
    const { engine, code, state } = await finishedMatch();
    const lobby = await engine.rematch(code, state.hostId);
    const seen = lobby.usedContentIds;
    expect(seen.length).toBeGreaterThan(0);

    const second = await engine.start(code, state.hostId);
    expect(second.usedContentIds).toEqual(expect.arrayContaining(seen));

    // `pendingContent` is `unknown[]` on RoomState — the engine hands round types their content
    // without the shared layer needing to know the shape.
    const dealt = (second.pendingContent ?? []) as Array<{ id: string }>;
    expect(dealt.filter((item) => seen.includes(item.id))).toEqual([]);
  });

  it('refuses a rematch before the match ends', async () => {
    const { engine, code, host } = await seatedRoom();
    await engine.start(code, host.playerId);
    await expect(engine.rematch(code, host.playerId)).rejects.toThrow(EngineError);
  });
});

describe('view redaction', () => {
  let state: RoomState;

  beforeEach(async () => {
    const ctx = await seatedRoom();
    await ctx.engine.start(ctx.code, ctx.host.playerId);
    ctx.clock.advance(INTRO_MS);
    await ctx.engine.tick();
    state = (await ctx.store.get(ctx.code))!;
  });

  it('never sends raw content or round internals to a player', async () => {
    const categories = await content.categories();
    const serialized = JSON.stringify(toView(state, state.players[0]!.id, categories));
    expect(serialized).not.toContain('pendingContent');
    expect(serialized).not.toContain('correctIndex');
    expect(serialized).not.toContain('correctValue');
    expect(serialized).not.toContain('answerAr');
    expect(serialized).not.toContain('isTrue');
  });

  it('never leaks another player\'s access token', async () => {
    const categories = await content.categories();
    const serialized = JSON.stringify(toView(state, state.players[0]!.id, categories));
    for (const player of state.players) {
      expect(serialized).not.toContain(player.token);
    }
  });

  it('withholds the reveal until the round resolves', async () => {
    const categories = await content.categories();
    expect(toView(state, state.players[0]!.id, categories).reveal).toBeNull();
  });

  it('shows the rules on the intro card but no question yet', async () => {
    const ctx = await seatedRoom();
    await ctx.engine.start(ctx.code, ctx.host.playerId);
    const intro = (await ctx.store.get(ctx.code))!;
    const view = toView(intro, intro.players[0]!.id, await content.categories());

    expect(view.round!.view).toBeNull();
    expect(view.round!.nameAr.length).toBeGreaterThan(0);
    expect(view.round!.scoringHintAr.length).toBeGreaterThan(0);
  });

  it('marks the final round so players know the stakes', async () => {
    const ctx = await seatedRoom({ playerCount: 2, roundCount: 5, roundTypeId: 'mcq_race' });
    await ctx.engine.start(ctx.code, ctx.host.playerId);
    for (let i = 0; i < 4; i += 1) {
      ctx.clock.advance(INTRO_MS);
      await ctx.engine.tick();
      await answerRoundCorrectly(ctx.engine, ctx.store, ctx.code, ctx.ids);
      ctx.clock.advance(RESULT_MS);
      await ctx.engine.tick();
    }
    const last = (await ctx.store.get(ctx.code))!;
    const view = toView(last, last.players[0]!.id, await content.categories());
    expect(view.round!.isFinalRound).toBe(true);
    expect(view.round!.weight).toBe(2);
  });
});

describe('MemoryStore contract', () => {
  it('rejects a transition built on a stale version', async () => {
    const { store, engine } = setup();
    const created = await engine.createRoom('يوسف');

    await store.transition(created.state.code, null, (s) => s);
    await expect(store.transition(created.state.code, 0, (s) => s)).rejects.toThrow(
      VersionConflictError,
    );
  });

  it('keeps serving a room after a transition throws', async () => {
    const { store, engine } = setup();
    const created = await engine.createRoom('يوسف');

    await expect(
      store.transition(created.state.code, null, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // A rejected transition must not wedge the room's promise chain.
    await expect(store.transition(created.state.code, null, (s) => s)).resolves.toBeDefined();
  });

  it('bumps the version on every transition', async () => {
    const { store, engine } = setup();
    const created = await engine.createRoom('يوسف');
    const a = await store.transition(created.state.code, null, (s) => s);
    const b = await store.transition(created.state.code, null, (s) => s);
    expect(b.version).toBe(a.version + 1);
  });

  it('serializes concurrent transitions rather than interleaving them', async () => {
    const { store, engine } = setup();
    const created = await engine.createRoom('يوسف');

    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.transition(created.state.code, null, async (s) => {
          await new Promise((r) => setTimeout(r, 1));
          return { ...s, roundIndex: s.roundIndex + 1 };
        }),
      ),
    );

    const final = (await store.get(created.state.code))!;
    expect(final.roundIndex).toBe(-1 + 20);
    expect(final.version).toBe(20);
  });

  it('reaps rooms that have gone stale', async () => {
    const { store, engine, clock } = setup();
    const created = await engine.createRoom('يوسف');
    clock.advance(5 * 60 * 60 * 1_000);
    await engine.tick();
    expect(await store.get(created.state.code)).toBeNull();
  });
});

describe('teams', () => {
  it('splits the room into two sides when the host turns teams on', async () => {
    const { engine, code, host, store } = await seatedRoom({ playerCount: 4 });
    await engine.configure(code, host.playerId, { teams: true });

    const state = (await store.get(code))!;
    const sizes = new Map<string, number>();
    for (const player of state.players) {
      expect(player.teamId).not.toBeNull();
      sizes.set(player.teamId!, (sizes.get(player.teamId!) ?? 0) + 1);
    }
    // Even split, so nobody is outnumbered before a question is asked.
    expect([...sizes.values()].sort()).toEqual([2, 2]);
  });

  it('balances an odd room as evenly as it can', async () => {
    const { engine, code, host, store } = await seatedRoom({ playerCount: 5 });
    await engine.configure(code, host.playerId, { teams: true });

    const sizes = new Map<string, number>();
    for (const player of (await store.get(code))!.players) {
      sizes.set(player.teamId!, (sizes.get(player.teamId!) ?? 0) + 1);
    }
    expect([...sizes.values()].sort()).toEqual([2, 3]);
  });

  it('clears team assignments when teams are turned back off', async () => {
    const { engine, code, host, store } = await seatedRoom({ playerCount: 4 });
    await engine.configure(code, host.playerId, { teams: true });
    await engine.configure(code, host.playerId, { teams: false });

    expect((await store.get(code))!.players.every((p) => p.teamId === null)).toBe(true);
  });

  it('keeps team standings empty in a normal match', async () => {
    const { engine, code, host, ids, clock, store } = await seatedRoom({
      playerCount: 3,
      roundTypeId: 'mcq_race',
    });
    await engine.start(code, host.playerId);
    clock.advance(INTRO_MS);
    await engine.tick();
    await answerRoundCorrectly(engine, store, code, ids);

    expect((await store.get(code))!.teamStandings).toEqual([]);
  });

  it('ranks teams once a round resolves in a team match', async () => {
    const { engine, code, host, ids, clock, store } = await seatedRoom({
      playerCount: 4,
      roundTypeId: 'mcq_race',
    });
    await engine.configure(code, host.playerId, { teams: true });
    await engine.start(code, host.playerId);
    clock.advance(INTRO_MS);
    await engine.tick();
    await answerRoundCorrectly(engine, store, code, ids);

    const state = (await store.get(code))!;
    expect(state.teamStandings).toHaveLength(2);
    expect(state.teamStandings.every((t) => t.memberIds.length === 2)).toBe(true);
  });

  it('crowns the winning team at the podium', async () => {
    const { engine, code, host, ids, clock, store } = await seatedRoom({
      playerCount: 4,
      roundCount: 5,
      roundTypeId: 'mcq_race',
    });
    await engine.configure(code, host.playerId, { teams: true });
    await engine.start(code, host.playerId);

    // Only one side ever answers, so the result is decisive rather than a draw.
    const teamOf = new Map((await store.get(code))!.players.map((p) => [p.id, p.teamId]));
    const oneSide = ids.filter((id) => teamOf.get(id) === 'team-a');

    for (let round = 0; round < 5; round += 1) {
      clock.advance(INTRO_MS);
      await engine.tick();
      await answerRoundCorrectly(engine, store, code, oneSide);
      const mid = (await store.get(code))!;
      if (mid.phase === 'in_round') {
        clock.advance(getRoundType(mid.roundTypeId!).durationMs + 10);
        await engine.tick();
      }
      clock.advance(RESULT_MS);
      await engine.tick();
    }

    const state = (await store.get(code))!;
    expect(state.phase).toBe('podium');
    expect(state.winningTeamId).toBe('team-a');
  });

  it('passes team membership through to the round types', async () => {
    const { engine, code, host, clock, store } = await seatedRoom({
      playerCount: 4,
      roundTypeId: 'mcq_race',
    });
    await engine.configure(code, host.playerId, { teams: true });
    await engine.start(code, host.playerId);
    clock.advance(INTRO_MS);
    await engine.tick();

    // Cooperative types read `teamId` off the players they are handed; if the engine drops it
    // on the way in, they silently fall back to everybody being their own team.
    const state = (await store.get(code))!;
    const players = (state.roundState as { playerIds: string[] }).playerIds;
    expect(players).toHaveLength(4);
    expect(state.players.every((p) => p.teamId !== null)).toBe(true);
  });
});

describe('teams — joining an existing team match', () => {
  it('puts a late joiner on a side', async () => {
    const { engine, code, host, store } = await seatedRoom({ playerCount: 2 });
    await engine.configure(code, host.playerId, { teams: true });
    await engine.join(code, 'متأخر');

    const late = (await store.get(code))!.players.find((p) => p.nickname === 'متأخر')!;
    expect(late.teamId).not.toBeNull();
  });

  it('puts each late joiner on whichever side is smaller', async () => {
    const { engine, code, host, store } = await seatedRoom({ playerCount: 1 });
    await engine.configure(code, host.playerId, { teams: true });
    await engine.join(code, 'تاني');
    await engine.join(code, 'تالت');
    await engine.join(code, 'رابع');

    const sizes = new Map<string, number>();
    for (const player of (await store.get(code))!.players) {
      sizes.set(player.teamId!, (sizes.get(player.teamId!) ?? 0) + 1);
    }
    expect([...sizes.values()].sort()).toEqual([2, 2]);
  });
});
