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

  test('multiple attachments survive reload and enter the final prompt in order', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Sessions' }).click();
    await page.getByRole('button', { name: 'New chat' }).click();
    await chooseFiles(page, [
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') },
      { name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('pdf') },
    ]);
    await expect(page.getByTestId('chat-attachment')).toHaveText(['notes.txt', 'report.pdf']);
    await page.getByPlaceholder('Type a message…').fill('compare documents');
    await page.reload();
    await expect(page.getByTestId('chat-attachment')).toHaveText(['notes.txt', 'report.pdf']);
    await expect(page.getByPlaceholder('Type a message…')).toHaveValue('compare documents');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByTestId('chat-user-message').last()).toHaveText(
      'compare documents\n\nInput file: /data/workspace/uploads/mock-1-notes.txt\nInput file: /data/workspace/uploads/mock-2-report.pdf',
    );
    await expect(page.getByTestId('chat-attachments')).toHaveCount(0);
    await attachScreen(testInfo, page, 'chat-attachments-submitted');
  });

  test('attachment-only follow-up can steer a running turn', async ({ page }) => {
    await page.goto('/app/');
    await sendMessage(page, 'start work');
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
    await chooseFiles(page, [{ name: 'follow-up.txt', mimeType: 'text/plain', buffer: Buffer.from('follow up') }]);
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByTestId('chat-user-message').last()).toHaveText(
      'Input file: /data/workspace/uploads/mock-1-follow-up.txt',
    );
  });

  test('removed pending uploads stay removed and typed errors preserve the text draft', async ({ page }) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Sessions' }).click();
    await page.getByRole('button', { name: 'New chat' }).click();
    await page.getByPlaceholder('Type a message…').fill('keep this draft');
    await chooseFiles(page, [{ name: 'fixture-slow.txt', mimeType: 'text/plain', buffer: Buffer.from('slow') }]);
    const pending = page.locator('[data-testid="chat-upload"][data-upload-status="uploading"]');
    await expect(pending).toHaveAttribute('data-upload-status', 'uploading');
    await page.getByRole('button', { name: 'Remove pending upload fixture-slow.txt' }).click();
    await expect(page.getByTestId('chat-upload')).toHaveCount(0);
    await expect(page.getByTestId('chat-attachment')).toHaveCount(0);

    await chooseFiles(page, [{ name: 'fixture-quota.txt', mimeType: 'text/plain', buffer: Buffer.from('quota') }]);
    await expect(page.getByRole('alert')).toContainText('Cloud storage is full');
    await expect(page.getByPlaceholder('Type a message…')).toHaveValue('keep this draft');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
  });
});

async function chooseFiles(
  page: import('@playwright/test').Page,
  files: Array<{ name: string; mimeType: string; buffer: Buffer }>,
): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add photo or file' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(files);
}
