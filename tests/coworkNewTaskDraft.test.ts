import test from 'node:test';
import assert from 'node:assert/strict';

import reducer, {
  setDraftPrompt,
  setNewTaskMetabotId,
  setPreferredMetabotId,
  clearPreferredMetabotId,
  prependMessages,
  setCurrentSession,
  setSessionDraft,
  deleteSession,
} from '../src/renderer/store/slices/coworkSlice';
import type { CoworkSession } from '../src/renderer/types/cowork';

const createPagedSession = (messages: CoworkSession['messages']): CoworkSession => ({
  id: 'a2a-session',
  title: 'A2A session',
  claudeSessionId: null,
  status: 'completed',
  pinned: false,
  cwd: '/tmp/a2a',
  systemPrompt: '',
  executionMode: 'local',
  activeSkillIds: [],
  messages,
  messageHistory: {
    hasMoreBefore: true,
    beforeSequence: 101,
    pageSize: 100,
  },
  createdAt: 1,
  updatedAt: 2,
  sessionType: 'a2a',
});

test('newTaskMetabotId persists independently from the preferred metabot flow', () => {
  let state = reducer(undefined, setNewTaskMetabotId(42));
  assert.equal(state.newTaskMetabotId, 42);

  // The restore-from-mnemonic preferred metabot flow must not clobber the
  // user's New Task selection.
  state = reducer(state, setPreferredMetabotId(7));
  state = reducer(state, clearPreferredMetabotId());
  assert.equal(state.newTaskMetabotId, 42);

  state = reducer(state, setNewTaskMetabotId(null));
  assert.equal(state.newTaskMetabotId, null);
});

test('draftPrompt is a standalone global draft for the New Task composer', () => {
  let state = reducer(undefined, setDraftPrompt('a long task description'));
  assert.equal(state.draftPrompt, 'a long task description');
  state = reducer(state, setDraftPrompt(''));
  assert.equal(state.draftPrompt, '');
});

test('session drafts are keyed per session and never clobber each other', () => {
  let state = reducer(undefined, setSessionDraft({ sessionId: 'session-a', value: 'abc', attachments: [] }));
  state = reducer(state, setSessionDraft({ sessionId: 'session-b', value: 'xyz', attachments: [{ path: '/b.txt', name: 'b.txt' }] }));
  assert.deepEqual(state.sessionDrafts, {
    'session-a': { value: 'abc', attachments: [] },
    'session-b': { value: 'xyz', attachments: [{ path: '/b.txt', name: 'b.txt' }] },
  });

  // Editing session A must not touch session B's draft.
  state = reducer(state, setSessionDraft({ sessionId: 'session-a', value: 'abc def', attachments: [] }));
  assert.equal(state.sessionDrafts['session-b']?.value, 'xyz');
});

test('clearing a session draft removes its store entry', () => {
  let state = reducer(undefined, setSessionDraft({ sessionId: 'session-a', value: 'abc', attachments: [] }));
  state = reducer(state, setSessionDraft({ sessionId: 'session-a', value: '', attachments: [] }));
  assert.equal(state.sessionDrafts['session-a'], undefined);

  // A draft consisting only of attachments is still kept.
  state = reducer(state, setSessionDraft({ sessionId: 'session-a', value: '', attachments: [{ path: '/a.txt', name: 'a.txt' }] }));
  assert.deepEqual(state.sessionDrafts['session-a'], { value: '', attachments: [{ path: '/a.txt', name: 'a.txt' }] });
});

test('deleting a session purges its draft', () => {
  let state = reducer(undefined, setSessionDraft({ sessionId: 'session-a', value: 'abc', attachments: [] }));
  state = reducer(state, setSessionDraft({ sessionId: 'session-b', value: 'xyz', attachments: [] }));
  state = reducer(state, deleteSession('session-a'));
  assert.equal(state.sessionDrafts['session-a'], undefined);
  assert.equal(state.sessionDrafts['session-b']?.value, 'xyz');
});

test('paged A2A history prepends without duplicates and survives a metadata refresh', () => {
  const latest = {
    id: 'message-101',
    type: 'assistant' as const,
    content: 'latest',
    timestamp: 101,
  };
  let state = reducer(undefined, setCurrentSession(createPagedSession([latest])));
  state = reducer(state, prependMessages({
    sessionId: 'a2a-session',
    messages: [
      { id: 'message-99', type: 'user', content: 'older', timestamp: 99 },
      { id: 'message-101', type: 'assistant', content: 'duplicate', timestamp: 101 },
    ],
    messageHistory: {
      hasMoreBefore: false,
      beforeSequence: null,
      pageSize: 100,
    },
  }));
  assert.deepEqual(state.currentSession?.messages.map((message) => message.id), [
    'message-99',
    'message-101',
  ]);

  const refreshed = createPagedSession([
    { ...latest, content: 'latest refreshed' },
    { id: 'message-102', type: 'assistant', content: 'new', timestamp: 102 },
  ]);
  state = reducer(state, setCurrentSession(refreshed));
  assert.deepEqual(state.currentSession?.messages.map((message) => message.id), [
    'message-99',
    'message-101',
    'message-102',
  ]);
  assert.equal(state.currentSession?.messages[1]?.content, 'latest refreshed');
  assert.equal(state.currentSession?.messageHistory?.hasMoreBefore, false);
});
