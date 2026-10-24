import { test, expect, attachScreen } from './fixtures';

/**
 * Tasks tab (REQ-E-13): create an interval task, toggle it, and run it now —
 * the manual run shows in the per-task history.
 */

test.describe('scheduled tasks', () => {
  test('create, toggle, and run-now shows in history', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Tasks' }).click();

    await page.getByRole('button', { name: 'New task' }).click();
    const sheet = page.getByText('New scheduled task');
    await expect(sheet).toBeVisible();
    await page.getByPlaceholder('Task name').fill('E2E digest');
    await page.getByPlaceholder('Task prompt').fill('Summarize the last hour');
    await page.getByPlaceholder('Interval in minutes').fill('30');
    await attachScreen(testInfo, page, 'tasks-create-sheet');

    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('E2E digest')).toBeVisible();
    await attachScreen(testInfo, page, 'tasks-created');

    // Toggle off (the switch is the enabled indicator; the row has no text
    // badge); toggle back on.
    const toggle = page.getByRole('switch', { name: 'Enabled · E2E digest' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await attachScreen(testInfo, page, 'tasks-toggled-off');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    // Run now: the manual run lands in this task's history as running, then success.
    await page.getByRole('button', { name: 'Run now · E2E digest' }).click();
    await page.getByRole('button', { name: 'History · E2E digest' }).click();
    const manualRun = page.locator('div[data-testid^="task-runs-"]', { hasText: 'Manual' });
    await expect(manualRun).toBeVisible();
    await attachScreen(testInfo, page, 'tasks-run-history');
    await expect(manualRun).toContainText('Success', { timeout: 30_000 });
    await attachScreen(testInfo, page, 'tasks-run-success');
  });
});
