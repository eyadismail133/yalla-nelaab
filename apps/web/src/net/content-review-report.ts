import { isQuestionAggregate, summarizeQuestionSamples, type QuestionAggregate } from './question-telemetry.js';

export interface ReviewItem { id: string; categoryId: string; shape: string; difficulty: number; textAr?: string }
export interface ReviewDecision { questionId: string; status: 'verified' | 'corrected' | 'needs-source'; reviewedAt: string; sources: string[]; rationale: string }

/** Offline only: never exposes room identifiers or individual samples in its report. */
export function contentReviewReport(input: unknown, catalog: ReviewItem[], decisions: ReviewDecision[], sinceMs: number) {
  if (input === null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a telemetry question tree');
  const items = new Map(catalog.map((item) => [item.id, item]));
  const ledger = new Map(decisions.map((decision) => [decision.questionId, decision]));
  const report = [];
  for (const [questionId, rawSamples] of Object.entries(input as Record<string, unknown>)) {
    const item = items.get(questionId);
    if (!item) throw new Error('Telemetry references an unknown question');
    if (!rawSamples || typeof rawSamples !== 'object' || Array.isArray(rawSamples)) throw new Error('Expected per-question samples');
    const cohorts = new Map<string, QuestionAggregate[]>();
    let excludedOlderSamples = 0;
    for (const [sampleId, sample] of Object.entries(rawSamples)) {
      if (!isQuestionAggregate(sample) || sampleId !== `${sample.roomId}_${sample.roundNo}`) throw new Error('Invalid aggregate or sample identity');
      if (sample.recordedAtMs !== undefined && sample.recordedAtMs < sinceMs) { excludedOlderSamples += 1; continue; }
      const mode = sample.roundTypeId ?? 'legacy_single';
      const cohort = cohorts.get(mode) ?? [];
      cohort.push(sample);
      cohorts.set(mode, cohort);
    }
    report.push({ questionId, categoryId: item.categoryId, shape: item.shape, textAr: item.textAr ?? null,
      currentDifficulty: item.difficulty, review: ledger.get(questionId) ?? null, excludedOlderSamples,
      cohorts: [...cohorts].map(([roundTypeId, samples]) => ({ roundTypeId, sampleCount: samples.length,
        undatedSamples: samples.filter((sample) => sample.recordedAtMs === undefined).length,
        ...summarizeQuestionSamples(samples) })) });
  }
  return report.sort((a, b) => a.questionId.localeCompare(b.questionId));
}
