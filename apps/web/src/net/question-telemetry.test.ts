import { describe, expect, it } from 'vitest';
import type { RoomState } from '@game/shared';
import { questionSample, summarizeQuestionSamples } from './question-telemetry.js';

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
    expect(summarizeQuestionSamples(samples)).toEqual({ plays: 80, skipRate: 0.875, correctRate: 1, averageSolveMs: 300, suggestedDifficulty: 1, needsReview: true });
    expect(summarizeQuestionSamples(samples.slice(0, 1)).suggestedDifficulty).toBeNull();
  });
});
