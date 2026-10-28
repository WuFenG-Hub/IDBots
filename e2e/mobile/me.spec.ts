import { test, expect, attachScreen } from './fixtures';

/**
 * Me tab (REQ-E-14): balance card backed by the mock meters, skill toggles,
 * and the language switch flipping the whole UI to Chinese.
 */

test.describe('me screen', () => {
  test('balance card shows mock meters', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me' }).click();

    await expect(page.getByText('Balance')).toBeVisible();
    await expect(page.getByText('Mock User')).toBeVisible();
    // Fixture meters: 500 MiB traffic balance, 1,650,000 tokens LLM remaining.
    await expect(page.getByText('500 MB')).toBeVisible();
    await expect(page.getByText(/1,650,000 tokens/)).toBeVisible();
    // F-16 regression guard: the LLM meter tile must render the payload
    // number, never the '\u2014' placeholder of a failed meters read.
    const llmTile = page.locator('div.rounded-xl').filter({ hasText: 'LLM' }).first();
    await expect(llmTile).toContainText(/[\d,]+ tokens/);
    await expect(llmTile).not.toContainText('\u2014');
    await attachScreen(testInfo, page, 'me-balance');
  });

  test('skills section stays hidden on the Me page (UX batch 2026-10-28)', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me' }).click();

    // The reversible hide leaves no blank gap: Settings follows MetaBots directly.
    await expect(page.getByText('Skills', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Mock User')).toBeVisible();
    await expect(page.getByText('web-search')).toHaveCount(0);
    await attachScreen(testInfo, page, 'me-skills-hidden');
  });

  test('language switch flips the UI language', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me' }).click();

    await page.getByRole('button', { name: '中文' }).click();
    // The settings section subscribes to the i18n service and re-renders at
    // once; switching tabs then re-renders the shell's tab bar in zh.
    await expect(page.getByText('语言', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Tasks' }).click();
    await expect(page.getByRole('button', { name: '任务', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '我的', exact: true })).toBeVisible();
    await attachScreen(testInfo, page, 'me-language-zh');
  });
});
