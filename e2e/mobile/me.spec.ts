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
    await attachScreen(testInfo, page, 'me-balance');
  });

  test('skill toggle flips and sticks', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me' }).click();

    const skill = page.getByRole('switch', { name: 'web-search · Enabled' });
    await expect(skill).toHaveAttribute('aria-checked', 'true');
    await skill.click();
    await expect(skill).toHaveAttribute('aria-checked', 'false');
    await attachScreen(testInfo, page, 'me-skill-toggled');
    await skill.click();
    await expect(skill).toHaveAttribute('aria-checked', 'true');
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
