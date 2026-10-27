import { test, expect, attachScreen } from './fixtures';
import type { Page } from '@playwright/test';

interface OrderHarnessOptions {
  missingQrOnCall?: number;
  rejectCreate?: boolean;
}

async function installOrderHarness(page: Page, options: OrderHarnessOptions = {}): Promise<void> {
  await page.evaluate((opts) => {
    const bundle = window.electron.bundle;
    const savedOptions = JSON.parse(window.localStorage.getItem('idbots.fixture.rechargeHarnessOptions') ?? '{}');
    const effectiveOptions = { ...savedOptions, ...opts };
    window.localStorage.setItem('idbots.fixture.rechargeHarnessOptions', JSON.stringify(effectiveOptions));
    let createCalls = Number(window.localStorage.getItem('idbots.fixture.rechargeCreateCalls') ?? 0);
    const orderPlans = new Map<string, string>();
    let plans: NonNullable<Awaited<ReturnType<typeof bundle.getPlans>>['plans']> = [];
    const loadPlans = async () => {
      if (!plans.length) {
        const result = await bundle.getPlans();
        plans = result.plans ?? [];
      }
      return plans;
    };
    bundle.createOrder = async ({ planId }) => {
      createCalls += 1;
      window.localStorage.setItem('idbots.fixture.rechargeCreateCalls', String(createCalls));
      if (effectiveOptions.rejectCreate) throw new Error('fixture connection lost after create');
      const catalog = await loadPlans();
      const plan = catalog.find((entry) => entry.planId === planId);
      if (!plan) return { success: false, error: 'unknown fixture plan' };
      const orderId = `bo_harness_${createCalls}`;
      orderPlans.set(orderId, planId);
      return {
        success: true,
        order: {
          orderId,
          planId,
          payAmount: plan.payAmount,
          payCurrency: plan.payCurrency,
          trafficBytes: plan.trafficBytes,
          llmQuota: plan.llmQuota,
          gatewayParams: {
            qrCode: effectiveOptions.missingQrOnCall === createCalls ? '' : `https://qr.alipay.com/harness-${createCalls}`,
          },
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      };
    };
    bundle.getOrder = async ({ orderId }) => {
      const catalog = await loadPlans();
      const planId = orderPlans.get(orderId) ?? catalog[0].planId;
      const plan = catalog.find((entry) => entry.planId === planId) ?? catalog[0];
      return {
        success: true,
        order: {
          orderId,
          planId: plan.planId,
          status: 1,
          payAmount: plan.payAmount,
          payCurrency: plan.payCurrency,
          trafficBytes: plan.trafficBytes,
          llmQuota: plan.llmQuota,
        },
      };
    };
  }, options);
}

async function openRecharge(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Me', exact: true }).click();
  await page.getByRole('button', { name: 'Recharge', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Recharge', exact: true })).toBeVisible();
}

async function createCalls(page: Page): Promise<number> {
  return page.evaluate(() => Number(window.localStorage.getItem('idbots.fixture.rechargeCreateCalls') ?? 0));
}

test.describe('recharge recovery', () => {
  test('leaving and reloading restores the same order without creating another', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await installOrderHarness(page);
    await openRecharge(page);
    await page.getByRole('button', { name: /CNY 129\.00/ }).click();
    await expect(page.getByTestId('recharge-paying')).toHaveAttribute('data-order-id', 'bo_harness_1');

    await page.getByRole('button', { name: 'Back to plans' }).click();
    await expect(page.getByTestId('recharge-pending-order')).toBeVisible();
    expect(await createCalls(page)).toBe(1);
    await page.getByRole('button', { name: 'Resume current order' }).click();
    await page.getByRole('button', { name: 'Close' }).click();
    await openRecharge(page);
    await expect(page.getByTestId('recharge-paying')).toHaveAttribute('data-order-id', 'bo_harness_1');

    await page.reload();
    await installOrderHarness(page);
    await openRecharge(page);
    await expect(page.getByTestId('recharge-paying')).toHaveAttribute('data-order-id', 'bo_harness_1');
    expect(await createCalls(page)).toBe(1);
    const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem('idbots.mobile.bundleOrder.v1') ?? '{}'));
    expect(stored.qrCode).toBe('https://qr.alipay.com/harness-1');
    expect(stored.status).toBe(1);
    expect(stored.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    await attachScreen(testInfo, page, 'recharge-restored-order');
  });

  test('a missing QR on a new order never falls back to the previous order QR', async ({ page }) => {
    await page.goto('/app/');
    await installOrderHarness(page, { missingQrOnCall: 2 });
    await openRecharge(page);
    await page.getByRole('button', { name: /CNY 129\.00/ }).click();
    await expect(page.getByTestId('recharge-paying')).toHaveAttribute('data-order-id', 'bo_harness_1');

    await page.evaluate(() => {
      const key = 'idbots.mobile.bundleOrder.v1';
      const stored = JSON.parse(window.localStorage.getItem(key) ?? '{}');
      stored.status = 3;
      window.localStorage.setItem(key, JSON.stringify(stored));
    });
    await page.reload();
    await installOrderHarness(page);
    await openRecharge(page);
    await expect(page.getByTestId('recharge-success')).toBeVisible();
    await page.getByRole('button', { name: 'Back to plans' }).click();
    await page.getByRole('button', { name: /CNY 129\.00/ }).click();

    await expect(page.getByTestId('recharge-uncertain')).toBeVisible();
    expect(await createCalls(page)).toBe(2);
    const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem('idbots.mobile.bundleOrder.v1') ?? '{}'));
    expect(stored.orderId).toBe('bo_harness_2');
    expect(stored.qrCode).toBe('');
    expect(JSON.stringify(stored)).not.toContain('harness-1');
    await expect(page.getByTestId('recharge-qr')).toHaveCount(0);
  });

  test('an uncertain create stays blocked across navigation and reload', async ({ page }) => {
    await page.goto('/app/');
    await installOrderHarness(page, { rejectCreate: true });
    await openRecharge(page);
    await page.getByRole('button', { name: /CNY 129\.00/ }).click();
    await expect(page.getByTestId('recharge-uncertain')).toBeVisible();
    expect(await createCalls(page)).toBe(1);

    await page.getByRole('button', { name: 'Back to plans' }).click();
    await expect(page.getByRole('button', { name: /CNY 129\.00/ })).toBeDisabled();
    const attempt = await page.evaluate(() => JSON.parse(window.localStorage.getItem('idbots.mobile.bundleCreateAttempt.v1') ?? '{}'));
    expect(attempt.retryAfterMs).toBeGreaterThan(Date.now());

    await page.reload();
    await installOrderHarness(page);
    await openRecharge(page);
    await expect(page.getByTestId('recharge-uncertain')).toBeVisible();
    await expect(page.getByTestId('recharge-paying')).toHaveCount(0);
  });
});
