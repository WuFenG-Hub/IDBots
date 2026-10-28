import { test, expect, attachScreen } from './fixtures';

function botRow(page: import('@playwright/test').Page, name: string) {
  return page.locator('[data-testid^="bot-row-"]').filter({ hasText: name });
}

test.describe('Bot lifecycle and configuration', () => {
  test('create, edit, per-Bot skills, model, chain state and enable/disable persist', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me', exact: true }).click();
    await page.getByTestId('bot-create').click();
    const form = page.getByTestId('bot-form');
    await form.getByPlaceholder('Name').fill('WP3 Worker');
    await form.getByPlaceholder('Role').fill('Research worker');
    await form.getByPlaceholder('Persona (soul)').fill('Careful and concise');
    await form.getByPlaceholder('Bio').fill('Created through the shared on-chain flow');
    await form.getByLabel('Default model').selectOption({ label: 'IDBots-Free · GLM Flash' });
    await form.getByLabel('Default reasoning effort').selectOption('high');
    await form.getByRole('checkbox', { name: 'web-search' }).check();
    await form.getByTestId('bot-save').click();

    const row = botRow(page, 'WP3 Worker');
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.locator('[data-testid^="bot-chain-"]')).toHaveAttribute('data-state', 'synced');
    await expect(row).toContainText('glm-flash');
    await attachScreen(testInfo, page, 'bot-created-on-chain');

    await row.getByRole('button', { name: 'Edit · WP3 Worker' }).click();
    const editForm = page.getByTestId('bot-form');
    await editForm.getByPlaceholder('Role').fill('Updated research worker');
    await editForm.getByRole('checkbox', { name: 'memory' }).check();
    await editForm.getByTestId('bot-save').click();
    await expect(page.getByText('Bot updated', { exact: true })).toBeVisible();

    await row.getByRole('button', { name: 'Edit · WP3 Worker' }).click();
    await expect(page.getByTestId('bot-form').getByPlaceholder('Role')).toHaveValue('Updated research worker');
    await expect(page.getByTestId('bot-form').getByRole('checkbox', { name: 'web-search' })).toBeChecked();
    await expect(page.getByTestId('bot-form').getByRole('checkbox', { name: 'memory' })).toBeChecked();
    await page.getByRole('button', { name: '✕', exact: true }).click();

    const enabled = row.getByRole('switch');
    await enabled.click();
    await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await row.getByRole('switch').click();
    await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  test('a locally saved pending Bot resumes without closing early or creating a duplicate', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me', exact: true }).click();
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
    await form.getByPlaceholder('Name').fill('WP3 Pending');
    await form.getByPlaceholder('Role').fill('Pending worker');
    await form.getByRole('checkbox', { name: 'web-search' }).check();
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
});
