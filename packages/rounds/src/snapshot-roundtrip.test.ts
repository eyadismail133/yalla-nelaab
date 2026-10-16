import { describe, expect, it, test } from 'vitest';
import type { ActionCtx, AnyRoundType, DeadlineCtx, PlayerRef } from '@game/shared';
import { ROUND_TYPES } from './registry.js';
import {
  DRIVERS,
  START_MS,
  assertEveryTypeHasADriver,
  initFor,
  makePlayers,
  mulberry32,
} from './test-drivers.js';

const ELIGIBLE_PLAYER_COUNTS = [2, 4, 8] as const;

function assertObservableParity(
  type: AnyRoundType,
  original: unknown,
  restored: unknown,
  players: PlayerRef[],
  stageLabel: string,
): void {
  expect(
    type.isFinished(restored),
    `${type.id} [${stageLabel}]: isFinished mismatch`,
  ).toBe(type.isFinished(original));

  expect(
    type.nextDeadline(restored),
    `${type.id} [${stageLabel}]: nextDeadline mismatch`,
  ).toBe(type.nextDeadline(original));

  for (const player of players) {
    const origView = type.view(original, player.id);
    const restoredView = type.view(restored, player.id);
    expect(
      restoredView,
      `${type.id} [${stageLabel}]: view mismatch for player ${player.id}`,
    ).toEqual(origView);
  }

  expect(
    type.roundScores(restored),
    `${type.id} [${stageLabel}]: roundScores mismatch`,
  ).toEqual(type.roundScores(original));

  expect(
    type.reveal(restored),
    `${type.id} [${stageLabel}]: reveal mismatch`,
  ).toEqual(type.reveal(original));
}

describe('snapshot roundtrip — registry coverage', () => {
  it('covers all 18 registered round types with valid drivers', () => {
    expect(ROUND_TYPES).toHaveLength(18);
    expect(assertEveryTypeHasADriver()).toEqual([]);
  });
});

const TEST_CASES = ROUND_TYPES.flatMap((type) =>
  ELIGIBLE_PLAYER_COUNTS.filter((count) => count >= type.minPlayers).map(
    (count) => [type.id, count, type] as const,
  ),
);

