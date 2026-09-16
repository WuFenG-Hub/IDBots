import test from 'node:test';
import assert from 'node:assert/strict';

import reducer, {
  setSessions,
  addMessage,
  updateSessionStatus,
  updateSessionTitle,
  setCurrentSession,
} from '../src/renderer/store/slices/coworkSlice';
import { sortSessionsByMode } from '../src/renderer/utils/sessionViewGrouping';
import type {
  CoworkMessage,
  CoworkSession,
  CoworkSessionSummary,
} from '../src/renderer/types/cowork';

/**
 * The sidebar's sort anchor is the timestamp of the session's LAST USER-SIDE
 * message (typed by the user or injected by orchestration — both land as
 * type 'user'), mirroring coworkStore.listSessions' SQL. Everything else —
 * assistant/tool/system stream traffic, status flips, renames, opening the
 * session — must leave the anchor untouched so parallel running sessions do
 * not jump around the list while their turns stream.
 */

const summary = (overrides: Partial<CoworkSessionSummary>): CoworkSessionSummary => ({
  id: 'session-a',
  title: 'Session A',
  status: 'waiting',
  pinned: false,
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides,
});

const message = (overrides: Partial<CoworkMessage>): CoworkMessage => ({
  id: `msg-${Math.random().toString(36).slice(2)}`,
  type: 'assistant',
  content: 'x',
  timestamp: 0,
  ...overrides,
});

const initState = (sessions: CoworkSessionSummary[]) =>
  reducer(undefined, setSessions(sessions));

const listOrder = (state: ReturnType<typeof initState>) =>
  sortSessionsByMode(state.sessions, 'updatedAt').map((session) => session.id);

test('assistant/tool/system stream traffic does not move a session in the list', () => {
  let state = initState([
    summary({ id: 'a', updatedAt: 5000 }),
    summary({ id: 'b', updatedAt: 9000 }),
  ]);
  assert.deepEqual(listOrder(state), ['b', 'a']);

  // Session b streams a full turn while the app shows another session.
  for (const [type, ts] of [['assistant', 12000], ['tool_use', 13000], ['tool_result', 13500], ['system', 14000]] as const) {
    state = reducer(state, addMessage({ sessionId: 'b', message: message({ type, timestamp: ts }) }));
  }

  assert.equal(state.sessions.find((s) => s.id === 'b')?.updatedAt, 9000);
  assert.deepEqual(listOrder(state), ['b', 'a']);
  // Stream traffic still marks the background session unread.
  assert.ok(state.unreadSessionIds.includes('b'));
});

test('a user-side message (typed or orchestration-injected) moves the session to the top', () => {
  let state = initState([
    summary({ id: 'a', updatedAt: 5000 }),
    summary({ id: 'b', updatedAt: 9000 }),
  ]);

  state = reducer(state, addMessage({
    sessionId: 'a',
    message: message({ type: 'user', timestamp: 15000 }),
  }));
  assert.equal(state.sessions.find((s) => s.id === 'a')?.updatedAt, 15000);
  assert.deepEqual(listOrder(state), ['a', 'b']);

  // Chain/orchestration-delivered user turns carry metadata but are still
  // type 'user' — they must count as input exactly like a typed turn.
  state = reducer(state, addMessage({
    sessionId: 'b',
    message: message({
      type: 'user',
      timestamp: 16000,
      metadata: { suppressRunningStatus: true },
    }),
  }));
  assert.equal(state.sessions.find((s) => s.id === 'b')?.updatedAt, 16000);
  assert.deepEqual(listOrder(state), ['b', 'a']);
});

test('status flips and renames keep the sort anchor', () => {
  let state = initState([summary({ id: 'a', updatedAt: 5000 })]);

  state = reducer(state, updateSessionStatus({ sessionId: 'a', status: 'running' }));
  state = reducer(state, updateSessionStatus({ sessionId: 'a', status: 'waiting' }));
  state = reducer(state, updateSessionTitle({ sessionId: 'a', title: 'Renamed' }));

  const row = state.sessions.find((s) => s.id === 'a');
  assert.equal(row?.updatedAt, 5000);
  assert.equal(row?.title, 'Renamed');
  assert.equal(row?.status, 'waiting');
});

test('opening a session does not import the full session payload raw updated_at', () => {
  let state = initState([summary({ id: 'a', updatedAt: 5000 })]);

  const full: CoworkSession = {
    id: 'a',
    title: 'Session A',
    claudeSessionId: null,
    status: 'running',
    pinned: false,
    cwd: '/tmp',
    systemPrompt: '',
    executionMode: 'local',
    activeSkillIds: [],
    messages: [],
    createdAt: 1000,
    updatedAt: 999999,
    sessionType: 'standard',
  };
  state = reducer(state, setCurrentSession(full));

  assert.equal(state.currentSession?.id, 'a');
  // The list keeps its own last-input anchor; only the open session's status
  // and title fields merge through.
  assert.equal(state.sessions.find((s) => s.id === 'a')?.updatedAt, 5000);
});
