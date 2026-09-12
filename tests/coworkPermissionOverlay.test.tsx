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
  assert.ok(markup.includes(i18nService.t('coworkGlobalPermissionOpenSession')), 'open-session action rendered');

  // Since 8b41467e the compact overlay renders the tool name as the summary;
  // only AskUserQuestion prompts surface their tool input (first question).
  const askMarkup = renderOverlay(
    [permission({ toolName: 'AskUserQuestion', toolInput: { questions: [{ question: 'npm install --save lodash?' }] } })],
    'sess-current',
    [sessionSummary()],
  );
  assert.ok(askMarkup.includes('npm install --save lodash?'), 'tool input summary rendered');
});

test('overlay skips the prompt already rendered inline for the open chat', () => {
  const markup = renderOverlay(
    [permission({ sessionId: 'sess-open', requestId: 'req-open' })],
    'sess-open',
  );
  assert.equal(markup, '');
});

test('overlay keeps covering the open session when it is an A2A conversation (no inline seat)', () => {
  const markup = renderOverlay(
    [permission({ sessionId: 'sess-a2a', requestId: 'req-a2a' })],
    'sess-a2a',
    [sessionSummary({ id: 'sess-a2a', sessionType: 'a2a' })],
  );

  assert.ok(markup.includes('data-cowork-permission-overlay="true"'), 'A2A prompt stays answerable in the overlay');
  assert.ok(markup.includes('npm install --save lodash'), 'A2A prompt summary rendered');
});

test('overlay renders inline allow and deny actions', () => {
  const markup = renderOverlay(
    [permission()],
    'sess-current',
    [sessionSummary()],
  );

  assert.ok(markup.includes(i18nService.t('coworkDeny')), 'deny action rendered');
  assert.ok(markup.includes(i18nService.t('coworkApprovalAllowOnce')), 'allow-once action rendered for a plain tool prompt');
});

test('overlay renders the destructive allow label for safety approvals', () => {
  const safetyPermission = permission({
    toolName: 'AskUserQuestion',
    toolInput: {
      questions: [
        {
          header: '安全确认',
          question: '工具 "bash" 将执行删除操作。是否允许本次操作？',
          options: [
            { label: '允许本次操作', description: '仅允许当前这一次操作继续执行。' },
            { label: '拒绝本次操作', description: '拒绝当前操作。' },
          ],
        },
      ],
      answers: {},
      context: { requestedToolName: 'bash', requestedToolInput: { command: 'rm -rf ./dist' } },
    },
  });
  const markup = renderOverlay([safetyPermission], 'sess-current', [sessionSummary()]);

  assert.ok(markup.includes(i18nService.t('coworkApprovalAllowDelete')), 'destructive allow action rendered');
  assert.ok(markup.includes(i18nService.t('coworkDeny')), 'deny action rendered');
});

test('overlay shows the first prompt that has no inline seat when several queue up', () => {
  const markup = renderOverlay(
    [
      permission({ sessionId: 'sess-open', requestId: 'req-open', toolName: 'Read' }),
      permission({ sessionId: 'sess-hidden-1', requestId: 'req-hidden', toolName: 'Write' }),
    ],
    'sess-open',
  );

  assert.ok(markup.includes('Write'), 'uncovered prompt rendered');
  assert.ok(!markup.includes('Read'), 'inline-covered prompt not duplicated');
});
