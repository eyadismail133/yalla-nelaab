import { expect, test } from '@playwright/test';
import { createRoom, identity, joinRoom, leaveRoom, openPlayer } from './helpers.js';

test('refresh, closed-tab recovery and repeated disconnects preserve the seat and command counters', async ({ browser }) => {
  const host = await openPlayer(browser);
  const guest = await openPlayer(browser);
  let page = guest.page;
  try {
    const code = await createRoom(host.page);
    await joinRoom(page, code);
    await page.getByRole('button', { name: 'أنا جاهز للعب ✓', exact: true }).click();
    await expect(page.getByRole('button', { name: 'لسه بجهز...', exact: true })).toBeVisible();
    const before = await identity(page);
    console.log('Recovery: refreshing cached session');
    for (let count = 0; count < 2; count += 1) {
      await page.reload();
      await expect(page.getByLabel('رابط الدعوة للغرفة')).toBeVisible();
      expect((await identity(page)).playerId).toBe(before.playerId);
    }
    await test.step('close the guest tab', async () => { await page.close(); });
    console.log('Recovery: restoring closed tab');
    page = await guest.context.newPage();
    await page.goto('/');
    console.log('Recovery: choosing stored seat');
    await page.getByRole('button', { name: /العودة للماتش الشغال/ }).click();
    console.log('Recovery: waiting for restored lobby');
    await expect(page.getByLabel('رابط الدعوة للغرفة')).toBeVisible();
    expect((await identity(page)).playerId).toBe(before.playerId);
    await page.getByRole('button', { name: 'أنا جاهز للعب ✓', exact: true }).click();
    await expect(page.getByRole('button', { name: 'لسه بجهز...', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'لسه بجهز...', exact: true }).click();
    await expect(page.getByRole('button', { name: 'أنا جاهز للعب ✓', exact: true })).toBeVisible();
    expect((await identity(page)).seq).toBeGreaterThan(before.seq);
    console.log('Recovery: repeating network interruptions');
    for (let count = 0; count < 2; count += 1) {
      await guest.context.setOffline(true);
      await expect(page.getByText('الاتصال قطع، بنحاول تاني...', { exact: true })).toBeVisible();
      await guest.context.setOffline(false);
      await expect(page.getByText('الاتصال قطع، بنحاول تاني...', { exact: true })).toBeHidden();
      await page.getByRole('button', { name: 'أنا جاهز للعب ✓', exact: true }).click();
      await expect(page.getByRole('button', { name: 'لسه بجهز...', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'لسه بجهز...', exact: true }).click();
      await expect(page.getByRole('button', { name: 'أنا جاهز للعب ✓', exact: true })).toBeVisible();
    }
    expect((await identity(page)).playerId).toBe(before.playerId);
    console.log('Recovery: leaving test room');
    await leaveRoom(page);
    await leaveRoom(host.page);
  } catch (error) {
    console.error('Recovery scenario failed:', error instanceof Error ? error.message : 'unknown error');
    throw error;
  } finally {
    await guest.context.setOffline(false);
    await guest.context.close();
    await host.context.close();
  }
});
