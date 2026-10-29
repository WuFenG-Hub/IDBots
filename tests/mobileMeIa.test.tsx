import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import MeScreen from '../src/mobile/app/screens/MeScreen.tsx';
import {
  ME_ENTRIES,
  ME_ENTRY_GROUPS,
  meEntriesForGroup,
} from '../src/mobile/app/screens/me/registry.ts';
import { ProfilePage } from '../src/mobile/app/screens/me/ProfilePage.tsx';
import { TrafficPage } from '../src/mobile/app/screens/me/TrafficPage.tsx';
import { BotsPage } from '../src/mobile/app/screens/me/BotsPage.tsx';
import { BotEditPage } from '../src/mobile/app/screens/me/BotEditPage.tsx';
import { SkillsPage } from '../src/mobile/app/screens/me/SkillsPage.tsx';
import { MemoryPage } from '../src/mobile/app/screens/me/MemoryPage.tsx';
import { GeneralPage } from '../src/mobile/app/screens/me/GeneralPage.tsx';
import { AccountPage } from '../src/mobile/app/screens/me/AccountPage.tsx';
import { AboutPage } from '../src/mobile/app/screens/me/AboutPage.tsx';
import type { MobileUserIdentity } from '../src/mobile/app/hooks/useIdentity.ts';

/**
 * A6 settings IA rework (IA-PLAN v1): structural (SSR) pins for the entry
 * registry and every secondary page shell. Live-data behavior (summaries,
 * navigation, back/dirty flow) is covered by the Playwright suite
 * (e2e/mobile/me-ia.spec.ts) — renderToStaticMarkup never runs effects.
 */

test('registry: six list entries in three groups, profile/traffic ride the cards', () => {
  assert.deepEqual(
    ME_ENTRIES.map((entry) => entry.id),
    ['bots', 'skills', 'memory', 'general', 'account', 'about'],
  );
  assert.deepEqual(ME_ENTRY_GROUPS.map((group) => group.group), ['bots', 'general', 'account']);
  // The bots group renders without a heading (single row on top).
  assert.equal(ME_ENTRY_GROUPS[0].titleKey, null);
  assert.deepEqual(meEntriesForGroup('general').map((entry) => entry.id), ['skills', 'memory', 'general']);
  assert.deepEqual(meEntriesForGroup('account').map((entry) => entry.id), ['account', 'about']);
  // profile/traffic are NOT registry rows (card entries, IA-PLAN §2.1).
  assert.equal(ME_ENTRIES.some((entry) => entry.id === 'profile'), false);
  assert.equal(ME_ENTRIES.some((entry) => entry.id === 'traffic'), false);
  // Every entry carries a unique testid + title key; danger is reserved and unused.
  const testIds = new Set(ME_ENTRIES.map((entry) => entry.testId));
  assert.equal(testIds.size, ME_ENTRIES.length);
  for (const entry of ME_ENTRIES) {
    assert.match(entry.titleKey, /^mobile\.me\./);
    assert.notEqual(entry.danger, true);
  }
});

test('primary page renders user card, balance card and the registry rows', () => {
  const html = renderToStaticMarkup(React.createElement(MeScreen, { onOpenRecharge: () => undefined }));
  assert.match(html, /data-testid="user-card"/);
  assert.match(html, /data-testid="balance-card"/);
  for (const entry of ME_ENTRIES) {
    assert.match(html, new RegExp(`data-testid="${entry.testId}"`), entry.testId);
  }
  assert.match(html, /data-testid="me-group-bots"/);
  assert.match(html, /data-testid="me-group-general"/);
  assert.match(html, /data-testid="me-group-account"/);
  // Old flat sections are gone from the primary page.
  assert.doesNotMatch(html, /data-testid="bot-create"/);
});

const identityFixture: MobileUserIdentity = {
  id: 1,
  path: "m/44'/10001'/0'/0/0",
  mvc_address: 'mvc1abcdef',
  btc_address: 'btc1',
  doge_address: 'doge1',
  public_key: 'pk',
  chat_public_key: 'ck',
  chat_public_key_pin_id: null,
  metaid: 'metaid-1',
  globalmetaid: 'idq1abcdefghij',
  name: 'Owner',
  avatar: null,
  subsidy_state: 'claimed',
  subsidy_error: null,
  name_pin_id: null,
  avatar_pin_id: null,
  sync_state: 'synced',
  sync_error: null,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
};

