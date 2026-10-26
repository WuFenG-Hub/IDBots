import { test, expect, attachScreen } from './fixtures';

/**
 * Chat tab (REQ-E-12): streamed reply, stop, the permission bottom sheet,
 * and the quota-exhausted card opening the recharge overlay.
 */

async function sendMessage(page: import('@playwright/test').Page, text: string): Promise<void> {
  const composer = page.getByPlaceholder('Type a message…');
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
}

test.describe('chat', () => {
  test('streamed reply renders markdown', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await sendMessage(page, 'hello');
    // The mock streams the canned reply token by token through the same
    // cowork:stream:* events the desktop renderer consumes.
    await expect(page.getByText('Every reply in this demo is streamed token by token')).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('Mock bridge online.', { exact: true })).toBeVisible();
    await attachScreen(testInfo, page, 'chat-streamed-reply');
  });

  test('stop aborts the in-flight stream', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await sendMessage(page, 'hello');
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
    await expect(page.getByText('Every reply in this demo is streamed token by token')).toBeHidden();
    await attachScreen(testInfo, page, 'chat-stopped');
  });

  test('permission request surfaces, answers, and completes the turn', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await sendMessage(page, 'please run the permission demo');

    const dialog = page.getByRole('dialog', { name: 'Tool permission requested' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/write_file/).first()).toBeVisible();
    await attachScreen(testInfo, page, 'chat-permission-sheet');

    await page.getByRole('button', { name: 'Allow once' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('the write completed')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('tool-call-list')).toHaveCount(0);
    await attachScreen(testInfo, page, 'chat-permission-approved');
  });

  test('quota card opens the recharge overlay', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await sendMessage(page, 'check my quota');

    const quotaCard = page.getByTestId('quota-card');
    await expect(quotaCard).toBeVisible({ timeout: 30_000 });
    await expect(quotaCard).toContainText('Free quota used up this week');
    await attachScreen(testInfo, page, 'chat-quota-card');

    await quotaCard.getByRole('button', { name: 'Recharge' }).click();
    await expect(page.getByText('Choose a plan')).toBeVisible();
    await attachScreen(testInfo, page, 'chat-recharge-overlay');

    await page.getByRole('button', { name: 'Close' }).click();
    await expect(quotaCard).toBeVisible();
  });
});
