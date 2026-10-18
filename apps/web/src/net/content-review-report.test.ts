import { describe, expect, it } from 'vitest';
import { contentReviewReport } from './content-review-report.js';

const item = { id: 'q1', categoryId: 'football', shape: 'mcq', difficulty: 3, textAr: 'سؤال' };
const sample = { roomId: 'room_example_123', roundNo: 1, plays: 2, answered: 1, correct: 1, totalSolveMs: 500 };
describe('offline content review', () => {
  it('separates mode cohorts, dates old/legacy data, attaches sources, and removes room linkage', () => {
    const decision = { questionId: 'q1', status: 'verified' as const, reviewedAt: '2026-10-18', sources: ['https://www.fifa.com/'], rationale: 'Checked source' };
    const input = { q1: {
      room_example_123_1: sample,
      room_example_123_2: { ...sample, roundNo: 2, roundTypeId: 'ladder', recordedAtMs: 2000 },
      room_example_123_3: { ...sample, roundNo: 3, roundTypeId: 'ladder', recordedAtMs: 500 },
    } };
    const report = contentReviewReport(input, [item], [decision], 1000);
    expect(report[0]?.excludedOlderSamples).toBe(1);
    expect(report[0]?.cohorts.map((cohort) => [cohort.roundTypeId, cohort.plays, cohort.undatedSamples])).toEqual([['legacy_single', 2, 1], ['ladder', 2, 0]]);
    expect(report[0]?.review).toEqual(decision);
    expect(JSON.stringify(report)).not.toContain('room_example_123');
  });
  it('rejects unknown questions and aliased samples instead of double counting or trusting an export', () => {
    expect(() => contentReviewReport({ missing: {} }, [item], [], 0)).toThrow('unknown question');
    expect(() => contentReviewReport({ q1: { alias: sample } }, [item], [], 0)).toThrow('sample identity');
    expect(contentReviewReport(null, [item], [], 0)).toEqual([]);
  });
});
