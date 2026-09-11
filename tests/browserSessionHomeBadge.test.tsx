import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import CoworkSessionItem from '../src/renderer/components/cowork/CoworkSessionItem';
import { i18nService } from '../src/renderer/services/i18n';
import type { CoworkSessionSummary } from '../src/renderer/types/cowork';

// Render-layer guard for the Bot Home history rows: a browser session
// (session_type = 'browser', created by the Bot Browser co-work panel) is now
// listed together with the local chats, so its row must be identifiable by a
// type badge. Other session types must NOT get that badge.

const baseSession = (overrides: Partial<CoworkSessionSummary> = {}): CoworkSessionSummary => ({
  id: 'session-1',
  title: 'Session',
  status: 'idle',
  pinned: false,
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});

const noop = () => {};

const renderItem = (session: CoworkSessionSummary): string =>
  renderToStaticMarkup(
    <CoworkSessionItem
      session={session}
      hasUnread={false}
      isActive={false}
      onSelect={noop}
      onDelete={noop}
      onTogglePin={noop}
      onRename={noop}
    />,
  );

const browserBadgeLabel = () => i18nService.t('coworkSessionTypeBrowser');

test('browser session rows carry the browser type badge', () => {
  const html = renderItem(baseSession({ sessionType: 'browser', title: 'Chat about metaapp://x' }));
  assert.ok(
    html.includes(browserBadgeLabel()),
    `browser row should render the "${browserBadgeLabel()}" badge`,
  );
});

test('standard sessions do not carry the browser badge', () => {
  const html = renderItem(baseSession({ sessionType: 'standard' }));
  assert.ok(!html.includes(browserBadgeLabel()), 'standard row must not show the browser badge');
});

test('a2a sessions keep their own presentation and get no browser badge', () => {
  const html = renderItem(baseSession({ sessionType: 'a2a', peerName: 'Remote Bot' }));
  assert.ok(!html.includes(browserBadgeLabel()), 'a2a row must not show the browser badge');
});

test('group_task sessions get no browser badge', () => {
  const html = renderItem(baseSession({ sessionType: 'group_task' }));
  assert.ok(!html.includes(browserBadgeLabel()), 'group_task row must not show the browser badge');
});
