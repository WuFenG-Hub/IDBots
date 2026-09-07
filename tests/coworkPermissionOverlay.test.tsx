import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import coworkReducer, {
  enqueuePendingPermission,
  setSessions,
} from '../src/renderer/store/slices/coworkSlice';
import CoworkPermissionOverlay from '../src/renderer/components/cowork/CoworkPermissionOverlay';
import { i18nService } from '../src/renderer/services/i18n';

/**
 * The global permission overlay is the answer to "owner confirmation dialog
 * invisible": prompts raised by sessions that are not the currently open chat
 * (background, IM-automation, hidden_from_session_list sessions) must render
 * somewhere answerable instead of silently burning the 60s watchdog.
 */

const permission = (overrides: Record<string, unknown> = {}) => ({
  sessionId: 'sess-hidden-1',
  toolName: 'Bash',
  toolInput: { command: 'npm install --save lodash', description: 'Install dependency' },
  requestId: 'req-1',
  toolUseId: null,
  ...overrides,
});

const sessionSummary = (overrides: Record<string, unknown> = {}) => ({
  id: 'sess-hidden-1',
  title: 'Deploy the staging bot',
  status: 'running' as const,
  pinned: false,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

function renderOverlay(permissions: Array<Record<string, unknown>>, inlineSessionId: string | null, sessions: Array<Record<string, unknown>> = []) {
  const store = configureStore({ reducer: { cowork: coworkReducer } });
  if (sessions.length > 0) {
    store.dispatch(setSessions(sessions as never));
  }
  permissions.forEach((entry) => store.dispatch(enqueuePendingPermission(entry as never)));
  return renderToStaticMarkup(
    <Provider store={store as never}>
      <CoworkPermissionOverlay inlineSessionId={inlineSessionId} />
    </Provider>,
  );
}

test('overlay renders nothing when no permission is pending', () => {
  assert.equal(renderOverlay([], 'sess-current'), '');
});

test('overlay renders the prompt of a background session with its title and tool input', () => {
  const markup = renderOverlay(
    [permission()],
    'sess-current',
    [sessionSummary()],
  );

  assert.ok(markup.includes('data-cowork-permission-overlay="true"'), 'overlay container rendered');
  assert.ok(markup.includes(i18nService.t('coworkGlobalPermissionTitle')), 'fixed title rendered');
  assert.ok(markup.includes('Deploy the staging bot'), 'owning session title rendered');
  assert.ok(markup.includes('Bash'), 'requested tool name rendered');
  assert.ok(markup.includes('npm install --save lodash'), 'tool input summary rendered');
  assert.ok(markup.includes(i18nService.t('coworkGlobalPermissionOpenSession')), 'open-session action rendered');
});

test('overlay skips the prompt already rendered inline for the open chat', () => {
  const markup = renderOverlay(
    [permission({ sessionId: 'sess-open', requestId: 'req-open' })],
    'sess-open',
  );
  assert.equal(markup, '');
});

test('overlay shows the first prompt that has no inline seat when several queue up', () => {
  const markup = renderOverlay(
    [
      permission({ sessionId: 'sess-open', requestId: 'req-open', toolInput: { command: 'echo inline' } }),
      permission({ sessionId: 'sess-hidden-1', requestId: 'req-hidden', toolInput: { command: 'echo overlay' } }),
    ],
    'sess-open',
  );

  assert.ok(markup.includes('echo overlay'), 'uncovered prompt rendered');
  assert.ok(!markup.includes('echo inline'), 'inline-covered prompt not duplicated');
});
