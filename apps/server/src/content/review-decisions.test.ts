import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { ReviewDecision } from '../../../web/src/net/content-review-report.js';

describe('football content review ledger', () => {
  it('preserves item identity and the reviewed source-backed corrections', async () => {
    const bank = JSON.parse(await readFile(new URL('../../../../content/seed/football.json', import.meta.url), 'utf8'));
    const decisions: ReviewDecision[] = JSON.parse(await readFile(new URL('../../../../content/review-decisions.json', import.meta.url), 'utf8'));
    const items = new Map<string, { isTrue?: boolean; textAr?: string; difficulty: number }>(bank.questions.map((item: { id: string }) => [item.id, item]));
    expect(new Set(decisions.map((decision) => decision.questionId)).size).toBe(decisions.length);
    for (const decision of decisions) {
      expect(items.has(decision.questionId)).toBe(true);
      expect(['verified', 'corrected', 'needs-source']).toContain(decision.status);
      expect(decision.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (decision.status !== 'needs-source') expect(decision.sources.length).toBeGreaterThan(0);
      for (const source of decision.sources) expect(new URL(source).protocol).toBe('https:');
    }
    expect(items.get('fb-bool-75')?.isTrue).toBe(false);
    expect(items.get('fb-mcq-158')?.textAr).toContain('لنصف نهائي');
    expect(items.get('fb-mcq-158')?.difficulty).toBe(3);
  });
});
