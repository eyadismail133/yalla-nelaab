import { describe, expect, it } from 'vitest';
import { getRoundType } from './registry.js';
import { questionMetrics, withQuestionMetrics } from './question-metrics.js';
import { DRIVERS, START_MS, initFor, makePlayers, runOptimalScript } from './test-drivers.js';

describe('per-question outcomes', () => {
  it.each(['quickfire_tf', 'odd_one_out', 'bidding', 'land_grab', 'ladder', 'relay'])('%s attributes actual questions without changing gameplay or exposing private metrics', (id) => {
    const type = withQuestionMetrics(getRoundType(id));
    const players = makePlayers(4);
    const state = runOptimalScript(type, DRIVERS[id]!.content(), players, START_MS + 500);
    const metrics = questionMetrics(state);
    expect(metrics.length).toBeGreaterThan(0);
    expect(metrics.some((metric) => metric.correct > 0)).toBe(true);
    for (const metric of metrics) {
      expect(metric.plays).toBeGreaterThanOrEqual(metric.answered);
      expect(metric.answered).toBeGreaterThanOrEqual(metric.correct);
      expect(metric.totalSolveMs).toBeGreaterThanOrEqual(0);
      expect(Object.keys(metric).sort()).toEqual(['answered', 'correct', 'plays', 'questionId', 'totalSolveMs']);
    }
    expect(JSON.stringify(type.view(state, players[0]!.id))).not.toContain('contentTelemetry');
    expect(questionMetrics(JSON.parse(JSON.stringify(state)))).toEqual(metrics);
  });

  it('counts only reached sequential questions, preserves first response time, and ignores replay', () => {
    const type = withQuestionMetrics(getRoundType('quickfire_tf'));
    const content = DRIVERS.quickfire_tf!.content();
    let state = type.createState(content, initFor(type, makePlayers(2)));
    const action = { kind: 'judge', index: 0, value: true };
    state = type.reduce(state, action, { playerId: 'p1', nowMs: START_MS + 400 }).state;
    const restored = JSON.parse(JSON.stringify(state));
    const replay = type.reduce(restored, action, { playerId: 'p1', nowMs: START_MS + 900 }).state;
    expect(questionMetrics(replay)).toEqual(questionMetrics(state));
    const closed = type.onDeadline(replay, { nowMs: START_MS + type.durationMs }).state;
    expect(questionMetrics(closed).map((metric) => [metric.plays, metric.answered, metric.totalSolveMs])).toEqual([[2, 1, 400], [1, 0, 0]]);
    // Legacy in-progress snapshots have no per-question clock. Do not fabricate one.
    delete restored.contentTelemetry;
    expect(questionMetrics(type.reduce(restored, { ...action, index: 1 }, { playerId: 'p1', nowMs: START_MS + 1000 }).state)).toEqual([]);
  });

  it('starts bidding question clocks after bidding and excludes players who never bid', () => {
    const type = withQuestionMetrics(getRoundType('bidding'));
    const content = DRIVERS.bidding!.content();
    let state = type.createState(content, initFor(type, makePlayers(2)));
    state = type.reduce(state, { kind: 'bid', amount: 1 }, { playerId: 'p1', nowMs: START_MS + 1000 }).state;
    expect(questionMetrics(state)).toEqual([]);
    state = type.onDeadline(state, { nowMs: START_MS + 12000 }).state;
    state = type.reduce(state, { kind: 'answer', index: 0, choice: 0 }, { playerId: 'p1', nowMs: START_MS + 12500 }).state;
    expect(questionMetrics(state).map((metric) => [metric.plays, metric.answered, metric.totalSolveMs])).toEqual([[1, 1, 500], [1, 0, 0]]);
  });

  it('does not classify a contested land-grab cell as a skipped question for the losing reader', () => {
    const type = withQuestionMetrics(getRoundType('land_grab'));
    const content = DRIVERS.land_grab!.content();
    let state = type.createState(content, initFor(type, makePlayers(2)));
    for (const playerId of ['p1', 'p2']) state = type.reduce(state, { kind: 'open', cell: 0 }, { playerId, nowMs: START_MS + 100 }).state;
    state = type.reduce(state, { kind: 'answer', cell: 0, choice: (content[0] as { correctIndex: number }).correctIndex }, { playerId: 'p1', nowMs: START_MS + 500 }).state;
    expect(questionMetrics(state)).toEqual([{ questionId: content[0]!.id, plays: 1, answered: 1, correct: 1, totalSolveMs: 400 }]);
  });

  it('records a ladder bust as a wrong answer even though its round score has no decisive timestamp', () => {
    const type = withQuestionMetrics(getRoundType('ladder'));
    const content = DRIVERS.ladder!.content();
    let state = type.createState(content, initFor(type, makePlayers(2)));
    const wrong = ((content[0] as { correctIndex: number }).correctIndex + 1) % 4;
    state = type.reduce(state, { kind: 'answer', choice: wrong }, { playerId: 'p1', nowMs: START_MS + 300 }).state;
    expect(questionMetrics(state)).toEqual([{ questionId: content[0]!.id, plays: 2, answered: 1, correct: 0, totalSolveMs: 300 }]);
  });

  it('counts a relay timeout once per answering opportunity and exposes the next turn separately', () => {
    const type = withQuestionMetrics(getRoundType('relay'));
    const content = DRIVERS.relay!.content();
    let state = type.createState(content, initFor(type, makePlayers(4)));
    state = type.onDeadline(state, { nowMs: START_MS + 15000 }).state;
    expect(questionMetrics(state)).toHaveLength(4);
    expect(questionMetrics(state).every((metric) => metric.plays === 1 && metric.answered === 0 && metric.totalSolveMs === 0)).toBe(true);
  });
});
