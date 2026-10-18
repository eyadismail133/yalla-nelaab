import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test, type WebSocketRoute } from '@playwright/test';
import { createRoom, joinRoom, leaveRoom, openPlayer } from './helpers.js';

test('measures guest acknowledgement over delayed RTDB WebSocket frames', async ({ browser }) => {
  const host = await openPlayer(browser);
  const guest = await openPlayer(browser);
  let frames = 0;
  await guest.page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:9000\//, (socket) => {
    const server = socket.connectToServer();
    let open = true;
    const forward = async (target: WebSocketRoute, message: string | Buffer) => {
      frames += 1;
      await new Promise((resolve) => setTimeout(resolve, 75));
      if (open) target.send(message);
    };
    socket.onMessage((message) => forward(server, message));
    server.onMessage((message) => forward(socket, message));
    socket.onClose(() => { open = false; server.close(); });
    server.onClose(() => { open = false; socket.close(); });
  });
  try {
    const code = await createRoom(host.page);
    await joinRoom(guest.page, code);
    const samples = [];
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      await guest.page.getByRole('button', { name: 'أنا جاهز للعب ✓', exact: true }).click();
      await expect(guest.page.getByRole('button', { name: 'لسه بجهز...', exact: true })).toBeEnabled();
      samples.push(performance.now() - started);
      await guest.page.getByRole('button', { name: 'لسه بجهز...', exact: true }).click();
      await expect(guest.page.getByRole('button', { name: 'أنا جاهز للعب ✓', exact: true })).toBeEnabled();
    }
    expect(frames).toBeGreaterThan(0);
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/action-latency.json', JSON.stringify({
      browser: browser.version(), oneWayGuestFrameDelayMs: 75, samples,
      metric: 'Guest readiness click through acknowledged enabled UI; includes Playwright/browser scheduling. Both guest RTDB directions delayed; host local. Not production ping or REST RTT.',
    }, null, 2));
    await leaveRoom(guest.page);
    await leaveRoom(host.page);
  } finally { await guest.context.close(); await host.context.close(); }
});
