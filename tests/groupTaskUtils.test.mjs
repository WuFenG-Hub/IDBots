import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVE_GROUP_TASK_STATUSES,
  canAcceptGroupTask,
  isActiveGroupTaskStatus,
  filterGroupTasksByTab,
  groupTaskStatusBadgeClass,
  formatGroupTaskTime,
  mergeTranscriptMessages,
  shortGroupId,
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

test('canAcceptGroupTask: owner acceptance is gated to review', () => {
  for (const status of ['planning', 'executing', 'done', 'cancelled', 'unknown']) {
    assert.equal(canAcceptGroupTask(status), false, status);
  }
  assert.equal(canAcceptGroupTask('review'), true);
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

test('groupTaskStatusBadgeClass: executing uses the breathing blue badge, distinct from done', () => {
  assert.equal(groupTaskStatusBadgeClass('executing'), 'group-task-badge-executing');
  assert.notEqual(groupTaskStatusBadgeClass('executing'), groupTaskStatusBadgeClass('done'));
});

test('formatGroupTaskTime: sqlite UTC text, ms epoch, seconds epoch, null/garbage', () => {
  // sqlite datetime('now') text is UTC without a marker
  const fromText = formatGroupTaskTime('2026-08-04 10:00:00');
  assert.ok(fromText.length > 0);
  assert.equal(fromText, formatGroupTaskTime(Date.UTC(2026, 7, 4, 10, 0, 0)));

  const fromEpoch = formatGroupTaskTime(1785000000000);
  assert.ok(fromEpoch.length > 0);

  // on-chain chain_timestamp is in SECONDS — must not render as 1970
  const fromSeconds = formatGroupTaskTime(1785000000);
  assert.equal(fromSeconds, formatGroupTaskTime(1785000000 * 1000));
  assert.ok(!fromSeconds.includes('1970'));

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

test('shortGroupId: elides long room ids, keeps i0 suffix visible, passes short/junk through', () => {
  const longId = '198206ac14f950dbfc25fad73992b6091232623987f1ab0251de1c7825de6ca5i0';
  assert.equal(shortGroupId(longId), '198206ac…6ca5i0');
  assert.equal(shortGroupId('abcd1234ef90i0'), 'abcd1234ef90i0');
  assert.equal(shortGroupId(null), '');
  assert.equal(shortGroupId('   '), '');
});

test('deliverableKindBadge: distinct label + class per kind, unknown falls back to text', async () => {
  const { deliverableKindBadge } = await import('../src/renderer/components/groupTasks/groupTaskUtils.js');
  assert.equal(deliverableKindBadge('metafile').labelKey, 'groupTasksDeliverableKindMetafile');
  assert.equal(deliverableKindBadge('metaapp').labelKey, 'groupTasksDeliverableKindMetaapp');
  assert.equal(deliverableKindBadge('url').labelKey, 'groupTasksDeliverableKindUrl');
  assert.equal(deliverableKindBadge('pinid').labelKey, 'groupTasksDeliverableKindPinid');
  assert.equal(deliverableKindBadge('text').labelKey, 'groupTasksDeliverableKindText');
  // unknown / null kinds resolve to the text badge so every row gets a label
  assert.equal(deliverableKindBadge(null).labelKey, 'groupTasksDeliverableKindText');
  assert.equal(deliverableKindBadge('weird').labelKey, 'groupTasksDeliverableKindText');
  for (const kind of ['metafile', 'metaapp', 'url', 'pinid', 'text', null]) {
    const badge = deliverableKindBadge(kind);
    assert.equal(typeof badge.className, 'string');
    assert.ok(badge.className.length > 0, `${kind} should have a class`);
  }
});

test('shouldStickToBottom: threshold semantics', () => {
  // scrollHeight 1000, viewport 200: bottom means scrollTop 800
  assert.equal(shouldStickToBottom(800, 200, 1000), true);
  assert.equal(shouldStickToBottom(720, 200, 1000), true, 'within the 80px threshold');
  assert.equal(shouldStickToBottom(100, 200, 1000), false, 'scrolled up');
});

test('P0-2: member status badge class + label cover all states', async () => {
  const { groupTaskMemberStatusBadgeClass, groupTaskMemberStatusLabel } = await import('../src/renderer/components/groupTasks/groupTaskUtils.js');
  for (const status of ['assigned', 'working', 'standby', 'done', 'unreachable']) {
    assert.equal(typeof groupTaskMemberStatusBadgeClass(status), 'string');
    assert.equal(groupTaskMemberStatusLabel(status), status);
  }
  assert.equal(typeof groupTaskMemberStatusBadgeClass('unknown'), 'string');
});

test('P0-4: deliverableVerificationState maps stored reports', async () => {
  const { deliverableVerificationState, deliverableVerificationBadgeClass } = await import('../src/renderer/components/groupTasks/groupTaskUtils.js');
  assert.equal(deliverableVerificationState(null), 'unknown');
  assert.equal(deliverableVerificationState('garbage'), 'unknown');
  assert.equal(deliverableVerificationState(JSON.stringify({ verified: true, sources: [{ outcome: 'found' }] })), 'verified');
  assert.equal(
    deliverableVerificationState(JSON.stringify({ verified: false, sources: [{ outcome: 'not_found' }, { outcome: 'found' }] })),
    'pending-sync',
  );
  assert.equal(
    deliverableVerificationState(JSON.stringify({ verified: false, sources: [{ outcome: 'not_found' }] })),
    'unverified',
  );
  assert.equal(typeof deliverableVerificationBadgeClass('verified'), 'string');
});
