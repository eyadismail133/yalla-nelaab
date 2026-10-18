import { readdir, readFile } from 'node:fs/promises';
import { contentReviewReport, type ReviewDecision, type ReviewItem } from '../apps/web/src/net/content-review-report.js';

let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 10 * 1024 * 1024) throw new Error('Export exceeds 10 MiB; use a per-question export');
}
const seed = new URL('../content/seed/', import.meta.url);
const catalog: ReviewItem[] = [];
for (const file of (await readdir(seed)).filter((name) => name.endsWith('.json'))) {
  const bank = JSON.parse(await readFile(new URL(file, seed), 'utf8'));
  for (const item of bank.questions) catalog.push({ ...item, categoryId: bank.category.id });
}
const decisions: ReviewDecision[] = JSON.parse(await readFile(new URL('../content/review-decisions.json', import.meta.url), 'utf8'));
const report = contentReviewReport(JSON.parse(input || '{}'), catalog, decisions, Date.now() - 90 * 24 * 60 * 60 * 1000);
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
