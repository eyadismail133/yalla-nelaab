import { expect, test } from '@playwright/test';
import { identity, leaveRoom, openPlayer } from './helpers.js';

test('an old tab with a missing screen chunk can reload into its existing seat', async ({ browser }) => {
  const player = await openPlayer(browser);
  try {
    await player.page.route('**/assets/LobbyScreen-*.js', (route) => route.abort());
    await player.page.goto('/');
    await player.page.getByLabel('اسمك إيه؟').fill('Release stale tab');
    await player.page.getByRole('button', { name: 'اعمل غرفة', exact: true }).click();
    await expect(player.page.getByRole('alert')).toHaveText('تعذر تحميل الشاشة — حدّث الصفحة عشان ترجع لمقعدك.');
    const before = await identity(player.page);
    await player.page.unroute('**/assets/LobbyScreen-*.js');
    await player.page.getByRole('button', { name: 'تحديث الصفحة', exact: true }).click();
    await expect(player.page.getByLabel('رابط الدعوة للغرفة')).toBeVisible({ timeout: 25_000 });
    expect((await identity(player.page)).playerId).toBe(before.playerId);
    await expect(player.page.getByRole('heading', { name: 'اللاعيبة (1/8)', exact: true })).toBeVisible();
    await leaveRoom(player.page);
  } finally { await player.context.close(); }
});
