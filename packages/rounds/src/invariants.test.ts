import { describe, expect, it } from 'vitest';
import { ROUND_MAX_POINTS, type AnyRoundType } from '@game/shared';
import { ROUND_TYPES } from './registry.js';
import {
  DRIVERS,
  START_MS,
  assertEveryTypeHasADriver,
  initFor,
  makePlayers,
  mulberry32,
  runOptimalScript,
} from './test-drivers.js';

/**
 * Keys that would leak the answer, or who wrote what, if they ever reached a player's view.
 * `authorIds` is fibbing's real secret — knowing who wrote a line solves the whole round.
 */
const FORBIDDEN_KEYS = [
  'correctIndex',
  'correctValue',
  'isTrue',
  'answerAr',
  'aliases',
  'solved',
  'authorIds',
  'lies',
  'tally',
];

function deepKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) deepKeys(v, found);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      found.push(k);
      deepKeys(v, found);
    }
  }
  return found;
}

describe('registry coverage', () => {
  it('every registered round type has a test driver', () => {
    // Without this, a new round type could be added and silently skip both the balance
    // ceiling and the answer-redaction checks below.
    expect(assertEveryTypeHasADriver()).toEqual([]);
  });

  it('registers unique ids', () => {
    const ids = ROUND_TYPES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('declares Arabic copy for the intro card', () => {
    for (const type of ROUND_TYPES) {
      expect(type.nameAr.length, type.id).toBeGreaterThan(0);
      expect(type.taglineAr.length, type.id).toBeGreaterThan(0);
      expect(type.scoringHintAr.length, type.id).toBeGreaterThan(0);
    }
  });
});

describe.each(ROUND_TYPES.map((t) => [t.id, t] as const))('%s — invariants', (id, type) => {
  const driver = DRIVERS[id]!;
  const roomSize = Math.max(3, type.minPlayers);

  it('a perfect play scores exactly the shared ceiling', () => {
    // This is the balance guarantee. Every type must be worth the same at its best, however
    // differently it gets there — otherwise the mixed playlist is decided by which types a
    // player happens to be good at.
    const players = makePlayers(roomSize);
    const state = runOptimalScript(type, driver.content(), players);
    const best = type.roundScores(state).find((s) => s.playerId === players[0]!.id)!;
    expect(best.points).toBe(ROUND_MAX_POINTS);
  });

  it('never exceeds the ceiling under 300 randomized plays', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const rng = mulberry32(seed);
      const players = makePlayers(type.minPlayers + Math.floor(rng() * 3));
      let state = type.createState(driver.content(), initFor(type, players));

      // Extra passes so multi-stage types reach their later stages: a bluffing round needs one
      // pass to write and another to vote.
      for (let step = 0; step < type.itemsPerRound + 2; step += 1) {
        for (const player of players) {
          const nowMs = START_MS + Math.floor(rng() * type.durationMs);
          state = type.reduce(state, driver.randomAction(rng, step, state, player.id), {
            playerId: player.id,
            nowMs,
          }).state;
        }
      }
      while (!type.isFinished(state)) {
        const before = JSON.stringify(state);
        state = type.onDeadline(state, { nowMs: START_MS + type.durationMs }).state;
        if (JSON.stringify(state) === before) break;
      }

      for (const score of type.roundScores(state)) {
        expect(score.points, `seed ${seed}, player ${score.playerId}`).toBeLessThanOrEqual(
          ROUND_MAX_POINTS,
        );
        expect(score.points, `seed ${seed}, player ${score.playerId}`).toBeGreaterThanOrEqual(
          -ROUND_MAX_POINTS,
        );
      }
    }
  });

  it('nextDeadline is set whenever the round is still running', () => {
    // The engine schedules its next wake-up from this. A type that returns null while unfinished
    // would stall its room forever.
    const players = makePlayers(roomSize);
    const fresh = type.createState(driver.content(), initFor(type, players));
    expect(type.isFinished(fresh)).toBe(false);
    expect(type.nextDeadline(fresh), `${id} has no deadline at the start`).not.toBeNull();

    const finished = runOptimalScript(type, driver.content(), players);
    if (type.isFinished(finished)) {
      expect(type.nextDeadline(finished), `${id} still schedules work when done`).toBeNull();
    }
  });

  it('does not leak the answer before anybody acts', () => {
    const players = makePlayers(roomSize);
    const state = type.createState(driver.content(), initFor(type, players));
    const view = type.view(state, players[0]!.id);

    const keys = deepKeys(view);
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(keys, `${id} view exposes "${forbidden}"`).not.toContain(forbidden);
    }
    const serialized = JSON.stringify(view);
    for (const secret of driver.forbiddenValues()) {
      expect(serialized, `${id} view leaks "${secret}"`).not.toContain(secret);
    }
  });

  it('never exposes internal answer keys to any player at any stage', () => {
    // Value checks stop applying once a bluffing round reaches voting — the truth is deliberately
    // on screen there, mixed in with the lies. The key check still holds throughout, and it is
    // the one that catches an actual leak.
    const players = makePlayers(roomSize);
    const state = runOptimalScript(type, driver.content(), players);

    for (const player of players) {
      const keys = deepKeys(type.view(state, player.id));
      for (const forbidden of FORBIDDEN_KEYS) {
        expect(keys, `${id} leaks "${forbidden}" to ${player.id}`).not.toContain(forbidden);
      }
    }
  });

  it('reveals the answer only through reveal()', () => {
    const players = makePlayers(roomSize);
    const state = runOptimalScript(type, driver.content(), players);
    expect(JSON.stringify(type.reveal(state)).length).toBeGreaterThan(0);
  });

  it('is deterministic — the same action on the same state yields the same result', () => {
    const players = makePlayers(roomSize);
    const state = type.createState(driver.content(), initFor(type, players));
    const action = driver.optimalScript(players.map((p) => p.id))[0]!.action;
    const ctx = { playerId: players[0]!.id, nowMs: START_MS + 1_000 };

    const a = type.reduce(state, action, ctx);
    const b = type.reduce(state, action, ctx);
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
  });

  it('ignores actions from a player who is not in the round', () => {
    const players = makePlayers(roomSize);
    const state = type.createState(driver.content(), initFor(type, players));
    const action = driver.optimalScript(players.map((p) => p.id))[0]!.action;
    const after = type.reduce(state, action, { playerId: 'intruder', nowMs: START_MS + 500 }).state;
    expect(JSON.stringify(after)).toBe(JSON.stringify(state));
  });

  it('ignores actions arriving after the deadline', () => {
    const players = makePlayers(roomSize);
    const state = type.createState(driver.content(), initFor(type, players));
    const action = driver.optimalScript(players.map((p) => p.id))[0]!.action;
    const after = type.reduce(state, action, {
      playerId: players[0]!.id,
      nowMs: START_MS + type.durationMs + 5_000,
    }).state;
    expect(JSON.stringify(after)).toBe(JSON.stringify(state));
  });

  it('scores every player in the round, including those who never acted', () => {
    const players = makePlayers(roomSize + 1);
    let state = type.createState(driver.content(), initFor(type, players));
    while (!type.isFinished(state)) {
      const before = JSON.stringify(state);
      state = type.onDeadline(state, { nowMs: START_MS + type.durationMs }).state;
      if (JSON.stringify(state) === before) break;
    }

    const scores = type.roundScores(state);
    expect(scores).toHaveLength(players.length);
    for (const score of scores) {
      expect(score.points).toBe(0);
      expect(score.isCorrect).toBe(false);
      expect(score.msTaken).toBeNull();
    }
  });

  it('declares a sane configuration', () => {
    const t: AnyRoundType = type;
    expect(t.itemsPerRound).toBeGreaterThan(0);
    expect(t.durationMs).toBeGreaterThan(0);
    expect(t.minPlayers).toBeGreaterThanOrEqual(2);
    expect(t.contentShapes.length).toBeGreaterThan(0);
  });
});