describe('round state JSON snapshot survival across stages', () => {
  test.each(TEST_CASES)(
    '%s with %i players survives snapshot serialization across all stages',
    (_typeId, playerCount, type) => {
      const driver = DRIVERS[type.id];
      expect(driver, `Driver must exist for ${type.id}`).toBeDefined();
      if (!driver) return;

      const players = makePlayers(playerCount);
      const playerIds = players.map((p) => p.id);
      const content = driver.content();
      const init = initFor(type, players);
      const deterministicRng = mulberry32(2);

      // --- Scripted Branch: optimal actions and post-deadline stage interleaving ---
      let orig = type.createState(content, init);
      let restored = JSON.parse(JSON.stringify(orig));

      expect(type.isFinished(orig)).toBe(false);
      assertObservableParity(type, orig, restored, players, 'initial stage');

      let nowMs = START_MS;
      for (const [stepIdx, scripted] of driver.optimalScript(playerIds).entries()) {
        nowMs += 500;
        let action = scripted.action;

        if ((action as { optionId?: string })?.optionId === '__lie_of_player_0__') {
          const options =
            (orig as { options?: Array<{ id: string; authorIds: string[] }> }).options ?? [];
          const mine = options.find((o) => o.authorIds.includes(playerIds[0]!));
          if (mine) action = { ...(action as object), optionId: mine.id };
        }

        const actionCtx: ActionCtx = { playerId: scripted.playerId, nowMs };
        const fork = JSON.parse(JSON.stringify(orig));
        const forkStep = type.reduce(fork, action, actionCtx);
        const origStep = type.reduce(orig, action, actionCtx);
        const restoredStep = type.reduce(restored, action, actionCtx);

        expect(restoredStep.events, `${type.id}: action events mismatch`).toEqual(origStep.events);
        expect(forkStep.events, `${type.id}: fork action events mismatch`).toEqual(origStep.events);

        orig = origStep.state;
        restored = JSON.parse(JSON.stringify(restoredStep.state));

        assertObservableParity(type, orig, restored, players, `action ${stepIdx}`);
        assertObservableParity(type, orig, forkStep.state, players, `fork action ${stepIdx}`);
      }

      // Advance deadlines and interleave driver actions whenever a new stage opens
      let deadlineStep = 0;
      while (!type.isFinished(orig) && deadlineStep < 20) {
        deadlineStep += 1;
        const nextDeadline = type.nextDeadline(orig) ?? (nowMs + type.durationMs);
        nowMs = Math.max(nowMs + 100, nextDeadline);
        const deadlineCtx: DeadlineCtx = { nowMs };

        const fork = JSON.parse(JSON.stringify(orig));
        const forkStep = type.onDeadline(fork, deadlineCtx);
        const origStep = type.onDeadline(orig, deadlineCtx);
        const restoredStep = type.onDeadline(restored, deadlineCtx);

        expect(restoredStep.events, `${type.id}: deadline events mismatch`).toEqual(origStep.events);
        expect(forkStep.events, `${type.id}: fork deadline events mismatch`).toEqual(origStep.events);

        orig = origStep.state;
        restored = JSON.parse(JSON.stringify(restoredStep.state));

        assertObservableParity(type, orig, restored, players, `deadline ${deadlineStep}`);
        assertObservableParity(type, orig, forkStep.state, players, `fork deadline ${deadlineStep}`);

        // Exercise late stage driver actions when stage changes (e.g. word_race voting)
        if (!type.isFinished(orig)) {
          const maxPasses = Math.max(type.itemsPerRound + 2, 4);
          for (let step = 0; step < maxPasses && !type.isFinished(orig); step += 1) {
            let anyChange = false;
            for (const player of players) {
              if (type.isFinished(orig)) break;
              nowMs += 250;
              const action = driver.randomAction(deterministicRng, step, orig, player.id);
              const actionCtx: ActionCtx = { playerId: player.id, nowMs };

              const oStep = type.reduce(orig, action, actionCtx);
              const rStep = type.reduce(restored, action, actionCtx);
              const f = JSON.parse(JSON.stringify(orig));
              const fStep = type.reduce(f, action, actionCtx);

              expect(rStep.events, `${type.id}: post-deadline action events mismatch`).toEqual(oStep.events);
              expect(fStep.events, `${type.id}: fork post-deadline action events mismatch`).toEqual(oStep.events);

              if (oStep.state !== orig) anyChange = true;

              orig = oStep.state;
              restored = JSON.parse(JSON.stringify(rStep.state));

              assertObservableParity(type, orig, restored, players, `post-deadline action (${player.id})`);
              assertObservableParity(type, orig, fStep.state, players, 'fork post-deadline action');
            }
            if (!anyChange && step > 0) break;
          }
        }
      }

      expect(type.isFinished(orig), `${type.id}: scripted must reach actual finish`).toBe(true);
      expect(type.isFinished(restored), `${type.id}: restored scripted must reach actual finish`).toBe(true);
      assertObservableParity(type, orig, restored, players, 'scripted final stage');

      // --- Randomized Branch: per-action & per-deadline event and observable parity ---
      const randRng = mulberry32(2);
      let randOrig = type.createState(content, init);
      let randRestored = JSON.parse(JSON.stringify(randOrig));
      let randNowMs = START_MS;

      assertObservableParity(type, randOrig, randRestored, players, 'randomized initial stage');

      let randCycle = 0;
      while (!type.isFinished(randOrig) && randCycle < 15) {
        randCycle += 1;
        const maxActionPasses = Math.max(type.itemsPerRound + 2, 5);

        for (let step = 0; step < maxActionPasses && !type.isFinished(randOrig); step += 1) {
          let anyChange = false;
          for (const player of players) {
            if (type.isFinished(randOrig)) break;
            randNowMs += 250;
            const action = driver.randomAction(randRng, step, randOrig, player.id);
            const actCtx: ActionCtx = { playerId: player.id, nowMs: randNowMs };

            const oStep = type.reduce(randOrig, action, actCtx);
            const rStep = type.reduce(randRestored, action, actCtx);
            const fork = JSON.parse(JSON.stringify(randOrig));
            const fStep = type.reduce(fork, action, actCtx);

            expect(rStep.events, `${type.id}: random action events mismatch`).toEqual(oStep.events);
            expect(fStep.events, `${type.id}: fork random action events mismatch`).toEqual(oStep.events);

            if (oStep.state !== randOrig) anyChange = true;

            randOrig = oStep.state;
            randRestored = JSON.parse(JSON.stringify(rStep.state));

            assertObservableParity(type, randOrig, randRestored, players, `random action cycle ${randCycle} (${player.id})`);
            assertObservableParity(type, randOrig, fStep.state, players, `fork random action cycle ${randCycle}`);
          }
          if (!anyChange && step > 0) break;
        }

        if (!type.isFinished(randOrig)) {
          const nextDl = type.nextDeadline(randOrig) ?? (randNowMs + type.durationMs);
          randNowMs = Math.max(randNowMs + 100, nextDl);
          const dlCtx: DeadlineCtx = { nowMs: randNowMs };

          const oStep = type.onDeadline(randOrig, dlCtx);
          const rStep = type.onDeadline(randRestored, dlCtx);
          const fork = JSON.parse(JSON.stringify(randOrig));
          const fStep = type.onDeadline(fork, dlCtx);

          expect(rStep.events, `${type.id}: random deadline events mismatch`).toEqual(oStep.events);
          expect(fStep.events, `${type.id}: fork random deadline events mismatch`).toEqual(oStep.events);

          randOrig = oStep.state;
          randRestored = JSON.parse(JSON.stringify(rStep.state));

          assertObservableParity(type, randOrig, randRestored, players, `random deadline cycle ${randCycle}`);
          assertObservableParity(type, randOrig, fStep.state, players, `fork random deadline cycle ${randCycle}`);
        }
      }

      expect(type.isFinished(randOrig), `${type.id}: randomized must reach actual finish`).toBe(true);
      expect(type.isFinished(randRestored), `${type.id}: restored randomized must reach actual finish`).toBe(true);
      assertObservableParity(type, randOrig, randRestored, players, 'randomized final stage');

      // Specific proof: verify populated voting states survive continuation before finish in word_race
      if (type.id === 'word_race') {
        const scriptedRejections = Object.keys((orig as { rejections: Record<string, unknown> }).rejections).length;
        const scriptedReady = Object.keys((orig as { ready: Record<string, unknown> }).ready).length;
        expect(scriptedRejections, 'word_race scripted voting rejections must be populated').toBeGreaterThan(0);
        expect(scriptedReady, 'word_race scripted voting ready must be populated').toBeGreaterThan(0);

        const randRejections = Object.keys((randOrig as { rejections: Record<string, unknown> }).rejections).length;
        const randReady = Object.keys((randOrig as { ready: Record<string, unknown> }).ready).length;
        expect(randRejections, 'word_race randomized voting rejections must be populated').toBeGreaterThan(0);
        expect(randReady, 'word_race randomized voting ready must be populated').toBeGreaterThan(0);
      }
    },
  );
});
