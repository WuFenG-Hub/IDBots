// Auto Tasks folding for the sidebar's local-chats list.
//
// Main stamps `auto_origin` on sessions the app created on its own (long-term
// task runs, orchestration/delegation runs, scheduled-task runs); the summary
// carries it as `autoOrigin`. The sidebar splits the local list into the main
// list and the folded rows per the fold policy — long-term and orchestration
// runs fold, scheduled-task runs stay in the main list — which is what this
// suite pins: the pure split, the persisted fold preference, and the wiring
// invariants that keep a folded row out of the main list while keeping it
// searchable.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUTO_TASKS_EXPANDED_STORAGE_KEY,
  isAutoCreatedSession,
  parseAutoTasksExpandedPreference,
  serializeAutoTasksExpandedPreference,
  shouldFoldIntoAutoTasks,
  splitSessionsByAutoOrigin,
} from '../src/renderer/utils/sessionAutoGrouping';
import type { CoworkSessionSummary } from '../src/renderer/types/cowork';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const mkSession = (
  id: string,
  autoOrigin?: CoworkSessionSummary['autoOrigin'],
): CoworkSessionSummary => ({
  id,
  title: `Session ${id}`,
  status: 'idle',
  pinned: false,
  createdAt: 0,
  updatedAt: 0,
  autoOrigin,
});

test('a session is auto-created when it carries a real origin marker, but only long-term and orchestration runs fold', () => {
  assert.equal(isAutoCreatedSession(mkSession('human')), false, 'legacy rows (undefined) are human');
  assert.equal(isAutoCreatedSession(mkSession('human-null', null)), false);
  assert.equal(isAutoCreatedSession(mkSession('longterm', 'longterm')), true);
  assert.equal(isAutoCreatedSession(mkSession('orchestration', 'orchestration')), true);
  assert.equal(isAutoCreatedSession(mkSession('schedule', 'schedule')), true, 'the creation fact is still recorded');

  assert.equal(shouldFoldIntoAutoTasks(mkSession('human')), false);
  assert.equal(shouldFoldIntoAutoTasks(mkSession('longterm', 'longterm')), true);
  assert.equal(shouldFoldIntoAutoTasks(mkSession('orchestration', 'orchestration')), true);
  assert.equal(shouldFoldIntoAutoTasks(mkSession('schedule', 'schedule')), false,
    'scheduled-task runs stay in the main list — they are the user\'s own automations');
});

test('split keeps main-list and folded halves in input order', () => {
  const sessions = [
    mkSession('human-1'),
    mkSession('auto-1', 'longterm'),
    mkSession('human-2', null),
    mkSession('human-3', 'schedule'),
    mkSession('auto-2', 'orchestration'),
  ];
  const snapshot = sessions.map((session) => session.id);

  const { humanSessions, autoSessions } = splitSessionsByAutoOrigin(sessions);

  assert.deepEqual(humanSessions.map((session) => session.id), ['human-1', 'human-2', 'human-3'],
    'scheduled runs ride the main list, in place');
  assert.deepEqual(autoSessions.map((session) => session.id), ['auto-1', 'auto-2']);
  assert.deepEqual(sessions.map((session) => session.id), snapshot, 'the input array is not reordered');
});

test('split handles an empty list and a list with one half missing', () => {
  assert.deepEqual(splitSessionsByAutoOrigin([]), { humanSessions: [], autoSessions: [] });

  const onlyHuman = splitSessionsByAutoOrigin([mkSession('human-1'), mkSession('human-2')]);
  assert.equal(onlyHuman.autoSessions.length, 0);
  assert.equal(onlyHuman.humanSessions.length, 2);

  const onlyAuto = splitSessionsByAutoOrigin([mkSession('auto-1', 'longterm')]);
  assert.equal(onlyAuto.humanSessions.length, 0);
  assert.equal(onlyAuto.autoSessions.length, 1);
});

test('the fold opens only on an explicit stored preference', () => {
  assert.equal(parseAutoTasksExpandedPreference(null), false, 'default is collapsed');
  assert.equal(parseAutoTasksExpandedPreference('0'), false);
  assert.equal(parseAutoTasksExpandedPreference('1'), true);
  assert.equal(parseAutoTasksExpandedPreference('yes'), false, 'anything unexpected stays collapsed');
  assert.equal(serializeAutoTasksExpandedPreference(true), '1');
  assert.equal(serializeAutoTasksExpandedPreference(false), '0');
  assert.equal(AUTO_TASKS_EXPANDED_STORAGE_KEY, 'coworkAutoTasksExpanded');
});

