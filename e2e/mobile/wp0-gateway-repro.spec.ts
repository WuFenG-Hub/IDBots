import { test, expect } from './fixtures';

const isGatewayRun = Boolean(process.env.E2E_GATEWAY);

test.describe('WP1 gateway regressions', () => {
  test.skip(!isGatewayRun, 'requires the real gateway harness');

  test('running session is restored after full reload @gateway', async ({ page }) => {
    await page.goto('/app/');
    await page.getByPlaceholder('Type a message…').fill('restore this running session');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'restore this running session' })).toBeVisible({ timeout: 2000 });
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 2000 });
  });
});
