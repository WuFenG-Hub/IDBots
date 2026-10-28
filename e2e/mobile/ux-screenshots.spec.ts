import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Evidence capture spec for the UX batch 2026-10-28 (owner mobile feedback).
 * Only runs when E2E_EVIDENCE_DIR is set (evidence mode); full suite runs
 * keep it skipped so default e2e runs are untouched.
 */
const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR ?? '';

test.describe('UX batch evidence screenshots (390x844 via iPhone 14 project)', () => {
  test.skip(!EVIDENCE_DIR, 'evidence mode requires E2E_EVIDENCE_DIR');

  async function shot(page: import('@playwright/test').Page, name: string, fullPage = false) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage });
  }

  test('captures Me list, edit tabs, create form and cleaned Me page', async ({ page }) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me', exact: true }).click();

    // Owner contract: Twin Bot is always row 1; the rest follow created_at ascending.
    const rows = page.locator('[data-testid^="bot-row-"]');
    await expect(rows.first()).toBeVisible();
    const firstRowName = await rows.first().innerText();
    expect(firstRowName).toContain('Twin Bot');
    await shot(page, 'me-bot-list');

    // Edit sheet: one shot per tab (Basic / Model / Skills / Other).
    const twinRow = page.locator('[data-testid^="bot-row-"]').filter({ hasText: 'Twin Bot' }).first();
    await twinRow.getByRole('button', { name: 'Edit · Twin Bot' }).click();
    const form = page.getByTestId('bot-form');
    await expect(form.getByTestId('bot-tab-model')).toBeVisible();
    await shot(page, 'edit-tab-basic');
    await form.getByTestId('bot-tab-model').click();
    await shot(page, 'edit-tab-model');
    await form.getByTestId('bot-tab-skills').click();
    await shot(page, 'edit-tab-skills-collapsed');
    await form.getByTestId('bot-skills-toggle').click();
    await shot(page, 'edit-tab-skills-expanded');
    await form.getByTestId('bot-tab-other').click();
    await shot(page, 'edit-tab-other');
    await page.getByRole('button', { name: '✕', exact: true }).click();

    // Create sheet: name+role only, guidance copy, advanced collapsed.
    await page.getByTestId('bot-create').click();
    const createForm = page.getByTestId('bot-form');
    await expect(createForm.getByTestId('bot-create-guide')).toBeVisible();
    await createForm.getByLabel('Name').fill('Demo Bot');
    await createForm.getByLabel('Role').fill('Demo role');
    await shot(page, 'create-form-name-role');
    await createForm.getByTestId('bot-advanced-toggle').click();
    await shot(page, 'create-form-advanced-open');
    await page.getByRole('button', { name: '✕', exact: true }).click();

    // Cleaned Me page after removing the skills block (skills hidden flag).
    await expect(page.locator('[data-testid^="bot-row-"]').first()).toBeVisible();
    // Scroll past the bot list so the frame shows Settings directly under it.
    await page.evaluate(() => {
      const scroller = document.querySelector('.overflow-y-auto');
      if (scroller instanceof HTMLElement) scroller.scrollTop = Math.round(scroller.scrollHeight / 2.6);
    });
    await page.waitForTimeout(300);
    await shot(page, 'me-after-skills-hidden');
  });
});
