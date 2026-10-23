import { test, expect, attachScreen } from './fixtures';

/**
 * Recharge flow (REQ-E-15) against the mock bundle channel: buy a plan →
 * paying screen → deterministic credit after the mock order delay → success
 * screen with the meters raised.
 */

test.describe('recharge', () => {
  test('buy → waiting → credited with meters rising', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me' }).click();
    await page.getByRole('button', { name: 'Recharge' }).click();

    await expect(page.getByText('Choose a plan')).toBeVisible();
    await attachScreen(testInfo, page, 'recharge-plans');

    await page.getByRole('button', { name: /CNY 129\.00/ }).click();
    const paying = page.getByTestId('recharge-paying');
    await expect(paying).toBeVisible();
    await expect(paying).toContainText('Waiting for the payment result');
    await attachScreen(testInfo, page, 'recharge-paying');

    // The mock order credits after orderCompleteDelayMs (10 s by default).
    const success = page.getByTestId('recharge-success');
    await expect(success).toBeVisible({ timeout: 45_000 });
    await expect(success).toContainText('Bundle credited');
    // New balance: 500 MiB + 10 GiB ≈ 10.5 GB traffic; 1.65M remaining +
    // 50M purchased = 51,650,000 tokens LLM (meters rose from the buy).
    await expect(success).toContainText('10.5 GB');
    await expect(success).toContainText(/51,650,000 tokens/);
    await attachScreen(testInfo, page, 'recharge-success');

    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('Balance')).toBeVisible();
  });
});
