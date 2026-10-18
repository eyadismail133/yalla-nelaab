import type { Difficulty, RoomState } from '@game/shared';

export interface QuestionAggregate {
  roomId: string;
  roundNo: number;
  plays: number;
  answered: number;
  correct: number;
  totalSolveMs: number;
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
    suggestedDifficulty: plays >= 50 && answered >= 1 ? Math.max(1, Math.min(5, Math.round(5 - correctRate * 4))) as Difficulty : null,
    needsReview: plays >= 50 && skipRate > 0.8,
  };
}