test('profile page: explicit save disabled while clean, identity rows, sync ok', () => {
  const html = renderToStaticMarkup(
    React.createElement(ProfilePage, { identity: identityFixture, onBack: () => undefined }),
  );
  assert.match(html, /data-testid="me-page-profile"/);
  assert.match(html, /data-testid="profile-name"/);
  assert.match(html, /value="Owner"/);
  // Save starts disabled (clean form) — IA-PLAN §2.5 rule 1.
  assert.match(html, /data-testid="profile-save"[^>]*disabled/);
  assert.match(html, /idq1abcdefghij/);
  assert.match(html, /mvc1abcdef/);
  // Healthy sync: retry buttons must NOT render (IA-PLAN §4.3).
  assert.match(html, /data-sync-ok="yes"/);
  assert.doesNotMatch(html, /data-testid="profile-retry-sync"/);
});

test('profile page: abnormal sync renders retry actions and the error text', () => {
  const abnormal: MobileUserIdentity = {
    ...identityFixture,
    sync_state: 'partial',
    sync_error: 'mock sync error',
  };
  const html = renderToStaticMarkup(
    React.createElement(ProfilePage, { identity: abnormal, onBack: () => undefined }),
  );
  assert.match(html, /data-sync-ok="no"/);
  assert.match(html, /data-testid="profile-retry-sync"/);
  assert.match(html, /data-testid="profile-retry-subsidy"/);
  assert.match(html, /mock sync error/);
});

test('traffic page: pending-order strip absent without a stored order; sections present', () => {
  const html = renderToStaticMarkup(
    React.createElement(TrafficPage, { onBack: () => undefined, onOpenRecharge: () => undefined }),
  );
  assert.match(html, /data-testid="me-page-traffic"/);
  assert.match(html, /data-testid="traffic-free-grant"/);
  assert.match(html, /data-testid="traffic-usage-toggle"/);
  assert.match(html, /data-testid="traffic-tariff-toggle"/);
  assert.match(html, /data-testid="traffic-ledger-empty"/);
  assert.doesNotMatch(html, /data-testid="traffic-pending-order"/);
});

test('bots page renders the create action and list shell; bot edit page shells', () => {
  const bots = renderToStaticMarkup(
    React.createElement(BotsPage, { onBack: () => undefined, onOpenEdit: () => undefined }),
  );
  assert.match(bots, /data-testid="me-page-bots"/);
  assert.match(bots, /data-testid="bot-create"/);
  // SSR renders the loading state (effects never run); the empty state is an
  // effect-era view covered by e2e.
  assert.match(bots, /Loading/);

  const edit = renderToStaticMarkup(
    React.createElement(BotEditPage, { botId: null, onBack: () => undefined, onSaved: () => undefined }),
  );
  assert.match(edit, /data-testid="me-page-bot-edit"/);
});

test('remaining secondary pages render their shells', () => {
  assert.match(
    renderToStaticMarkup(React.createElement(SkillsPage, { onBack: () => undefined })),
    /data-testid="me-page-skills"/,
  );
  assert.match(
    renderToStaticMarkup(React.createElement(SkillsPage, { onBack: () => undefined })),
    /data-testid="skills-empty"/,
  );
  assert.match(
    renderToStaticMarkup(React.createElement(MemoryPage, { onBack: () => undefined })),
    /data-testid="me-page-memory"/,
  );
  assert.match(
    renderToStaticMarkup(React.createElement(MemoryPage, { onBack: () => undefined })),
    /data-testid="memory-row-memoryEnabled"/,
  );
  assert.match(
    renderToStaticMarkup(React.createElement(GeneralPage, { onBack: () => undefined })),
    /data-testid="me-page-general"/,
  );
  assert.match(
    renderToStaticMarkup(React.createElement(AccountPage, { onBack: () => undefined })),
    /data-testid="account-logout"/,
  );
  assert.match(
    renderToStaticMarkup(React.createElement(AccountPage, { onBack: () => undefined })),
    /data-testid="account-delete"/,
  );
  const about = renderToStaticMarkup(React.createElement(AboutPage, { onBack: () => undefined }));
  assert.match(about, /data-testid="about-link-terms"/);
  assert.match(about, /data-testid="about-link-privacy"/);
  assert.match(about, /data-testid="about-link-custody"/);
});
