import { test, expect } from './fixtures';

const isGatewayRun = Boolean(process.env.E2E_GATEWAY);

test.describe('gateway first-run journey', () => {
  test.skip(!isGatewayRun, 'requires the real gateway harness');

  test('first entry creates a Twin greeting through the real gateway @gateway', async ({ page }) => {
    await page.goto('/app/');
    await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
    await expect(page.getByText('Tell me what you want to accomplish')).toBeVisible();
  });
});
