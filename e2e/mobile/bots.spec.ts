import { test, expect, attachScreen } from './fixtures';

function botRow(page: import('@playwright/test').Page, name: string) {
  return page.locator('[data-testid^="bot-row-"]').filter({ hasText: name });
}

async function openMe(page: import('@playwright/test').Page) {
  await page.goto('/app/');
  await page.getByRole('button', { name: 'Me', exact: true }).click();
}

test.describe('Bot lifecycle and configuration', () => {
  test('create, edit, per-Bot skills, model, fallback brain, chain state and enable/disable persist', async ({ page }, testInfo) => {
    await openMe(page);
    await page.getByTestId('bot-create').click();
    const form = page.getByTestId('bot-form');
    await form.getByLabel('Name').fill('WP3 Worker');
    await form.getByLabel('Role').fill('Research worker');
    // Create mode: non-required fields live behind the Advanced section.
    await form.getByTestId('bot-advanced-toggle').click();
    await form.getByTestId('bot-tab-basic').click();
    await form.getByLabel('Persona (soul)').fill('Careful and concise');
    await form.getByLabel('Bio').fill('Created through the shared on-chain flow');
    await form.getByTestId('bot-tab-model').click();
    await form.getByLabel('Default model').selectOption({ label: 'IDBots-Free · GLM Flash' });
    await form.getByLabel('Reasoning effort', { exact: true }).first().selectOption('high');
    // Skills start collapsed (UX batch rule); expand before selecting.
    await form.getByTestId('bot-tab-skills').click();
    await expect(form.getByTestId('bot-skills-toggle')).toHaveAttribute('aria-expanded', 'false');
    await form.getByTestId('bot-skills-toggle').click();
    await form.getByLabel('web-search').check();
    await form.getByTestId('bot-save').click();

    const row = botRow(page, 'WP3 Worker');
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.locator('[data-testid^="bot-chain-"]')).toHaveAttribute('data-state', 'synced');
    await expect(row.getByTestId(/bot-role-/)).toHaveText('Research worker');
    await expect(row.getByTestId(/bot-avatar-/)).toBeVisible();
    await attachScreen(testInfo, page, 'bot-created-on-chain');

    await row.getByRole('button', { name: 'Edit · WP3 Worker' }).click();
    const editForm = page.getByTestId('bot-form');
    // Edit mode: Basic tab first, four-tab layout with role wiring.
    await expect(editForm.getByTestId('bot-tab-basic')).toHaveAttribute('aria-selected', 'true');
    await expect(editForm.getByTestId('bot-tab-model')).toBeVisible();
    await expect(editForm.getByTestId('bot-tab-skills')).toBeVisible();
    await expect(editForm.getByTestId('bot-tab-other')).toBeVisible();
    await editForm.getByLabel('Role').fill('Updated research worker');
    await editForm.getByTestId('bot-tab-model').click();
    await expect(editForm.getByLabel('Fallback model')).toBeVisible();
    await editForm.getByTestId('bot-tab-skills').click();
    await editForm.getByTestId('bot-skills-toggle').click();
    await editForm.getByLabel('memory').check();
    await editForm.getByTestId('bot-save').click();
    await expect(page.getByText('Bot updated', { exact: true })).toBeVisible();

    await row.getByRole('button', { name: 'Edit · WP3 Worker' }).click();
    await expect(page.getByTestId('bot-form').getByLabel('Role')).toHaveValue('Updated research worker');
    await page.getByTestId('bot-form').getByTestId('bot-tab-skills').click();
    await page.getByTestId('bot-form').getByTestId('bot-skills-toggle').click();
    await expect(page.getByTestId('bot-form').getByLabel('web-search')).toBeChecked();
    await expect(page.getByTestId('bot-form').getByLabel('memory')).toBeChecked();
    await page.getByRole('button', { name: '✕', exact: true }).click();

    const enabled = row.getByRole('switch');
    await enabled.click();
    await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await row.getByRole('switch').click();
    await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  test('a locally saved pending Bot resumes without closing early or creating a duplicate', async ({ page }, testInfo) => {
    await openMe(page);
    await page.evaluate(() => {
      const api = window.electron;
      const originalCreate = api.idbots.createMetaBotOnChain;
      const originalList = api.metabot.list;
      const originalResume = api.idbots.resumeMetabotSetup;
      let pending = true;
      let createCalls = 0;
      (window as unknown as { __botCreateCalls: number }).__botCreateCalls = 0;
      api.idbots.createMetaBotOnChain = async (input) => {
        createCalls += 1;
        (window as unknown as { __botCreateCalls: number }).__botCreateCalls = createCalls;
        const result = await originalCreate(input);
        return { ...result, chainSetupPending: true, chainError: 'fixture subsidy unavailable' };
      };
      api.metabot.list = async () => {
        const result = await originalList();
        if (pending && result.list) {
          for (const bot of result.list) {
            if (bot.name === 'WP3 Pending') {
              Object.assign(bot, {
                chain_sync_state: 'partial',
                chain_sync_pending_steps: ['name', 'chatpubkey', 'llm'],
                subsidy_state: 'failed',
                subsidy_error: 'fixture subsidy unavailable',
                metabot_info_pinid: null,
              });
            }
          }
        }
        return result;
      };
      api.idbots.resumeMetabotSetup = async (input) => {
        pending = false;
        return originalResume(input);
      };
    });

    await page.getByTestId('bot-create').click();
    const form = page.getByTestId('bot-form');
    await form.getByLabel('Name').fill('WP3 Pending');
    await form.getByLabel('Role').fill('Pending worker');
    await form.getByTestId('bot-advanced-toggle').click();
    await form.getByTestId('bot-tab-skills').click();
    await form.getByTestId('bot-skills-toggle').click();
    await form.getByLabel('web-search').check();
    await form.getByTestId('bot-save').click();
    await expect(page.getByTestId('bot-operation-result')).toHaveAttribute('data-state', 'local');
    await expect(form).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __botCreateCalls: number }).__botCreateCalls)).toBe(1);

    await page.getByRole('button', { name: '✕', exact: true }).click();
    const row = botRow(page, 'WP3 Pending');
    await expect(row.locator('[data-testid^="bot-chain-"]')).toHaveAttribute('data-state', 'partial');
    await row.getByRole('button', { name: 'Resume subsidy & publish' }).click();
    await expect(row.locator('[data-testid^="bot-chain-"]')).toHaveAttribute('data-state', 'synced');
    await expect(page.getByText('Chain state confirmed', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __botCreateCalls: number }).__botCreateCalls)).toBe(1);
    await attachScreen(testInfo, page, 'bot-resume-confirmed');
  });

  test('creating with only name and role succeeds (name+role-only path)', async ({ page }, testInfo) => {
    await openMe(page);
    await page.getByTestId('bot-create').click();
    const form = page.getByTestId('bot-form');
    // Guidance copy is visible on the create sheet.
    await expect(form.getByTestId('bot-create-guide')).toContainText('Twin Bot');
    // Advanced stays collapsed — only Name + Role are filled.
    await expect(form.getByTestId('bot-advanced-toggle')).toHaveAttribute('aria-expanded', 'false');
    await form.getByLabel('Name').fill('Minimal Bot');
    await form.getByLabel('Role').fill('Starter helper');
    await form.getByTestId('bot-save').click();

    const row = botRow(page, 'Minimal Bot');
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.locator('[data-testid^="bot-chain-"]')).toHaveAttribute('data-state', 'synced');
    await expect(row.getByTestId(/bot-role-/)).toHaveText('Starter helper');
    // Skills stay collapsed in a fresh edit sheet opened from the row.
    await row.getByRole('button', { name: 'Edit · Minimal Bot' }).click();
    await expect(page.getByTestId('bot-form').getByTestId('bot-skills-toggle')).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('button', { name: '✕', exact: true }).click();
    await attachScreen(testInfo, page, 'bot-create-name-role-only');
  });
});
