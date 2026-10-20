// The delivery index anchors the professional-mode "Worked for" collapse: the
// last non-thinking assistant message is the always-visible delivery,
// everything earlier is process. (Assistant mode's hover-action toolbar used
// to hang off this one index too; it is now mounted per bubble — narration
// included — see shouldShowAssistantBubbleActions.) This file pins
// findDeliveryAssistantIndex: the last non-thinking assistant message wins.

import test from 'node:test';
import assert from 'node:assert/strict';

import { findDeliveryAssistantIndex } from '../src/renderer/components/cowork/assistantTurnPresentation.js';

const assistant = (id, metadata = {}) => ({
  type: 'assistant',
  message: { id, type: 'assistant', content: `text-${id}`, timestamp: 0, metadata },
});
const system = (id) => ({
  type: 'system',
  message: { id, type: 'system', content: `sys-${id}`, timestamp: 0, metadata: {} },
});

test('delivery index is the last assistant message; narration before it is process', () => {
  const items = [
    assistant('n1', { narration: true }),
    assistant('n2', { narration: true }),
    assistant('reply'),
  ];
  assert.equal(findDeliveryAssistantIndex(items), 2);
});

test('thinking rows never deliver', () => {
  const items = [
    assistant('reply'),
    assistant('thinking-tail', { isThinking: true }),
  ];
  assert.equal(findDeliveryAssistantIndex(items), 0);
});

test('system notices after the reply do not displace it', () => {
  const items = [assistant('reply'), system('s1')];
  assert.equal(findDeliveryAssistantIndex(items), 0);
});

test('no assistant text means no delivery candidate', () => {
  assert.equal(findDeliveryAssistantIndex([]), -1);
  assert.equal(findDeliveryAssistantIndex([system('s1')]), -1);
  assert.equal(findDeliveryAssistantIndex([assistant('t', { isThinking: true })]), -1);
});