test('sidebar feeds the list with the split halves and keeps search over every session', () => {
  const src = readSource('src/renderer/components/Sidebar.tsx');

  // The visible local list gets the human half; the auto half rides alongside.
  assert.match(src, /sessions=\{localListSessions\}/);
  assert.match(src, /autoSessions=\{taskRecordTab === 'local' \? localAutoSessions : undefined\}/);
  assert.match(src, /splitSessionsByAutoOrigin\(sessionGroups\.local\)/);
  // The local tab's count + red unread dot ignore the folded rows.
  assert.match(src, /local: \{ count: localHumanSessions\.length, unread: unreadOf\(localHumanSessions\) \}/);
  // Search still receives the complete list, folded sessions included.
  assert.match(src, /<CoworkSearchModal[\s\S]*?sessions=\{homeSessions\}/);
});

test('the list renders one Auto Tasks fold, collapsed by default, directly under the pinned block in every view mode', () => {
  const src = readSource('src/renderer/components/cowork/CoworkSessionList.tsx');

  assert.match(src, /data-testid="auto-tasks-section"/);
  assert.match(src, /const \[isAutoTasksExpanded, setIsAutoTasksExpanded\] = useState<boolean>\(loadAutoTasksExpanded\)/);
  assert.match(src, /parseAutoTasksExpandedPreference\(window\.localStorage\.getItem\(AUTO_TASKS_EXPANDED_STORAGE_KEY\)\)/);
  // Timeline, project and flat branches all render the same fold.
  assert.equal((src.match(/\{renderAutoTasksSection\(\)\}/g) ?? []).length, 3);
  // Position: directly under the pinned block, above the content groups, so
  // the folder is visible without scrolling — sitting last made it read as if
  // the feature did not exist.
  assert.match(src, /\{renderPinnedSection\(timelineGrouped\.pinned\)\}\s*\{renderAutoTasksSection\(\)\}\s*\{timelineGrouped\.groups\.map/);
  assert.match(src, /\{renderPinnedSection\(projectGrouped\.pinned\)\}\s*\{renderAutoTasksSection\(\)\}\s*\{projectGrouped\.groups\.map/);
  const flatPinned = src.indexOf('sortedSessions.filter((session) => session.pinned).map(renderItem)');
  const flatFold = src.indexOf('{renderAutoTasksSection()}', flatPinned);
  const flatRest = src.indexOf('sortedSessions.filter((session) => !session.pinned).map(renderItem)');
  assert.ok(flatPinned !== -1 && flatPinned < flatFold && flatFold < flatRest,
    'flat branch: pinned rows, then the fold, then the rest');
  // Nothing is rendered when there is nothing to fold.
  assert.match(src, /sortedAutoSessions\.length > 0 && \(/);
});

test('the fold header carries label + count + latest activity, and no unread number', () => {
  const src = readSource('src/renderer/components/cowork/CoworkSessionList.tsx');
  const header = src.slice(
    src.indexOf('const renderAutoTasksSection'),
    src.indexOf('{isAutoTasksExpanded && sortedAutoSessions.map(renderItem)}'),
  );

  assert.match(header, /coworkAutoTasks'/);
  assert.match(header, /coworkAutoTasksCount/);
  assert.match(header, /\{sortedAutoSessions\.length\}/, 'the session count stays');
  assert.match(header, /formatRelativeTime\(autoLatestActivityAt\)/, 'the newest-activity stamp stays');
  // The unread number was noise: assistant stream chunks carry no
  // metadata.origin, so the heartbeat exemption cannot cover the replies and
  // an active folded session looked unread permanently.
  assert.doesNotMatch(header, /unread/i);
  assert.doesNotMatch(header, /autoUnreadCount/);
  assert.doesNotMatch(header, /bg-red-500/);
  assert.equal((src.match(/autoUnreadCount/g) ?? []).length, 0, 'the derivation is gone, not just unrendered');
  // Per-row dots inside the expanded fold are untouched.
  assert.match(src, /hasUnread=\{unreadSessionIdSet\.has\(session\.id\)\}/);

  // The label key is gone from both dictionaries, keeping coverage symmetric.
  const i18n = readSource('src/renderer/services/i18n.ts');
  assert.equal((i18n.match(/coworkAutoTasksUnread/g) ?? []).length, 0);
  assert.equal((i18n.match(/coworkAutoTasksCount:/g) ?? []).length, 2, 'still one per locale');
});
