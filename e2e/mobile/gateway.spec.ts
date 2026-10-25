import { test, expect, attachScreen } from './fixtures';

/**
 * AC-E-2 smoke spec: the mobile app on the REAL bridge (gateway client +
 * contract shim, no mock). The runner (scripts/run-mobile-e2e-gateway.mjs)
 * provides a standalone gateway fixture and sets E2E_GATEWAY; without it
 * these tests are skipped so the mock suite stays self-contained.
 */

const isGatewayRun = Boolean(process.env.E2E_GATEWAY);

/** Optional on-disk evidence copy for the F-11 acceptance trail. */
async function screenTo(page: import('@playwright/test').Page, testInfo: import('@playwright/test').TestInfo, name: string): Promise<void> {
  await attachScreen(testInfo, page, name);
  const dir = process.env.F11_EVIDENCE_DIR;
  if (dir) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.mkdirSync(dir, { recursive: true });
    const project = testInfo.project.name;
    fs.writeFileSync(path.join(dir, `${name}-${project}.png`), await page.screenshot());
  }
}

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

  test('F-11: chat file links render as same-origin /files downloads and really download @gateway', async ({ page }, testInfo) => {
    test.skip(process.env.GW_FIXTURE_FILE !== '1', 'requires the file-delivery fixture (GW_FIXTURE_FILE=1)');

    // Mirror of FIXTURE_FILE_BYTES in scripts/run-mobile-e2e-gateway.mjs.
    const expectedPayload = 'PK\x03\x04 gateway fixture docx payload 0123456789abcdef';

    await page.goto('/app/');
    await page.getByPlaceholder('Type a message…').fill('generate a report');
    await page.getByRole('button', { name: 'Send' }).click();

    // The fixture streams the reply with [gateway-e2e-report.docx](file://…).
    const link = page.getByRole('link', { name: /gateway-e2e-report\.docx/ });
    await expect(link).toBeVisible({ timeout: 30_000 });
    await screenTo(page, testInfo, 'f11-message-before-click');

    // F-11 criterion: zero container paths in the rendered surface — no
    // file:// anywhere in visible text or in any anchor href.
    const surface = await page.evaluate(() => ({
      text: document.body.innerText,
      hrefs: Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? ''),
    }));
    expect(surface.text).not.toContain('file://');
    expect(surface.text).not.toContain('/data/workspace');
    for (const href of surface.hrefs) {
      expect(href.startsWith('file://')).toBe(false);
    }

    // The link points at the same-origin signed route, not the tenant route.
    const href = await link.getAttribute('href');
    expect(href).toMatch(/^\/files\/[^/]+/);
    expect(href).not.toContain('/gateway/v1/');

    // Clicking really downloads the bytes the tenant generated.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      link.click(),
    ]);
    expect(download.suggestedFilename()).toBe('gateway-e2e-report.docx');
    const downloadedPath = await download.path();
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(downloadedPath, 'utf8')).toBe(expectedPayload);
    await screenTo(page, testInfo, 'f11-after-download');

    // Authorized fetch through the same route returns the docx content-type.
    const routeProbe = await page.evaluate(async (url: string) => {
      const res = await fetch(url, { credentials: 'include' });
      return {
        status: res.status,
        contentType: res.headers.get('content-type'),
        disposition: res.headers.get('content-disposition'),
        bytes: (await res.arrayBuffer()).byteLength,
      };
    }, href);
    expect(routeProbe.status).toBe(200);
    expect(routeProbe.contentType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(routeProbe.disposition).toMatch(/^attachment/);
    expect(routeProbe.bytes).toBe(expectedPayload.length);

    // The directory link (工作目录) never became an anchor.
    const dirLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a')).filter((a) => (a.textContent ?? '').includes('工作目录')).length,
    );
    expect(dirLinks).toBe(0);
  });
});
