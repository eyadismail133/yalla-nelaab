import { expect, test, type APIRequestContext } from '@playwright/test';
import { createRoom, joinRoom, leaveRoom, openPlayer } from './helpers.js';

// Read-only emulator admin access stays in test code; live smoke never imports this file.
async function canonical(request: APIRequestContext, code: string) {
  const base = 'http://127.0.0.1:9000';
  const options = { headers: { Authorization: 'Bearer owner' } };
  const mapping = await (await request.get(`${base}/codes/${code}.json?ns=demo-yalla-nelaab-default-rtdb`, options)).json();
  const snapshot = await (await request.get(`${base}/rooms/${mapping.roomId}/snapshot.json?ns=demo-yalla-nelaab-default-rtdb`, options)).json();
  return JSON.parse(snapshot.json).state;
}

test('private VAR, captain, spectator readiness and rematch work in the production build', async ({ browser, request }) => {
  const host = await openPlayer(browser);
  const guest = await openPlayer(browser);
  const spectator = await openPlayer(browser);
  try {
    const code = await createRoom(host.page);
    await joinRoom(guest.page, code);
    await host.page.getByRole('button', { name: /لعبة واحدة نفس اللعبة طول الماتش/ }).click();
    await host.page.getByRole('button', { name: /قصير ~5 جولة/ }).click();
    await host.page.getByRole('button', { name: 'ابدأ الماتش', exact: true }).click();
    await host.page.getByRole('button', { name: /الكابتن ×٢ —/ }).click();
    await expect(host.page.getByText('👑 الكابتن ×٢ شغّال للجولة دي', { exact: true })).toBeVisible();
    await guest.page.getByRole('button', { name: /الفار — احذف اختيارين غلط/ }).click();
    await expect(guest.page.getByText('📺 الفار استبعد الاختيار ده', { exact: true })).toHaveCount(2);
    await expect(host.page.getByText('📺 الفار استبعد الاختيار ده', { exact: true })).toHaveCount(0);
    await spectator.page.goto(`/?code=${code}`);
    await spectator.page.getByLabel('اسمك إيه؟').fill('Release spectator');
    await spectator.page.getByRole('button', { name: 'يلا ندخل', exact: true }).click();
    await expect(spectator.page.getByText('بتتفرج', { exact: true })).toBeVisible();
    for (let round = 1; round <= 5; round += 1) {
      const options = host.page.locator('button').filter({ has: host.page.locator('span').filter({ hasText: /^[أبجد]$/ }) });
      await expect(options).toHaveCount(4);
      const state = await canonical(request, code);
      await options.nth(state.roundState.item.correctIndex).click();
      await guest.page.locator('button').filter({ has: guest.page.locator('span').filter({ hasText: /^[أبجد]$/ }) })
        .filter({ hasNotText: 'الفار استبعد' }).first().click();
      await expect(spectator.page.getByRole('button', { name: /جاهز للجولة الجاية/ })).toHaveCount(0);
      await host.page.getByRole('button', { name: /جاهز للجولة الجاية/ }).click();
      await guest.page.getByRole('button', { name: /جاهز للجولة الجاية/ }).click();
    }
    await host.page.getByRole('button', { name: 'العب تاني', exact: true }).click();
    await expect(spectator.page.getByRole('button', { name: 'أنا جاهز للعب ✓', exact: true })).toBeVisible();
    await leaveRoom(spectator.page);
    await leaveRoom(guest.page);
    await leaveRoom(host.page);
  } finally {
    await spectator.context.close();
    await guest.context.close();
    await host.context.close();
  }
});
