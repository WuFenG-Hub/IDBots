import { test, expect, attachScreen, expectAppShell } from './fixtures';

/**
 * App shell (REQ-E-11): the three tabs mount from the lazy chunks and the
 * connection banner reflects the mock bridge's simulated reconnect.
 */

test.describe('app shell', () => {
  test('tabs mount and switch', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await expectAppShell(page);

    await page.getByRole('button', { name: 'Tasks' }).click();
    await expect(page.getByText('Scheduled tasks').first()).toBeVisible();
    await attachScreen(testInfo, page, 'shell-tasks-tab');

    await page.getByRole('button', { name: 'Me' }).click();
    await expect(page.getByText('Balance')).toBeVisible();
    await attachScreen(testInfo, page, 'shell-me-tab');

    await page.getByRole('button', { name: 'Chat' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
    await attachScreen(testInfo, page, 'shell-chat-tab');
  });

  test('offline banner follows simulateReconnect', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await expectAppShell(page);

    const banner = page.locator('[data-connection-state]');
    await expect(banner).toHaveAttribute('data-connection-state', 'online');

    await page.evaluate(() => {
      (window as unknown as { idbotsMobile: { mock?: { simulateReconnect: () => void } } }).idbotsMobile.mock?.simulateReconnect();
    });
    await expect(banner).toHaveAttribute('data-connection-state', 'reconnecting');
    await expect(page.getByText('Reconnecting…')).toBeVisible();
    await attachScreen(testInfo, page, 'shell-reconnecting-banner');

    await expect(banner).toHaveAttribute('data-connection-state', 'online', { timeout: 15_000 });
    await attachScreen(testInfo, page, 'shell-back-online');
  });
});
