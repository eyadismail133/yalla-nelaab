import { summarizeQuestionSamples, type QuestionAggregate } from '../apps/web/src/net/question-telemetry.js';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const questions = JSON.parse(input || '{}') as Record<string, Record<string, QuestionAggregate>> | null;
const report = Object.entries(questions ?? {}).map(([questionId, samples]) => ({
  questionId, ...summarizeQuestionSamples(Object.values(samples)),
}));
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
