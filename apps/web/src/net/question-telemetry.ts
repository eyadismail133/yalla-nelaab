import type { Difficulty, RoomState } from '@game/shared';
import { questionMetrics } from '@game/rounds';

export interface QuestionAggregate {
  roomId: string;
  roundNo: number;
  plays: number;
  answered: number;
  correct: number;
  totalSolveMs: number;
  roundTypeId?: string;
  recordedAtMs?: number;
}

export function questionSamples(state: RoomState, roomId: string) {
  if (state.phase !== 'round_result') return [];
  const single = questionSample(state, roomId);
  const metrics = single ? [single] : questionMetrics(state.roundState)
    .filter((metric) => metric.plays > 0 && /^[A-Za-z0-9_-]{1,128}$/.test(metric.questionId))
    .map(({ questionId, ...counts }) => ({ questionId, sampleId: `${roomId}_${state.roundNo}`,
      aggregate: { roomId, roundNo: state.roundNo, ...counts } }));
  return metrics.map((sample) => ({ ...sample, aggregate: { ...sample.aggregate, roundTypeId: state.roundTypeId! } }));
}

export function isQuestionAggregate(value: unknown): value is QuestionAggregate {
  if (!value || typeof value !== 'object') return false;
  const sample = value as QuestionAggregate;
  const keys = ['roomId', 'roundNo', 'plays', 'answered', 'correct', 'totalSolveMs', 'roundTypeId', 'recordedAtMs'];
  return Object.keys(sample).every((key) => keys.includes(key))
    && typeof sample.roomId === 'string' && /^[A-Za-z0-9_-]{10,64}$/.test(sample.roomId)
    && Number.isInteger(sample.roundNo) && sample.roundNo >= 1
    && [sample.plays, sample.answered, sample.correct].every(Number.isInteger)
    && sample.plays >= 1 && sample.plays <= 8 && sample.answered >= 0 && sample.answered <= sample.plays
    && sample.correct >= 0 && sample.correct <= sample.answered
    && Number.isFinite(sample.totalSolveMs) && sample.totalSolveMs >= 0 && sample.totalSolveMs <= 1_200_000
    && (sample.roundTypeId === undefined || /^[a-z_]{1,32}$/.test(sample.roundTypeId))
    && (sample.recordedAtMs === undefined || Number.isSafeInteger(sample.recordedAtMs) && sample.recordedAtMs > 0);
}

export function questionSample(state: RoomState, roomId: string) {
  if (state.phase !== 'round_result' || !['mcq_race', 'numeric_guess'].includes(state.roundTypeId ?? '') || !state.lastRoundScores) return null;
  const questionId = (state.roundState as { item?: { id?: string } })?.item?.id;
  if (!questionId || !/^[A-Za-z0-9_-]{1,128}$/.test(questionId)) return null;
  const scores = state.lastRoundScores;
  const aggregate: QuestionAggregate = {
    roomId, roundNo: state.roundNo, plays: scores.length,
    answered: scores.filter((score) => score.msTaken !== null).length,
    correct: scores.filter((score) => score.isCorrect).length,
    totalSolveMs: scores.reduce((total, score) => total + (score.msTaken ?? 0), 0),
  };
  return { questionId, sampleId: `${roomId}_${state.roundNo}`, aggregate };
}

export function summarizeQuestionSamples(samples: QuestionAggregate[]) {
  const plays = samples.reduce((sum, sample) => sum + sample.plays, 0);
  const answered = samples.reduce((sum, sample) => sum + sample.answered, 0);
  const correct = samples.reduce((sum, sample) => sum + sample.correct, 0);
  const skipRate = plays ? (plays - answered) / plays : 0;
  const correctRate = answered ? correct / answered : 0;
  return {
    plays, skipRate, correctRate,
    averageSolveMs: answered ? samples.reduce((sum, sample) => sum + sample.totalSolveMs, 0) / answered : null,
    suggestedDifficulty: plays >= 50 && answered >= 20 ? Math.max(1, Math.min(5, Math.round(5 - correctRate * 4))) as Difficulty : null,
    needsReview: plays >= 50 && skipRate > 0.8,
  };
}
