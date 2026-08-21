import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import GroupTaskMessageItem from '../src/renderer/components/groupTasks/GroupTaskMessageItem';
import {
  messengerBubbleClassName,
  messengerRowClassName,
} from '../src/renderer/components/chat/messengerBubble';
import type { GroupChatTranscriptMessage } from '../src/renderer/types/groupTask';

const TXID = 'a'.repeat(64);

const message = (overrides: Partial<GroupChatTranscriptMessage> = {}): GroupChatTranscriptMessage => ({
  id: 1,
  pinId: `${TXID}i0`,
  txId: TXID,
  senderName: 'Worker Bot',
  senderGlobalMetaId: 'idq1worker',
  senderAvatar: 'https://example.com/bot.png',
  content: 'Hello **team**',
  contentType: 'text',
  chainTimestamp: new Date(2026, 7, 19, 9, 5, 0).getTime(),
  msgIndex: 1,
  replyPin: null,
  ...overrides,
});

test('group-task owner bubbles use the same outgoing messenger classes as A2A', () => {
  const markup = renderToStaticMarkup(
    <GroupTaskMessageItem
      message={message({ senderName: 'Owner Twin' })}
      senderDisplayName="Owner Twin"
      isChairSender={false}
      isOwnerSender
    />,
  );

  assert.match(markup, new RegExp(messengerRowClassName(true).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(markup, new RegExp(messengerBubbleClassName(true).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(markup, /data-outgoing="true"/);
  assert.match(markup, /<strong[^>]*>team<\/strong>/);
  assert.match(markup, /txid: aaaaaaaa\.\.\.\./);
  assert.match(markup, /09:05/);
});

test('group-task member bubbles use the same incoming messenger classes as A2A', () => {
  const markup = renderToStaticMarkup(
    <GroupTaskMessageItem
      message={message()}
      senderDisplayName="Worker Bot"
      isChairSender
      isOwnerSender={false}
    />,
  );

  assert.match(markup, new RegExp(messengerRowClassName(false).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(markup, new RegExp(messengerBubbleClassName(false).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(markup, /data-outgoing="false"/);
  assert.doesNotMatch(markup, /bg-blue-500/);
  assert.doesNotMatch(markup, /flex-row-reverse/);
});

test('group-task own-bot messages in OpenTeam transcripts sit on the outgoing side', () => {
  const markup = renderToStaticMarkup(
    <GroupTaskMessageItem
      message={message({ senderName: 'My Bot' })}
      senderDisplayName="My Bot"
      isChairSender={false}
      isOwnerSender={false}
      isOwnBotSender
    />,
  );

  assert.match(markup, /data-outgoing="true"/);
  assert.match(markup, /bg-blue-500/);
  assert.match(markup, /flex-row-reverse/);
});
