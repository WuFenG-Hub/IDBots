import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import A2AMessageItem from '../src/renderer/components/cowork/A2AMessageItem';
import type { CoworkMessage } from '../src/renderer/types/cowork';

const makeMessage = (overrides: Partial<CoworkMessage> = {}): CoworkMessage => ({
  id: 'msg-a2a-1',
  type: 'assistant',
  content: 'hello peer',
  timestamp: new Date('2026-10-25T11:37:00+08:00').getTime(),
  metadata: { direction: 'outgoing', txid: '04c6fc3a'.padEnd(64, '0') },
  ...overrides,
} as CoworkMessage);

test('A2A bubble mounts data-message-id so the turn navigator can resolve jumps', () => {
  const markup = renderToStaticMarkup(
    React.createElement(A2AMessageItem, {
      message: makeMessage(),
      peerName: 'BOT-007',
      metabotName: 'Monday',
    }),
  );
  assert.match(markup, /data-message-id="msg-a2a-1"/);
});

test('the attribute is absent nowhere: incoming messages carry it too', () => {
  const markup = renderToStaticMarkup(
    React.createElement(A2AMessageItem, {
      message: makeMessage({
        id: 'msg-a2a-2',
        type: 'user',
        metadata: { direction: 'incoming', txid: '11'.padEnd(64, '2') },
      }),
      peerName: 'BOT-007',
      metabotName: 'Monday',
    }),
  );
  assert.match(markup, /data-message-id="msg-a2a-2"/);
});
