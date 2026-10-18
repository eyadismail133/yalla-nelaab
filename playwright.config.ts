import { defineConfig, devices } from '@playwright/test';

const remote = process.env.SMOKE_BASE_URL;
if (remote && new URL(remote).origin !== 'https://yalla-nelaab-20261016.web.app') {
  throw new Error('Remote smoke is restricted to the approved Firebase site');
}

export default defineConfig({
  testDir: './e2e',
  testMatch: remote ? 'smoke.spec.ts' : '**/*.spec.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: remote ?? 'http://127.0.0.1:4173',
    // Browser storage and RTDB traffic contain seat credentials. Never upload traces.
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
  },
  webServer: remote ? undefined : {
    command: 'npm run preview --workspace=@game/web -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
});
