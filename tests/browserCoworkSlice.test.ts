import test from 'node:test';
import assert from 'node:assert/strict';

import reducer, {
  setBrowserSession,
  addBrowserMessage,
  updateBrowserMessageContent,
  updateBrowserSessionStatus,
  setBrowserStreaming,
  clearBrowserSession,
} from '../src/renderer/store/slices/browserCoworkSlice';
import type { CoworkSession } from '../src/renderer/types/cowork';

const makeSession = (overrides: Partial<CoworkSession> = {}): CoworkSession => ({
  id: 'session-1',
  title: 'Browser chat',
  claudeSessionId: null,
  status: 'running',
  pinned: false,
  cwd: '/tmp',
  systemPrompt: '',
  executionMode: 'local',
  activeSkillIds: [],
  messages: [],
  createdAt: 1000,
  updatedAt: 1000,
  sessionType: 'browser',
  ...overrides,
});

test('setBrowserSession stores the session and derives streaming from status', () => {
  const running = reducer(undefined, setBrowserSession(makeSession()));
  assert.equal(running.currentSession?.id, 'session-1');
  assert.equal(running.isStreaming, true);

  const idle = reducer(undefined, setBrowserSession(makeSession({ status: 'completed' })));
  assert.equal(idle.isStreaming, false);
});

test('addBrowserMessage appends only for the open session and dedupes by id', () => {
  let state = reducer(undefined, setBrowserSession(makeSession()));
  state = reducer(state, addBrowserMessage({
    sessionId: 'other-session',
    message: { id: 'm0', type: 'user', content: 'ignored', timestamp: 1001 },
  }));
  assert.equal(state.currentSession?.messages.length, 0);

  state = reducer(state, addBrowserMessage({
    sessionId: 'session-1',
    message: { id: 'm1', type: 'user', content: 'hello', timestamp: 1002 },
  }));
  state = reducer(state, addBrowserMessage({
    sessionId: 'session-1',
    message: { id: 'm1', type: 'user', content: 'hello', timestamp: 1002 },
  }));
  assert.equal(state.currentSession?.messages.length, 1);
  assert.equal(state.currentSession?.updatedAt, 1002);
});

test('updateBrowserMessageContent patches content and metadata in place', () => {
  let state = reducer(undefined, setBrowserSession(makeSession({
    messages: [{ id: 'm1', type: 'assistant', content: 'partial', timestamp: 1002 }],
  })));
  state = reducer(state, updateBrowserMessageContent({
    sessionId: 'session-1',
    messageId: 'm1',
    content: 'full answer',
    metadata: { isStreaming: true },
  }));
  assert.equal(state.currentSession?.messages[0].content, 'full answer');
  assert.equal(state.currentSession?.messages[0].metadata?.isStreaming, true);
});

test('updateBrowserSessionStatus follows the open session only', () => {
  let state = reducer(undefined, setBrowserSession(makeSession()));
  state = reducer(state, updateBrowserSessionStatus({ sessionId: 'other', status: 'completed' }));
  assert.equal(state.currentSession?.status, 'running');
  assert.equal(state.isStreaming, true);

  state = reducer(state, updateBrowserSessionStatus({ sessionId: 'session-1', status: 'completed' }));
  assert.equal(state.currentSession?.status, 'completed');
  assert.equal(state.isStreaming, false);
});

test('setBrowserStreaming and clearBrowserSession control the stream flag and reset state', () => {
  let state = reducer(undefined, setBrowserSession(makeSession({ status: 'completed' })));
  state = reducer(state, setBrowserStreaming(true));
  assert.equal(state.isStreaming, true);

  state = reducer(state, clearBrowserSession());
  assert.equal(state.currentSession, null);
  assert.equal(state.isStreaming, false);
});
