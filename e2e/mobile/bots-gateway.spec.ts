import { test, expect, attachScreen } from './fixtures';

const isGatewayRun = Boolean(process.env.E2E_GATEWAY);

test.describe('gateway Bot lifecycle', () => {
  test.skip(!isGatewayRun, 'requires the gateway harness');

  test('on-chain create, persistent configuration and next-session brain use real C2 @gateway', async ({ page }, testInfo) => {
    await page.goto('/app/');
    const existing = await page.evaluate(async () => window.electron.cowork.startSession({
      prompt: 'existing C2 session',
      metabotId: 2,
      model: 'c2-session-model',
      modelProvider: 'c2-session-provider',
    }));
    expect(existing.success).toBe(true);

    await page.getByRole('button', { name: 'Me', exact: true }).click();
    await page.getByTestId('bot-create').click();
    const form = page.getByTestId('bot-form');
    await form.getByPlaceholder('Name').fill('C2 Worker');
    await form.getByPlaceholder('Role').fill('Gateway research worker');
    await form.getByRole('button', { name: 'Advanced options' }).click();
    await form.getByTestId('bot-tab-model').click();
    await form.getByLabel('Default model').selectOption({ label: 'IDBots-Free · GLM Flash' });
    await form.getByLabel('Reasoning effort', { exact: true }).first().selectOption('high');
    await form.getByTestId('bot-tab-skills').click();
    await expect(form.getByTestId('bot-skills-toggle')).toHaveAttribute('aria-expanded', 'false');
    await form.getByTestId('bot-skills-toggle').click();
    await form.getByLabel('web-search').check();
    await form.getByTestId('bot-save').click();

    const row = page.locator('[data-testid^="bot-row-"]').filter({ hasText: 'C2 Worker' });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.locator('[data-testid^="bot-chain-"]')).toHaveAttribute('data-state', 'synced');
    const created = await page.evaluate(async () => {
      const result = await window.electron.metabot.list();
      return result.list.find((bot) => bot.name === 'C2 Worker');
    });
    expect(created.llm_id).toBe('glm-flash');
    expect(created.llm_provider).toBe('metaid-free');
    expect(created.llm_effort).toBe('high');
    expect(created.allow_chat_skills).toEqual(['web-search']);

    await row.getByRole('button', { name: 'Edit · C2 Worker' }).click();
    await page.getByTestId('bot-form').getByTestId('bot-tab-skills').click();
    await page.getByTestId('bot-form').getByTestId('bot-skills-toggle').click();
    await page.getByTestId('bot-form').getByRole('checkbox', { name: 'memory' }).check();
    await page.getByTestId('bot-save').click();
    await expect(page.getByText('Bot updated', { exact: true })).toBeVisible();

    const next = await page.evaluate(async (metabotId) => window.electron.cowork.startSession({ prompt: 'next C2 session', metabotId }), created.id);
    expect(next.session.model).toBe('glm-flash');
    expect(next.session.modelProvider).toBe('metaid-free');
    const reopened = await page.evaluate(async (id) => window.electron.cowork.getSession(id), existing.session.id);
    expect(reopened.session.model).toBe('c2-session-model');
    expect(reopened.session.modelProvider).toBe('c2-session-provider');

    await row.getByRole('switch').click();
    await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await page.reload();
    await page.getByRole('button', { name: 'Me', exact: true }).click();
    const restored = page.locator('[data-testid^="bot-row-"]').filter({ hasText: 'C2 Worker' });
    await expect(restored.locator('[data-testid^="bot-chain-"]')).toHaveAttribute('data-state', 'synced');
    await expect(restored.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    const persisted = await page.evaluate(async (id) => window.electron.metabot.get(id), created.id);
    expect(persisted.metabot.allow_chat_skills).toEqual(['web-search', 'memory']);
    await attachScreen(testInfo, page, 'gateway-bot-configured');
  });
});
