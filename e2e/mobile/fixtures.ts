import { test, expect } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';

/**
 * Shared helpers for the mobile e2e suite (REQ-E-26).
 */

/** Explicit per-screen screenshot attach (config keeps only-on-failure). */
export async function attachScreen(testInfo: TestInfo, page: Page, name: string): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
}

/** Waits for the app shell's bottom tab bar and returns the chat tab. */
export async function expectAppShell(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Chat' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tasks' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Me' })).toBeVisible();
}

export { test, expect };
