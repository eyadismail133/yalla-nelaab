import { writeFile, mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('records cold and warm startup under fixed mobile network and CPU conditions', async ({ browser }) => {
  const samples: object[] = [];
  for (let run = 0; run < 3; run += 1) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL: 'http://127.0.0.1:4173' });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 150, downloadThroughput: 1_600_000 / 8, uploadThroughput: 750_000 / 8,
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    try {
      for (const cache of ['cold', 'warm']) {
        const started = performance.now();
        await page.goto('/');
        await expect(page.getByRole('button', { name: 'اعمل غرفة', exact: true })).toBeEnabled();
        const readyMs = performance.now() - started;
        const navigation = await page.evaluate(() => ({
          domContentLoadedMs: (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).domContentLoadedEventEnd,
          firstContentfulPaintMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
          scriptBytes: performance.getEntriesByType('resource').filter((entry) => new URL(entry.name).pathname.endsWith('.js'))
            .reduce((sum, entry) => sum + (entry as PerformanceResourceTiming).encodedBodySize, 0),
        }));
        samples.push({ run, cache, readyMs, ...navigation });
      }
    } finally { await context.close(); }
  }
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/startup.json', JSON.stringify({
    browser: browser.version(), network: { latencyMs: 150, downloadBps: 1_600_000, uploadBps: 750_000, cpuSlowdown: 4 },
    notes: 'Desktop Chromium emulation; local Vite preview; warm = same-context navigation; encodedBodySize includes modulepreload; not physical-device or production ping evidence.', samples,
  }, null, 2));
});
