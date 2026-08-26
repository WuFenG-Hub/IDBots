import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import GroupTaskMessageItem from '../src/renderer/components/groupTasks/GroupTaskMessageItem';
import {
  GroupTaskMemberAvatarRow,
  GroupTaskTinyAvatar,
  openBotPageInBotBrowser,
} from '../src/renderer/components/groupTasks/GroupTaskListMeta';

const baseMessage = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  pinId: null,
  txId: null,
  senderName: 'Alice Bot',
  senderGlobalMetaId: null,
  senderAvatar: null,
  content: 'hello group',
  contentType: null,
  chainTimestamp: 1_744_444_444_000,
  msgIndex: 0,
  replyPin: null,
  ...overrides,
});

const renderMessageItem = (messageOverrides: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    <GroupTaskMessageItem
      message={baseMessage(messageOverrides) as React.ComponentProps<typeof GroupTaskMessageItem>['message']}
      senderDisplayName="Alice Bot"
      isChairSender={false}
      isOwnerSender={false}
    />,
  );

test('Group task message avatar exposes a Bot Browser target for the chain-signed sender', () => {
  const markup = renderMessageItem({ senderGlobalMetaId: 'idq1alicebot' });

  assert.match(markup, /<button[^>]*data-browser-global-metaid="idq1alicebot"/);
  assert.match(markup, /aria-label="Open Alice Bot in Bot Browser"/);
  assert.match(markup, /hello group/);
});

test('Group task outgoing own-bot message avatar also opens the local Bot page', () => {
  const markup = renderToStaticMarkup(
    <GroupTaskMessageItem
      message={baseMessage({ senderGlobalMetaId: 'idq1ownbot' }) as React.ComponentProps<typeof GroupTaskMessageItem>['message']}
      senderDisplayName="Own Bot"
      isChairSender={false}
      isOwnerSender={false}
      isOwnBotSender
    />,
  );

  assert.match(markup, /<button[^>]*data-browser-global-metaid="idq1ownbot"/);
  assert.match(markup, /aria-label="Open Own Bot in Bot Browser"/);
});

test('Group task message without a sender GlobalMetaID keeps a plain non-clickable avatar', () => {
  const markup = renderMessageItem();

  assert.doesNotMatch(markup, /data-browser-global-metaid/);
  assert.match(markup, /<img[^>]*alt="Alice Bot"/);
});

test('Group task member preview avatars expose Bot Browser targets only for members with a GlobalMetaID', () => {
  const markup = renderToStaticMarkup(
    <GroupTaskMemberAvatarRow
      members={[
        { name: 'Alice', avatar: null, role: 'chair', metabotId: 1, globalMetaId: 'idq1alicebot' },
        { name: 'Bob', avatar: null, role: 'worker', metabotId: null, globalMetaId: null },
        { name: 'Cara', avatar: null, role: 'worker', metabotId: 2, globalMetaId: 'idp1carabot' },
      ]}
    />,
  );

  assert.match(markup, /<button[^>]*data-browser-global-metaid="idq1alicebot"/);
  assert.match(markup, /aria-label="Open Alice in Bot Browser"/);
  assert.match(markup, /<button[^>]*data-browser-global-metaid="idp1carabot"/);
  // Bob has no chain identity yet — his tiny avatar stays an inert span.
  const [, bobCell] = markup.split('<span');
  assert.ok(bobCell);
});

test('Group task tiny avatar without a GlobalMetaID stays inert', () => {
  const markup = renderToStaticMarkup(
    <GroupTaskTinyAvatar src={null} name="Bob" />,
  );

  assert.doesNotMatch(markup, /data-browser-global-metaid/);
  assert.doesNotMatch(markup, /<button/);
});

test('openBotPageInBotBrowser dispatches the app-wide botBrowser:openUri event with a metaid URI', () => {
  type OpenUriEvent = { type: string; detail?: { uri?: string } };
  const dispatched: OpenUriEvent[] = [];
  const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window;
  (globalThis as typeof globalThis & { window?: unknown }).window = {
    dispatchEvent: (event: OpenUriEvent) => {
      dispatched.push(event);
      return true;
    },
  };

  try {
    openBotPageInBotBrowser('idq1alicebot');
    openBotPageInBotBrowser('   ');
    openBotPageInBotBrowser(null);
  } finally {
    (globalThis as typeof globalThis & { window?: unknown }).window = originalWindow;
  }

  assert.deepEqual(dispatched.map((event) => event.type), ['botBrowser:openUri']);
  assert.equal(dispatched[0].detail?.uri, 'metaid://idq1alicebot');
});
