import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.env.SMOKE_BASE_URL !== 'https://yalla-nelaab-20261016.web.app') {
  throw new Error('Set SMOKE_BASE_URL to the approved live site before explicitly invoking smoke');
}
const run = spawnSync(process.execPath, [
  fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url)), 'test', 'e2e/smoke.spec.ts',
], { stdio: 'inherit' });
if (run.error) throw run.error;
process.exitCode = run.status ?? 1;
