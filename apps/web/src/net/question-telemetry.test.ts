import { describe, expect, it } from 'vitest';
import type { BooleanContent, RoomState } from '@game/shared';
import { isQuestionAggregate, questionSample, questionSamples, summarizeQuestionSamples } from './question-telemetry.js';
import { getRoundType, withQuestionMetrics } from '@game/rounds';

describe('anonymous question telemetry', () => {
  it('records aggregate counts and solve time without names, tokens, answers, or player IDs', () => {
    const state = {
      phase: 'round_result', roundTypeId: 'mcq_race', roundNo: 2,
      roundState: { item: { id: 'football_1' } },
      lastRoundScores: [
        { playerId: 'secret-player', points: 100, isCorrect: true, msTaken: 400 },
        { playerId: 'other-player', points: 0, isCorrect: false, msTaken: null },
      ],
    } as unknown as RoomState;
    const sample = questionSample(state, 'room_example_123');
    expect(sample?.questionId).toBe('football_1');
    expect(sample?.aggregate).toEqual({ roomId: 'room_example_123', roundNo: 2, plays: 2, answered: 1, correct: 1, totalSolveMs: 400 });
    expect(JSON.stringify(sample)).not.toContain('secret-player');
    expect(questionSample({ ...state, roundTypeId: 'quickfire_tf' }, 'room_example_123')).toBeNull();
  });

  it('calibrates a sufficient sample on the existing 1–5 scale and flags high skips for review', () => {
    const samples = Array.from({ length: 10 }, () => ({ roomId: 'room', roundNo: 1, plays: 8, answered: 1, correct: 1, totalSolveMs: 300 }));
    expect(summarizeQuestionSamples(samples)).toEqual({ plays: 80, skipRate: 0.875, correctRate: 1, averageSolveMs: 300, suggestedDifficulty: null, needsReview: true });
    expect(summarizeQuestionSamples(samples.slice(0, 1)).suggestedDifficulty).toBeNull();
    expect(summarizeQuestionSamples(samples.map((sample) => ({ ...sample, answered: 2, correct: 1 }))).suggestedDifficulty).toBe(3);
  });

  it('exports reached subquestions with stable retry/host-transfer keys and no actor identity', () => {
    const type = withQuestionMetrics(getRoundType('quickfire_tf'));
    const content: BooleanContent[] = Array.from({ length: 5 }, (_, i) => ({ id: `question_${i}`, categoryId: 'football', difficulty: 3, textAr: 'سؤال', shape: 'boolean', isTrue: true }));
    let roundState = type.createState(content, { players: [{ id: 'private-player', nickname: 'لاعب', connected: true, teamId: null }], startedAtMs: 1000, endsAtMs: 25000 });
    roundState = type.reduce(roundState, { kind: 'judge', index: 0, value: true }, { playerId: 'private-player', nowMs: 1500 }).state;
    const state = { phase: 'round_result', roundTypeId: 'quickfire_tf', roundNo: 7, roundState } as RoomState;
    const samples = questionSamples(state, 'room_example_123');
    expect(samples.map((sample) => [sample.questionId, sample.aggregate.answered])).toEqual([['question_0', 1], ['question_1', 0]]);
    expect(samples.every((sample) => sample.sampleId === 'room_example_123_7' && isQuestionAggregate(sample.aggregate))).toBe(true);
    expect(JSON.stringify(samples)).not.toContain('private-player');
    expect(questionSamples(JSON.parse(JSON.stringify(state)), 'room_example_123')).toEqual(samples);
    expect(questionSamples({ ...state, phase: 'lobby' }, 'room_example_123')).toEqual([]);
  });

  it('rejects impossible or identifying exported aggregates', () => {
    const sample = { roomId: 'room_example_123', roundNo: 1, plays: 2, answered: 1, correct: 1, totalSolveMs: 20 };
    expect(isQuestionAggregate(sample)).toBe(true);
    for (const invalid of [{ ...sample, answered: 3 }, { ...sample, correct: 2 }, { ...sample, totalSolveMs: -1 }, { ...sample, nickname: 'private' }, { ...sample, recordedAtMs: NaN }]) {
      expect(isQuestionAggregate(invalid)).toBe(false);
    }
  });
});
