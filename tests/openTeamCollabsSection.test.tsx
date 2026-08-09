import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  OpenTeamCollabCard,
  openTeamCollabStatusBadgeClass,
  openTeamCollabTitle,
  shortGlobalMetaId,
} from '../src/renderer/components/groupTasks/OpenTeamCollabsSection';
import { i18nService } from '../src/renderer/services/i18n';
import type { OpenTeamCollabSummary } from '../src/renderer/types/openTeamCollab';

const baseCollab: OpenTeamCollabSummary = {
  id: 1,
  groupId: 'group-ext-1',
  metabotId: 7,
  botName: 'Worker Seven',
  globalmetaid: 'gmid-bot-7',
  inviterGlobalmetaid: 'gmid-inviter-abcdef',
  taskTitle: 'External Task',
  invitePinId: 'pin-invite-1',
  joinedPinId: 'pin-join-1',
  status: 'active',
  createdAt: null,
  messageCount: 12,
  lastMessageAt: null,
};

test('shortGlobalMetaId: trims, shortens, tolerates empty input', () => {
  assert.equal(shortGlobalMetaId('gmid-inviter-abcdef'), 'gmid-invit…');
  assert.equal(shortGlobalMetaId('short'), 'short');
  assert.equal(shortGlobalMetaId(null), '');
  assert.equal(shortGlobalMetaId('   '), '');
});

test('openTeamCollabTitle: task title wins, short group id fallback', () => {
  assert.equal(openTeamCollabTitle({ taskTitle: 'External Task', groupId: 'group-ext-1' }), 'External Task');
  const fallback = openTeamCollabTitle({ taskTitle: null, groupId: 'group-ext-1' });
  assert.ok(fallback.includes('group-ext-1'), `fallback should carry the group id, got: ${fallback}`);
  const truncated = openTeamCollabTitle({ taskTitle: null, groupId: 'group-ext-abcdef' });
  assert.ok(truncated.includes('group-ext-…'), `long group id should be shortened, got: ${truncated}`);
  assert.equal(openTeamCollabTitle({ taskTitle: '   ', groupId: 'g' }), openTeamCollabTitle({ taskTitle: null, groupId: 'g' }));
});

test('openTeamCollabStatusBadgeClass: active is green, left is gray', () => {
  assert.ok(openTeamCollabStatusBadgeClass('active').includes('green'));
  assert.ok(openTeamCollabStatusBadgeClass('left').includes('gray'));
});

test('OpenTeamCollabCard: renders title, status, bot, inviter and message count', () => {
  const markup = renderToStaticMarkup(
    <OpenTeamCollabCard collab={baseCollab} onClick={() => {}} />,
  );
  assert.ok(markup.includes('External Task'), 'task title rendered');
  assert.ok(markup.includes(i18nService.t('openTeamCollabStatusActive')), 'active status label rendered');
  assert.ok(markup.includes('Worker Seven'), 'bot name rendered');
  assert.ok(markup.includes('gmid-invit…'), 'short inviter id rendered');
  assert.ok(markup.includes('12'), 'message count rendered');
  assert.ok(!markup.includes(i18nService.t('openTeamCollabStatusLeft')), 'left label not rendered for active row');
});

test('OpenTeamCollabCard: falls back to bot id and untitled group label', () => {
  const markup = renderToStaticMarkup(
    <OpenTeamCollabCard
      collab={{
        ...baseCollab,
        botName: null,
        taskTitle: null,
        inviterGlobalmetaid: null,
        status: 'left',
        messageCount: 0,
      }}
      onClick={() => {}}
    />,
  );
  assert.ok(markup.includes('bot-7'), 'bot id fallback rendered');
  assert.ok(markup.includes(i18nService.t('openTeamCollabStatusLeft')), 'left status label rendered');
  assert.ok(!markup.includes('External Task'), 'no task title for fallback row');
});
