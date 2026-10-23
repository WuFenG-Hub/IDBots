import { test, expect, attachScreen } from './fixtures';

/**
 * AC-E-2 smoke spec: the mobile app on the REAL bridge (gateway client +
 * contract shim, no mock). The runner (scripts/run-mobile-e2e-gateway.mjs)
 * provides a standalone gateway fixture and sets E2E_GATEWAY; without it
 * these tests are skipped so the mock suite stays self-contained.
 */

const isGatewayRun = Boolean(process.env.E2E_GATEWAY);

test.describe('gateway-backed smoke', () => {
  test.skip(!isGatewayRun, 'requires the gateway harness (scripts/run-mobile-e2e-gateway.mjs)');

  test('handshake + welcome + chat send + streamed reply @gateway', async ({ page }, testInfo) => {
    await page.goto('/app/');

    // The real shim installed window.electron from the IPC contract and the
    // client facts next to it; the app shell mounts only after the welcome
    // frame passed the version guard.
    const facts = await page.evaluate(() => {
      const mobile = (window as unknown as { idbotsMobile?: Record<string, unknown> }).idbotsMobile;
      return { isMobile: mobile?.isMobile, hasMockControl: Boolean(mobile && 'mock' in mobile) };
    });
    expect(facts.isMobile).toBe(true);
    expect(facts.hasMockControl).toBe(false);

    await expect(page.getByRole('button', { name: 'Chat' })).toBeVisible();
    await attachScreen(testInfo, page, 'gateway-app-shell');

    await page.getByPlaceholder('Type a message…').fill('hello over the gateway');
    await page.getByRole('button', { name: 'Send' }).click();

    // The fixture streams the canned reply over cowork:stream:* events.
    await expect(page.getByText('This reply streamed over a real C2 gateway socket.')).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('Gateway fixture online.', { exact: true })).toBeVisible();
    await attachScreen(testInfo, page, 'gateway-streamed-reply');

    // The session lands in the drawer, hydrated over cowork:session:list.
    await page.getByRole('button', { name: 'Sessions' }).click();
    await expect(page.getByTestId('session-drawer-list')).toContainText('hello over the gateway', {
      timeout: 15_000,
    });
    await attachScreen(testInfo, page, 'gateway-session-drawer');
  });
});
