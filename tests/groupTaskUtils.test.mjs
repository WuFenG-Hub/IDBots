import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVE_GROUP_TASK_STATUSES,
  isActiveGroupTaskStatus,
  filterGroupTasksByTab,
  groupTaskStatusBadgeClass,
  formatGroupTaskTime,
  mergeTranscriptMessages,
  shouldStickToBottom,
} from '../src/renderer/components/groupTasks/groupTaskUtils.js';

const task = (id, status) => ({ id, status });

test('isActiveGroupTaskStatus: planning/executing/review are active, terminal states are not', () => {
  assert.deepEqual(ACTIVE_GROUP_TASK_STATUSES, ['planning', 'executing', 'review']);
  for (const status of ['planning', 'executing', 'review']) {
    assert.equal(isActiveGroupTaskStatus(status), true, status);
  }
  for (const status of ['done', 'cancelled', 'unknown', '']) {
    assert.equal(isActiveGroupTaskStatus(status), false, status);
  }
});

test('filterGroupTasksByTab: active default, done, cancelled, all', () => {
  const tasks = [
    task(1, 'planning'),
    task(2, 'executing'),
    task(3, 'review'),
    task(4, 'done'),
    task(5, 'cancelled'),
  ];
  assert.deepEqual(filterGroupTasksByTab(tasks, 'active').map((t) => t.id), [1, 2, 3]);
  assert.deepEqual(filterGroupTasksByTab(tasks, 'done').map((t) => t.id), [4]);
  assert.deepEqual(filterGroupTasksByTab(tasks, 'cancelled').map((t) => t.id), [5]);
  assert.deepEqual(filterGroupTasksByTab(tasks, 'all').map((t) => t.id), [1, 2, 3, 4, 5]);
  // unknown tab behaves like active; non-array input is tolerated
  assert.deepEqual(filterGroupTasksByTab(tasks, 'bogus').map((t) => t.id), [1, 2, 3]);
  assert.deepEqual(filterGroupTasksByTab(null, 'all'), []);
});

test('groupTaskStatusBadgeClass: every known status has a class, unknown falls back', () => {
  for (const status of ['planning', 'executing', 'review', 'done', 'cancelled']) {
    const cls = groupTaskStatusBadgeClass(status);
    assert.equal(typeof cls, 'string');
    assert.ok(cls.length > 0);
  }
  assert.equal(groupTaskStatusBadgeClass('nope'), groupTaskStatusBadgeClass('cancelled'));
});

test('formatGroupTaskTime: sqlite UTC text, ms epoch, null/garbage', () => {
  // sqlite datetime('now') text is UTC without a marker
  const fromText = formatGroupTaskTime('2026-08-04 10:00:00');
  assert.ok(fromText.length > 0);
  assert.equal(fromText, formatGroupTaskTime(Date.UTC(2026, 7, 4, 10, 0, 0)));

  const fromEpoch = formatGroupTaskTime(1785000000000);
  assert.ok(fromEpoch.length > 0);

  assert.equal(formatGroupTaskTime(null), '');
  assert.equal(formatGroupTaskTime(''), '');
  assert.equal(formatGroupTaskTime('not-a-date'), '');
});

test('mergeTranscriptMessages: dedupe by id, ascending, tolerates junk', () => {
  const existing = [
    { id: 1, content: 'a' },
    { id: 3, content: 'c-old' },
  ];
  const incoming = [
    { id: 3, content: 'c-new' },
    { id: 5, content: 'e' },
  ];
  assert.deepEqual(
    mergeTranscriptMessages(existing, incoming).map((m) => [m.id, m.content]),
    [[1, 'a'], [3, 'c-new'], [5, 'e']],
  );
  assert.deepEqual(mergeTranscriptMessages(null, incoming).map((m) => m.id), [3, 5]);
  assert.deepEqual(mergeTranscriptMessages(existing, null).map((m) => m.id), [1, 3]);
});

test('shouldStickToBottom: threshold semantics', () => {
  // scrollHeight 1000, viewport 200: bottom means scrollTop 800
  assert.equal(shouldStickToBottom(800, 200, 1000), true);
  assert.equal(shouldStickToBottom(720, 200, 1000), true, 'within the 80px threshold');
  assert.equal(shouldStickToBottom(100, 200, 1000), false, 'scrolled up');
});
