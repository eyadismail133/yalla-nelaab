import { expect, test } from '@playwright/test';
import { createRoom, joinRoom, leaveRoom, openPlayer } from './helpers.js';

test('production UI creates, joins, acknowledges readiness and hands off host', async ({ browser }) => {
  const host = await openPlayer(browser);
  const guest = await openPlayer(browser);
  try {
    const code = await createRoom(host.page);
    await joinRoom(guest.page, code);
    await expect(host.page.getByText('Release guest', { exact: true })).toBeVisible();
    await guest.page.getByRole('button', { name: 'أنا جاهز للعب ✓', exact: true }).click();
    await expect(guest.page.getByRole('button', { name: 'لسه بجهز...', exact: true })).toBeVisible();
    await leaveRoom(host.page);
    await expect(guest.page.getByRole('heading', { name: 'إعدادات الماتش', exact: true })).toBeVisible({ timeout: 25_000 });
    await leaveRoom(guest.page);
  } finally {
    await host.context.close();
    await guest.context.close();
  }
});
