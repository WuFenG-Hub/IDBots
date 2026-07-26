import test from 'node:test';
import assert from 'node:assert/strict';

import { filterVisiblePanelMessages } from '../src/renderer/features/botBrowser/BotBrowserCoworkPanel';
import type { CoworkMessage } from '../src/renderer/types/cowork';

const msg = (overrides: Partial<CoworkMessage>): CoworkMessage => ({
  id: Math.random().toString(36).slice(2),
  type: 'assistant',
  content: 'text',
  timestamp: 1000,
  ...overrides,
});

test('filterVisiblePanelMessages keeps user and final assistant messages', () => {
  const input = [
    msg({ type: 'user', content: 'hello' }),
    msg({ type: 'assistant', content: 'final answer' }),
  ];
  assert.equal(filterVisiblePanelMessages(input).length, 2);
});

test('filterVisiblePanelMessages hides tools, system, thinking, and delegation-internal noise', () => {
  const input = [
    msg({ type: 'tool_use', metadata: { toolName: 'bot_browser_tabs' } }),
    msg({ type: 'tool_result' }),
    msg({ type: 'system' }),
    msg({ type: 'assistant', metadata: { isThinking: true } }),
    msg({ type: 'assistant', metadata: { isDelegationInternal: true } }),
    msg({ type: 'user', metadata: { isDelegationInternal: true } }),
  ];
  assert.equal(filterVisiblePanelMessages(input).length, 0);
});
