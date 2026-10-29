import { test, expect, attachScreen } from './fixtures';

/**
 * Me tab (REQ-E-14), updated for the A6 settings IA rework (IA-PLAN v1):
 * the primary page is user card + balance card + entry registry; skills and
 * language now live on their secondary pages.
 */

test.describe('me screen', () => {
  test('balance card shows mock meters', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me' }).click();

    await expect(page.getByTestId('balance-card')).toBeVisible();
    await expect(page.getByText('Mock User')).toBeVisible();
    // Fixture meters: 500 MiB traffic balance, 1,650,000 tokens LLM remaining.
    await expect(page.getByText('500 MB')).toBeVisible();
    await expect(page.getByText(/1,650,000 tokens/)).toBeVisible();
    // F-16 regression guard: the LLM meter tile must render the payload
    // number, never the '\u2014' placeholder of a failed meters read.
    await expect(page.getByText(/1,650,000 tokens/)).not.toContainText('\u2014');
    await attachScreen(testInfo, page, 'me-balance');
  });

  test('the skills list lives on the Skills secondary page, not the primary (A6)', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me' }).click();

    // Primary: registry row only — the flat skill list never renders here.
    await expect(page.getByTestId('me-entry-skills')).toBeVisible();
    await expect(page.getByText('Mock User')).toBeVisible();
    await expect(page.getByText('web-search')).toHaveCount(0);

    // Secondary page carries the installed list with toggles.
    await page.getByTestId('me-entry-skills').click();
    await expect(page.getByTestId('me-page-skills')).toBeVisible();
    await expect(page.getByTestId('skills-row-web-search')).toBeVisible();
    await attachScreen(testInfo, page, 'me-skills-secondary');

    await page.getByTestId('me-secondary-back').click();
    await expect(page.getByTestId('me-primary-page')).toBeVisible();
  });

  test('language switch flips the UI language (General secondary page)', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me' }).click();

    await page.getByTestId('me-entry-general').click();
    await expect(page.getByTestId('me-page-general')).toBeVisible();
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
