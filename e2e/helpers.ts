import { expect, type Browser, type Page } from '@playwright/test';

export async function openPlayer(browser: Browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    baseURL: process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:4173',
  });
  const page = await context.newPage();
  return { context, page };
}

export async function createRoom(page: Page, name = 'Release host') {
  await page.goto('/');
  await page.getByLabel('اسمك إيه؟').fill(name);
  await page.getByRole('button', { name: 'اعمل غرفة', exact: true }).click();
  const invite = page.getByLabel('رابط الدعوة للغرفة');
  await expect(invite).toBeVisible();
  const code = new URL((await invite.textContent())!).searchParams.get('code')!;
  expect(code).toMatch(/^[A-Z0-9]{5}$/);
  await expect(page.getByRole('img', { name: `كود QR للانضمام للغرفة ${code}`, exact: true })).toBeVisible();
  return code;
}

export async function joinRoom(page: Page, code: string, name = 'Release guest') {
  await page.goto(`/?code=${code}`);
  await page.getByLabel('اسمك إيه؟').fill(name);
  await page.getByRole('button', { name: 'يلا ندخل', exact: true }).click();
  await expect(page.getByLabel('رابط الدعوة للغرفة')).toBeVisible();
}

export async function leaveRoom(page: Page) {
  await page.getByRole('button', { name: 'ارجع للرئيسية', exact: true }).click();
  await expect(page.getByLabel('اسمك إيه؟')).toBeVisible();
}

export async function identity(page: Page) {
  return page.evaluate(() => {
    const session = JSON.parse(sessionStorage.getItem('party-game-session')!);
    const seat = sessionStorage.getItem('party-game-tab-seat-id')!;
    return { playerId: session.playerId as string, seat, seq: Number(localStorage.getItem(`party-game-seq-${seat}`) ?? 0) };
  });
}
