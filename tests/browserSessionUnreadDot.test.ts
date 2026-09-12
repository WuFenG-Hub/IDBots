import test from 'node:test';
import assert from 'node:assert/strict';

import reducer, {
  setBrowserOpenSessionId,
  setSessions,
  deleteSession,
  addMessage,
  updateMessageContent,
} from '../src/renderer/store/slices/coworkSlice';
import type { CoworkMessage, CoworkSessionSummary } from '../src/renderer/types/cowork';

/**
 * Unread (notification dot) bookkeeping for Bot Browser co-work sessions.
 *
 * Browser sessions live in the Bot Browser panel, whose current-session
 * pointer is browserCowork.currentSession — never cowork.currentSessionId.
 * The cowork slice therefore mirrors that pointer via browserOpenSessionId
 * (kept in lockstep by browserCoworkService.applySession) so browser
 * conversations get the same unread semantics as standard cowork chats:
 * opening one clears its dot, and live messages while it stays open never
 * re-mark it unread.
 */

const message = (id: string, timestamp: number): CoworkMessage => ({
  id,
  type: 'assistant',
  content: `chunk ${id}`,
  timestamp,
});

const summary = (id: string): CoworkSessionSummary => ({
  id,
  title: `Browser chat ${id}`,
  status: 'completed',
  pinned: false,
  createdAt: 1000,
  updatedAt: 1000,
  sessionType: 'browser',
  peerName: null,
  peerAvatar: null,
  metabotId: 1,
  metabotName: 'Bot',
  metabotAvatar: null,
});

test('messages for a browser session not open anywhere still mark it unread', () => {
  let state = reducer(undefined, setSessions([summary('s1')]));
  state = reducer(state, addMessage({ sessionId: 's1', message: message('m1', 1001) }));
  assert.deepEqual(state.unreadSessionIds, ['s1']);
});

test('opening a browser session clears its existing unread dot', () => {
  let state = reducer(undefined, setSessions([summary('s1')]));
  state = reducer(state, addMessage({ sessionId: 's1', message: message('m1', 1001) }));
  state = reducer(state, setBrowserOpenSessionId('s1'));
  assert.equal(state.browserOpenSessionId, 's1');
  assert.deepEqual(state.unreadSessionIds, []);
});

test('live addMessage and updateMessageContent skip unread while the browser panel has the session open', () => {
  let state = reducer(undefined, setSessions([summary('s1')]));
  state = reducer(state, setBrowserOpenSessionId('s1'));
  state = reducer(state, addMessage({ sessionId: 's1', message: message('m1', 1002) }));
  state = reducer(state, updateMessageContent({ sessionId: 's1', messageId: 'm1', content: 'done' }));
  assert.deepEqual(state.unreadSessionIds, []);
});

test('closing the browser session (null pointer) re-enables unread marking', () => {
  let state = reducer(undefined, setSessions([summary('s1')]));
  state = reducer(state, setBrowserOpenSessionId('s1'));
  state = reducer(state, setBrowserOpenSessionId(null));
  state = reducer(state, addMessage({ sessionId: 's1', message: message('m1', 1003) }));
  assert.equal(state.browserOpenSessionId, null);
  assert.deepEqual(state.unreadSessionIds, ['s1']);
});

test('the browser-open mirror never suppresses unread for other sessions', () => {
  let state = reducer(undefined, setSessions([summary('s1'), summary('s2')]));
  state = reducer(state, setBrowserOpenSessionId('s1'));
  state = reducer(state, addMessage({ sessionId: 's2', message: message('m1', 1004) }));
  assert.deepEqual(state.unreadSessionIds, ['s2']);
});

test('archiving the open browser session clears the mirrored pointer', () => {
  let state = reducer(undefined, setSessions([summary('s1')]));
  state = reducer(state, setBrowserOpenSessionId('s1'));
  state = reducer(state, deleteSession('s1'));
  assert.equal(state.browserOpenSessionId, null);
});

test('setSessions drops a stale mirrored pointer whose session left the list', () => {
  let state = reducer(undefined, setSessions([summary('s1')]));
  state = reducer(state, setBrowserOpenSessionId('s1'));
  state = reducer(state, setSessions([]));
  assert.equal(state.browserOpenSessionId, null);
});
