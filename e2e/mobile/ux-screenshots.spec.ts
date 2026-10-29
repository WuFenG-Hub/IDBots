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
    await form.getByTestId('bot-tab-persona').click();
    await shot(page, 'edit-tab-persona');
    await form.getByTestId('bot-tab-chatSettings').click();
    await shot(page, 'edit-tab-chatsettings-skills-collapsed');
    await form.getByTestId('bot-skills-toggle').click();
    await shot(page, 'edit-tab-chatsettings-skills-expanded');
    await form.getByTestId('bot-tab-other').click();
    await shot(page, 'edit-tab-other');
    await page.getByRole('button', { name: '✕', exact: true }).click();

    // Create sheet: name+role only — the A5 rework removed the Advanced
    // area entirely (the old 'create-form-advanced-open' shot is obsolete).
    await page.getByTestId('bot-create').click();
    const createForm = page.getByTestId('bot-form');
    await expect(createForm.getByTestId('bot-create-guide')).toBeVisible();
    await expect(createForm.getByTestId('bot-advanced-toggle')).toHaveCount(0);
    await createForm.getByLabel('Name').fill('Demo Bot');
    await createForm.getByLabel('Role').fill('Demo role');
    await shot(page, 'create-form-name-role');
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

  test('captures the chat UE rework screens (A2 header, A4 groups, A3 picker)', async ({ page }) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Chat' }).click();
    await page.waitForTimeout(400);
    // A2: conversation header = bot avatar + title (switcher removed).
    await shot(page, 'a2-chat-header-avatar-title');

    // A4: session drawer grouped by day with per-row bot avatars.
    await page.getByRole('button', { name: 'Sessions' }).click();
    await expect(page.getByTestId('session-drawer-list')).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, 'a4-session-drawer-grouped');

    // A3: the new-chat bot picker with avatars, Twin first.
    await page.getByTestId('session-new-chat').click();
    await expect(page.getByTestId('bot-picker-list')).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, 'a3-new-chat-bot-picker');
  });
});
