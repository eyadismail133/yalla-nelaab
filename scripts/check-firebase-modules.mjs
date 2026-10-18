import assert from 'node:assert/strict';
import { build } from 'vite';

const result = await build({ root: 'apps/web', mode: 'firebase', logLevel: 'warn', build: { write: false } });
const outputs = Array.isArray(result) ? result : [result];
const modules = outputs.flatMap((output) => 'output' in output ? output.output.flatMap((chunk) => chunk.type === 'chunk' ? Object.keys(chunk.modules) : []) : []);
assert(modules.length > 0, 'Expected production modules');
const forbidden = modules.filter((id) => /node_modules[\\/](?:socket\.io-client|engine\.io-client|engine\.io-parser|socket\.io-parser)[\\/]/.test(id));
assert.equal(forbidden.length, 0, `Firebase build includes unused Socket.IO modules:\n${forbidden.join('\n')}`);
assert(!modules.some((id) => /(?:\/e2e\/|\.(?:emulator\.)?test\.[tj]s$)/.test(id)), 'Test code in production graph');
console.log('Firebase production graph contains no Socket.IO client modules.');
if (process.argv.includes('--profile')) {
  const chunks = outputs.flatMap((output) => 'output' in output ? output.output.filter((chunk) => chunk.type === 'chunk') : []);
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const initial = new Set();
  function visit(chunk) {
    if (initial.has(chunk.fileName)) return;
    initial.add(chunk.fileName);
    for (const name of chunk.imports) if (byName.has(name)) visit(byName.get(name));
  }
  for (const chunk of chunks) if (chunk.isEntry) visit(chunk);
  const groups = {};
  for (const chunk of chunks.filter((chunk) => initial.has(chunk.fileName))) {
    for (const [path, module] of Object.entries(chunk.modules)) {
      const group = path.includes('/packages/rounds/') ? 'rounds-and-catalog-reducers'
        : path.includes('/packages/shared/') ? 'shared-and-schemas'
        : path.includes('/@firebase/auth/') ? 'firebase-auth'
        : path.includes('/@firebase/database/') ? 'firebase-database'
        : path.includes('/apps/web/src/') ? 'web-app' : 'other-vendors';
      groups[group] = (groups[group] ?? 0) + module.renderedLength;
    }
  }
  console.log(JSON.stringify({ metric: 'Rollup rendered module lengths before final chunk minification; initial static import closure only, not wire/gzip bytes.', groups }, null, 2));
}
