// Heartbeat unread exemption + the auto-origin marker's trip through the
// renderer session store.
//
// Long-term-task heartbeats drive [长期] sessions on their own; those turns are
// background progress, not messages the human has to be paged about, so the
// unread bookkeeping must skip them (scheduled-task runs, orchestration turns
// and plain input keep marking unread). The same store also rebuilds session
// summaries from full-session payloads — every rebuild has to carry
// `autoOrigin`, otherwise an auto-created session would reappear in the human
// list until the next full refresh.

import test from 'node:test';
import assert from 'node:assert/strict';

import reducer, {
  addMessage,
  addSession,
  registerBackgroundSession,
  setCurrentSession,
  setSessions,
} from '../src/renderer/store/slices/coworkSlice';
import type {
  CoworkMessage,
  CoworkMessageMetadata,
  CoworkSession,
  CoworkSessionSummary,
} from '../src/renderer/types/cowork';

const summary = (overrides: Partial<CoworkSessionSummary>): CoworkSessionSummary => ({
  id: 'session-a',
  title: 'Long-term run',
  status: 'completed',
  pinned: false,
  createdAt: 1000,
  updatedAt: 1000,
  sessionType: 'standard',
  ...overrides,
});

const session = (overrides: Partial<CoworkSession> = {}): CoworkSession => ({
  id: 'session-a',
  title: 'Long-term run',
  claudeSessionId: null,
  status: 'completed',
  pinned: false,
  cwd: '/tmp',
  systemPrompt: '',
  executionMode: 'local',
  activeSkillIds: [],
  messages: [],
  createdAt: 1000,
  updatedAt: 1000,
  sessionType: 'longterm',
  ...overrides,
});

const message = (metadata?: CoworkMessageMetadata): CoworkMessage => ({
  id: 'message-1',
  type: 'user',
  content: 'heartbeat escalation',
  timestamp: 2000,
  ...(metadata ? { metadata } : {}),
});

const seeded = () => reducer(undefined, setSessions([summary({})]));

test('a heartbeat turn never marks its session unread', () => {
  const state = reducer(seeded(), addMessage({
    sessionId: 'session-a',
    message: message({ origin: 'heartbeat' }),
  }));

  assert.deepEqual(state.unreadSessionIds, [], 'background long-term progress raises no dot');
});

test('every other origin keeps the historic unread behavior', () => {
  const origins: Array<CoworkMessageMetadata['origin']> = [
    undefined,
    'user',
    'quick_action',
    'schedule',
    'cross_session',
    'metaweb_group',
    'metaweb_private',
    'orchestrator',
    'group_task',
  ];

  for (const origin of origins) {
    const state = reducer(seeded(), addMessage({
      sessionId: 'session-a',
      message: message(origin ? { origin } : undefined),
    }));
    assert.deepEqual(
      state.unreadSessionIds,
      ['session-a'],
      `origin ${String(origin)} still marks unread`,
    );
  }
});

test('the streaming update path applies the same heartbeat exemption', () => {
  const heartbeat = reducer(seeded(), {
    type: 'cowork/updateMessageContent',
    payload: { sessionId: 'session-a', messageId: 'message-1', content: 'x', metadata: { origin: 'heartbeat' } },
  });
  assert.deepEqual(heartbeat.unreadSessionIds, []);

  const scheduled = reducer(seeded(), {
    type: 'cowork/updateMessageContent',
    payload: { sessionId: 'session-a', messageId: 'message-1', content: 'x', metadata: { origin: 'schedule' } },
  });
  assert.deepEqual(scheduled.unreadSessionIds, ['session-a']);

  const noMetadata = reducer(seeded(), {
    type: 'cowork/updateMessageContent',
    payload: { sessionId: 'session-a', messageId: 'message-1', content: 'x' },
  });
  assert.deepEqual(noMetadata.unreadSessionIds, ['session-a'], 'a content-only update still marks unread');
});

test('summary rebuilds keep the auto-origin marker', () => {
  // Opening a background run: setCurrentSession rebuilds its list row.
  const opened = reducer(
    reducer(undefined, setSessions([])),
    setCurrentSession(session({ autoOrigin: 'longterm' })),
  );
  assert.deepEqual(opened.sessions.map((row) => row.autoOrigin), ['longterm']);

  // A payload without the field must not erase a marker the list already knows.
  const merged = reducer(
    reducer(undefined, setSessions([summary({ autoOrigin: 'schedule' })])),
    setCurrentSession(session()),
  );
  assert.equal(merged.sessions[0].autoOrigin, 'schedule');

  // addSession (a session the human just started) carries whatever it has.
  const added = reducer(undefined, addSession(session({ autoOrigin: 'orchestration' })));
  assert.equal(added.sessions[0].autoOrigin, 'orchestration');
  const humanAdded = reducer(undefined, addSession(session()));
  assert.equal(humanAdded.sessions[0].autoOrigin, null);

  // registerBackgroundSession is a pass-through of the fetched summary.
  const background = reducer(undefined, registerBackgroundSession(summary({ autoOrigin: 'longterm' })));
  assert.equal(background.sessions[0].autoOrigin, 'longterm');
});
