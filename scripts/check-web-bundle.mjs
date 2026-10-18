import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

const dist = new URL('../apps/web/dist/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('.vite/manifest.json', dist), 'utf8'));
const initial = new Set();
function visit(key) {
  if (initial.has(key)) return;
  initial.add(key);
  for (const imported of manifest[key].imports ?? []) visit(imported);
}
for (const [key, chunk] of Object.entries(manifest)) if (chunk.isEntry) visit(key);
const chunks = await Promise.all(Object.entries(manifest).filter(([, chunk]) => chunk.file.endsWith('.js')).map(async ([key, chunk]) => {
  const bytes = await readFile(new URL(chunk.file, dist));
  return { file: chunk.file, bytes: bytes.length, gzip: gzipSync(bytes).length, initial: initial.has(key) };
}));
const initialBytes = chunks.filter((chunk) => chunk.initial).reduce((sum, chunk) => sum + chunk.bytes, 0);
const initialGzip = chunks.filter((chunk) => chunk.initial).reduce((sum, chunk) => sum + chunk.gzip, 0);
const report = { initialBytes, initialGzip, initialGzipBudget: 230_000, chunkBudget: 500_000, chunks };
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (initialGzip > report.initialGzipBudget || chunks.some((chunk) => chunk.bytes > report.chunkBudget)) process.exitCode = 1;
