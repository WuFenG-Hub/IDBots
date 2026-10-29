import { test, expect, attachScreen } from './fixtures';

/**
 * A6 settings IA rework (IA-PLAN v1) e2e coverage:
 * 1. entry registry rendering — groups, rows, live value summaries;
 * 2. secondary-page navigation — every entry pushes its page (incl. the
 *    card entries user→profile and balance→traffic, and the third-level
 *    bots→botEdit push);
 * 3. back behavior — top-bar back, browser history back (Android system
 *    back rides the same popstate), and the dirty-profile discard confirm.
 */

async function openMe(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/app/');
  await page.getByRole('button', { name: 'Me', exact: true }).click();
  await expect(page.getByTestId('me-primary-page')).toBeVisible();
}

test.describe('A6 settings IA', () => {
  test('registry renders the three groups with live summaries', async ({ page }, testInfo) => {
    await openMe(page);

    await expect(page.getByTestId('me-group-bots')).toBeVisible();
    await expect(page.getByTestId('me-group-general')).toBeVisible();
    await expect(page.getByTestId('me-group-account')).toBeVisible();

    // Row order inside each group (IA-PLAN §4.1).
    const generalGroup = page.getByTestId('me-group-general');
    await expect(generalGroup.getByTestId('me-entry-skills')).toBeVisible();
    await expect(generalGroup.getByTestId('me-entry-memory')).toBeVisible();
    await expect(generalGroup.getByTestId('me-entry-general')).toBeVisible();

    // Live summaries from the mock fixtures: 2 bots, 2 enabled skills,
    // memory on, language·theme combo, app version.
    await expect(page.getByTestId('me-entry-bots-summary')).toHaveText('2');
    await expect(page.getByTestId('me-entry-skills-summary')).toHaveText('2 enabled');
    await expect(page.getByTestId('me-entry-memory-summary')).toHaveText('On');
    await expect(page.getByTestId('me-entry-general-summary')).toContainText('·');
    await expect(page.getByTestId('me-entry-about-summary')).toHaveText('1.0.2-mobile.mock');

    // The user card carries the identity + sync badge.
    await expect(page.getByTestId('user-card')).toContainText('Mock User');
    await expect(page.getByTestId('user-card-sync-badge')).toHaveAttribute('data-state', 'ok');
    await attachScreen(testInfo, page, 'a6-primary-registry');
  });

  test('every registry entry pushes its secondary page and back pops it', async ({ page }) => {
    await openMe(page);
    const entries: Array<{ row: string; page: string }> = [
      { row: 'me-entry-bots', page: 'me-page-bots' },
      { row: 'me-entry-skills', page: 'me-page-skills' },
      { row: 'me-entry-memory', page: 'me-page-memory' },
      { row: 'me-entry-general', page: 'me-page-general' },
      { row: 'me-entry-account', page: 'me-page-account' },
      { row: 'me-entry-about', page: 'me-page-about' },
    ];
    for (const entry of entries) {
      await page.getByTestId(entry.row).click();
      await expect(page.getByTestId(entry.page)).toBeVisible();
      await page.getByTestId('me-secondary-back').click();
      await expect(page.getByTestId('me-primary-page')).toBeVisible();
    }
  });

  test('card entries: user card → profile, balance card → traffic; recharge stays one tap', async ({ page }) => {
    await openMe(page);

    await page.getByTestId('user-card').click();
    await expect(page.getByTestId('me-page-profile')).toBeVisible();
    await page.getByTestId('me-secondary-back').click();
    await expect(page.getByTestId('me-primary-page')).toBeVisible();

    await page.getByTestId('balance-card').click();
    await expect(page.getByTestId('me-page-traffic')).toBeVisible();
    await page.getByTestId('me-secondary-back').click();
    await expect(page.getByTestId('me-primary-page')).toBeVisible();

    // The recharge button remains directly on the balance card (硬门二).
    await expect(page.getByRole('button', { name: 'Recharge' })).toBeVisible();
  });

  test('bots list pushes the full botEdit third level and back returns to the list', async ({ page }, testInfo) => {
    await openMe(page);

    await page.getByTestId('me-entry-bots').click();
    await expect(page.getByTestId('me-page-bots')).toBeVisible();
    await expect(page.getByTestId('bot-row-1')).toContainText('Twin Bot');

    await page.getByTestId('bot-row-1').click();
    await expect(page.getByTestId('me-page-bot-edit')).toBeVisible();
    await expect(page.getByTestId('bot-form')).toBeVisible();
    await attachScreen(testInfo, page, 'a6-bot-edit-third-level');

    await page.getByTestId('me-secondary-back').click();
    await expect(page.getByTestId('me-page-bots')).toBeVisible();
    await page.getByTestId('me-secondary-back').click();
    await expect(page.getByTestId('me-primary-page')).toBeVisible();
  });

  test('browser history back (Android system back) pops the secondary page', async ({ page }) => {
    await openMe(page);

    await page.getByTestId('me-entry-about').click();
    await expect(page.getByTestId('me-page-about')).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('me-primary-page')).toBeVisible();
  });

  test('dirty profile asks before discarding; cancel keeps editing', async ({ page }, testInfo) => {
    await openMe(page);

    await page.getByTestId('user-card').click();
    await expect(page.getByTestId('me-page-profile')).toBeVisible();
    await page.getByTestId('profile-name').fill('Renamed User');

    // Dirty + top-bar back → confirm sheet, page stays mounted.
    await page.getByTestId('me-secondary-back').click();
    await expect(page.getByText('Discard changes?')).toBeVisible();
    await expect(page.getByTestId('me-page-profile')).toBeVisible();
    await attachScreen(testInfo, page, 'a6-profile-discard-confirm');

    // Keep editing: still on the profile page.
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page.getByTestId('me-page-profile')).toBeVisible();

    // Discard: back on the primary, name unchanged.
    await page.getByTestId('me-secondary-back').click();
    await expect(page.getByText('Discard changes?')).toBeVisible();
    await page.getByTestId('discard-confirm').click();
    await expect(page.getByTestId('me-primary-page')).toBeVisible();
    await expect(page.getByTestId('user-card')).toContainText('Mock User');
  });

  test('profile save round-trips through updateName and refreshes the user card', async ({ page }, testInfo) => {
    await openMe(page);

    await page.getByTestId('user-card').click();
    await page.getByTestId('profile-name').fill('Renamed User');
    await page.getByTestId('profile-save').click();
    await expect(page.getByTestId('profile-saved')).toBeVisible();
    await attachScreen(testInfo, page, 'a6-profile-saved');

    await page.getByTestId('me-secondary-back').click();
    await expect(page.getByTestId('me-primary-page')).toBeVisible();
    await expect(page.getByTestId('user-card')).toContainText('Renamed User');
  });

  test('traffic page renders usage, tariff, ledger and the free-grant claim', async ({ page }, testInfo) => {
    await openMe(page);

    await page.getByTestId('balance-card').click();
    await expect(page.getByTestId('me-page-traffic')).toBeVisible();
    await expect(page.getByTestId('traffic-usage-todayBytes')).toHaveText('3.0 MB');
    await expect(page.getByTestId('traffic-usage-weekBytes')).toHaveText('21.0 MB');

    // Ledger arrives from the mock (first page), empty state must NOT show.
    await expect(page.getByTestId('traffic-ledger-empty')).toHaveCount(0);

    // Free grant claims once, then the success line replaces the button.
    // (formatBytes is 1024-based: 10,000,000 bytes render as 9.5 MB — and
    // the balance tile above rises 500 MB → 510 MB.)
    await page.getByRole('button', { name: 'Claim free traffic' }).click();
    await expect(page.getByText(/9\.5 MB free traffic claimed\./)).toBeVisible();

    // Tariff explainer opens with the desktop-ported table.
    await page.getByTestId('traffic-tariff-toggle').click();
    await expect(page.getByTestId('traffic-tariff-table')).toBeVisible();
    await attachScreen(testInfo, page, 'a6-traffic-page');
  });
});
