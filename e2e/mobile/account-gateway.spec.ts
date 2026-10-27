import { test, expect, attachScreen } from './fixtures';

const isGatewayRun = Boolean(process.env.E2E_GATEWAY);

test.describe('gateway account and daily use', () => {
  test.skip(!isGatewayRun, 'requires the gateway harness');

  test('order recovery, exactly-once meters and the next chat use real C2 @gateway', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me', exact: true }).click();
    await page.getByRole('button', { name: 'Recharge', exact: true }).click();
    await page.getByRole('button', { name: /CNY 129\.00/ }).click();
    await expect(page.getByTestId('recharge-paying')).toHaveAttribute('data-order-id', 'gw-bundle-1');

    await page.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: 'Recharge', exact: true }).click();
    await expect(page.getByTestId('recharge-paying')).toHaveAttribute('data-order-id', 'gw-bundle-1');
    await page.reload();
    await page.getByRole('button', { name: 'Me', exact: true }).click();
    await page.getByRole('button', { name: 'Recharge', exact: true }).click();
    await expect(page.getByTestId('recharge-paying')).toHaveAttribute('data-order-id', 'gw-bundle-1');

    const success = page.getByTestId('recharge-success');
    await expect(success).toBeVisible({ timeout: 45_000 });
    await expect(success).toContainText('10.5 GB');
    await expect(success).toContainText(/51,650,000 tokens/);
    const before = await page.evaluate(async () => (await window.electron.bundle.getMeters()).meters);
    await page.evaluate(async () => {
      await window.electron.bundle.getOrder({ orderId: 'gw-bundle-1' });
      await window.electron.bundle.getOrder({ orderId: 'gw-bundle-1' });
    });
    const after = await page.evaluate(async () => (await window.electron.bundle.getMeters()).meters);
    expect(after.llm).toEqual(before.llm);

    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByPlaceholder('Type a message…').fill('next message after gateway recharge');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Gateway fixture online.', { exact: true })).toBeVisible({ timeout: 30_000 });
    await attachScreen(testInfo, page, 'gateway-recharge-next-chat');
  });

  test('settings and global memory persist without exposing provider secrets @gateway', async ({ page }, testInfo) => {
    try {
      await page.goto('/app/');
      await page.getByRole('button', { name: 'Me', exact: true }).click();
      const memory = page.getByRole('switch', { name: 'Enable memory' });
      await memory.click();
      await expect(memory).toHaveAttribute('aria-checked', 'false');
      await page.getByRole('button', { name: 'Dark', exact: true }).click();
      await expect(page.locator('html')).toHaveClass(/dark/);
      await page.getByRole('button', { name: '中文', exact: true }).click();
      await expect(page.getByText('语言', { exact: true })).toBeVisible();

      await page.reload();
      await page.getByRole('button', { name: '我的', exact: true }).click();
      await expect(page.getByText('语言', { exact: true })).toBeVisible();
      await expect(page.getByRole('switch', { name: '启用记忆' })).toHaveAttribute('aria-checked', 'false');
      await expect(page.locator('html')).toHaveClass(/dark/);
      const config = await page.evaluate(async () => {
        const [appConfig, coworkConfig] = await Promise.all([
          window.electron.store.get('app_config'),
          window.electron.cowork.getConfig(),
        ]);
        return { appConfig, coworkConfig: coworkConfig.config };
      });
      expect(config.appConfig.language).toBe('zh');
      expect(config.appConfig.theme).toBe('dark');
      expect(config.appConfig.providers['metaid-free'].apiKey).toBe('__redacted__');
      expect(config.appConfig.providers['metaid-free'].baseUrl).toBe('https://gateway.fixture/relay');
      expect(config.appConfig.bootstrap.languageInitialized).toBe(true);
      expect(config.coworkConfig.memoryEnabled).toBe(false);
      await attachScreen(testInfo, page, 'gateway-settings-persisted');
    } finally {
      await page.evaluate(async () => {
        await window.electron.store.set('app_config', { language: 'en', theme: 'system' });
        await window.electron.cowork.setConfig({ memoryEnabled: true });
      });
    }
  });
});
