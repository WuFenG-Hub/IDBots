import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVE_GROUP_TASK_STATUSES,
  canAcceptGroupTask,
  isActiveGroupTaskStatus,
  filterGroupTasksByTab,
  groupTaskStatusBadgeClass,
  formatGroupTaskTime,
  formatGroupTaskMessengerTime,
  formatGroupTaskRelativeTime,
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

test('formatGroupTaskMessengerTime: compact HH:mm matching A2A bubbles', () => {
  const now = new Date(2026, 7, 19, 15, 30, 0).getTime();
  const sameDay = new Date(2026, 7, 19, 9, 5, 0).getTime();
  assert.equal(formatGroupTaskMessengerTime(sameDay, now), '09:05');

  const yesterday = new Date(2026, 7, 18, 9, 5, 0).getTime();
  assert.equal(formatGroupTaskMessengerTime(yesterday, now), '08-18 09:05');

  const lastYear = new Date(2025, 11, 31, 23, 0, 0).getTime();
  assert.equal(formatGroupTaskMessengerTime(lastYear, now), '2025-12-31 23:00');

  assert.equal(formatGroupTaskMessengerTime(null, now), '');
  assert.equal(formatGroupTaskMessengerTime('', now), '');
});

test('formatGroupTaskRelativeTime: compact 19h / 2d matching the chat list', () => {
  const now = Date.UTC(2026, 7, 19, 12, 0, 0);
  assert.deepEqual(formatGroupTaskRelativeTime(now - 30_000, now), { compact: 'now', unit: 'now', count: 0 });
  assert.equal(formatGroupTaskRelativeTime(now - 5 * 60_000, now).compact, '5m');
  assert.equal(formatGroupTaskRelativeTime(now - 19 * 3600_000, now).compact, '19h');
  assert.equal(formatGroupTaskRelativeTime(now - 2 * 86400_000, now).compact, '2d');
  assert.equal(formatGroupTaskRelativeTime(now - 86400_000, now).compact, '1d');
  assert.equal(formatGroupTaskRelativeTime(null, now).compact, '');
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

test('selectAcceptanceChecklist: digital URIs first; process-text placeholders omitted', async () => {
  const { selectAcceptanceChecklist, isDigitalDeliverable } = await import('../src/renderer/components/groupTasks/groupTaskUtils.js');
  assert.equal(isDigitalDeliverable({ uri: 'metaapp://abc' }), true);
  assert.equal(isDigitalDeliverable({ kind: 'text', uri: null }), false);

  const mixed = [
    { kind: 'text', uri: null, preview: null, authorName: 'loop' },
    { kind: 'metaapp', uri: 'metaapp://abc', confirmation: 'confirmed', authorName: 'eleven' },
    { kind: 'text', uri: null, preview: '核验报告', authorName: 'Builder阿码' },
    { kind: 'url', uri: 'https://openagentinternet.org/browser/x', confirmation: 'confirmed', authorName: 'eleven' },
  ];
  const selected = selectAcceptanceChecklist(mixed);
  assert.deepEqual(selected.items.map((item) => item.kind), ['metaapp', 'url']);
  assert.equal(selected.omittedProcessCount, 2);

  const textOnly = [
    { kind: 'text', uri: null, preview: '【结论】验收通过', authorName: 'chair' },
    { kind: 'text', uri: null, preview: null, authorName: 'loop' },
  ];
  const textSelected = selectAcceptanceChecklist(textOnly);
  assert.equal(textSelected.items.length, 1);
  assert.equal(textSelected.items[0].preview, '【结论】验收通过');
  assert.equal(textSelected.omittedProcessCount, 1);

  assert.deepEqual(selectAcceptanceChecklist(null), { items: [], omittedProcessCount: 0 });
});

test('isRemoteGroupTaskSeat: metabotId null + globalMetaId present means a remote OpenTeam seat', async () => {
  const { isRemoteGroupTaskSeat } = await import('../src/renderer/components/groupTasks/groupTaskUtils.js');
  assert.equal(isRemoteGroupTaskSeat({ metabotId: null, globalMetaId: 'idq12se8j7n6g35g' }), true);
  assert.equal(isRemoteGroupTaskSeat({ metabotId: 15, globalMetaId: 'idq1d5m392ahkhp7' }), false);
  // A null-metabotId seat without a chain id is junk, not a remote bot.
  assert.equal(isRemoteGroupTaskSeat({ metabotId: null, globalMetaId: null }), false);
  assert.equal(isRemoteGroupTaskSeat({ metabotId: null, globalMetaId: '  ' }), false);
  assert.equal(isRemoteGroupTaskSeat(null), false);
  assert.equal(isRemoteGroupTaskSeat(undefined), false);
});

test('splitGroupTasksByOpenTeam: all-local vs any-remote seats (user example: task with mixed seats is OpenTeam)', async () => {
  const { splitGroupTasksByOpenTeam } = await import('../src/renderer/components/groupTasks/groupTaskUtils.js');
  const localSeat = (metabotId, globalMetaId) => ({ metabotId, globalMetaId });
  const localTask = { id: 1, status: 'executing', members: [localSeat(1, 'idq1aaa'), localSeat(2, 'idq1bbb')] };
  // Mirrors live task #44 (group 960c427f…): chair+one worker local, two workers remote.
  const mixedSeatTask = {
    id: 44,
    status: 'done',
    members: [
      localSeat(null, 'idq12se8j7n6g35g'),
      localSeat(null, 'idq1xpueudwykqxg'),
      localSeat(1, 'idq14hmv23j5fnlx'),
      localSeat(15, 'idq1d5m392ahkhp7'),
    ],
  };
  const noMembersTask = { id: 7, status: 'planning', members: [] };
  const split = splitGroupTasksByOpenTeam([localTask, mixedSeatTask, noMembersTask]);
  assert.deepEqual(split.local.map((t) => t.id), [1, 7]);
  assert.deepEqual(split.openTeam.map((t) => t.id), [44]);
  // The OpenTeam bucket ignores status — a done mixed-seats task still lands there.
  assert.equal(split.openTeam[0].status, 'done');
  // Tolerated input shapes.
  assert.deepEqual(splitGroupTasksByOpenTeam(null), { local: [], openTeam: [] });
  assert.deepEqual(splitGroupTasksByOpenTeam([undefined, {}]), { local: [undefined, {}], openTeam: [] });
});
