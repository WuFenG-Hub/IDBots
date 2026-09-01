import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import GroupTaskSidebarList, {
  GroupTaskTypeBadge,
} from '../src/renderer/components/groupTasks/GroupTaskSidebarList';
import { OpenTeamCollabSidebarRow } from '../src/renderer/components/groupTasks/OpenTeamCollabsSection';
import { i18nService } from '../src/renderer/services/i18n';

const baseTask = (id: number) => ({
  id,
  groupId: null,
  title: `Task ${id}`,
  status: 'executing' as const,
  pinned: false,
  displayName: null,
  members: [],
  updatedAt: null,
  createdAt: null,
});

const baseCollab = (overrides: Record<string, unknown> = {}) => ({
  id: 7,
  groupId: `${'g'.repeat(64)}i0`,
  metabotId: 3,
  botName: 'Eleven',
  globalmetaid: 'idq1collab',
  inviterGlobalmetaid: 'idq1inviter',
  taskTitle: 'External Task',
  invitePinId: null,
  joinedPinId: null,
  status: 'active' as const,
  createdAt: null,
  messageCount: 3,
  lastMessageAt: null,
  leftAt: null,
  leftCause: null,
  leftReason: null,
  taskStatus: null,
  taskStatusUpdatedAt: null,
  ...overrides,
});

test('GroupTaskTypeBadge: Open Team reads accent, local reads neutral', () => {
  const openTeam = renderToStaticMarkup(<GroupTaskTypeBadge openTeam={true} />);
  assert.ok(
    openTeam.includes(i18nService.t('groupTasksTaskBadgeOpenTeam')),
    'open-team label rendered',
  );
  assert.match(openTeam, /text-claude-accent/, 'open-team badge is accent-colored');
  const local = renderToStaticMarkup(<GroupTaskTypeBadge openTeam={false} />);
  assert.ok(local.includes(i18nService.t('groupTasksTaskBadgeLocal')), 'local label rendered');
  assert.ok(
    !/text-claude-accent\b/.test(local),
    'local badge is neutral, not accent-colored',
  );
});

test('GroupTaskSidebarList: rows carry the type badge driven by openTeamTaskIds', () => {
  const markup = renderToStaticMarkup(
    <GroupTaskSidebarList
      tasks={[baseTask(1), baseTask(44)]}
      onSelectTask={() => {}}
      openTeamTaskIds={new Set([44])}
    />,
  );
  assert.ok(
    markup.includes(i18nService.t('groupTasksTaskBadgeOpenTeam')),
    'remote-seat task row shows the Open Team badge',
  );
  assert.ok(
    markup.includes(i18nService.t('groupTasksTaskBadgeLocal')),
    'all-local task row shows the Local badge',
  );
});

test('OpenTeamCollabSidebarRow: joined collab rows carry the Open Team badge', () => {
  const markup = renderToStaticMarkup(
    <OpenTeamCollabSidebarRow collab={baseCollab()} onSelect={() => {}} />,
  );
  assert.ok(
    markup.includes(i18nService.t('groupTasksTaskBadgeOpenTeam')),
    'joined collab row shows the Open Team badge',
  );
  assert.ok(!markup.includes(i18nService.t('groupTasksTaskBadgeLocal')), 'no local badge on collab rows');
});
