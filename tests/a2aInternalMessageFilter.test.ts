import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isA2AOrderRelatedMessage,
  shouldHideA2AInternalMessage,
  lastA2AErrorDetail,
} from '../src/renderer/components/cowork/a2aInternalMessageFilter';
import type { CoworkMessage } from '../src/renderer/types/cowork';

const baseMessage = {
  id: 'msg-1',
  timestamp: 1_785_000_000_000,
};

const asMessage = (partial: Partial<CoworkMessage>): CoworkMessage => ({
  ...baseMessage,
  ...partial,
} as CoworkMessage);

test('non-order tool calls and reasoning are hidden in A2A sessions', () => {
  const toolUse = asMessage({
    type: 'tool_use',
    content: 'Using tool: Read',
    metadata: { toolName: 'Read', sourceChannel: 'metaweb_private' },
  });
  const toolResult = asMessage({
    type: 'tool_result',
    content: 'guangzhou: +22°C',
    metadata: { toolResult: 'guangzhou: +22°C', sourceChannel: 'metaweb_private' },
  });
  const thinking = asMessage({
    type: 'assistant',
    content: '小新提出了5个很棒的点子，我来想想看哪个方向最合适。',
    metadata: { isThinking: true, isStreaming: false, sourceChannel: 'metaweb_private' },
  });
  const internalSystemError = asMessage({
    type: 'system',
    content: 'Error: Cannot find module /tmp/x.js',
    metadata: { error: 'Cannot find module /tmp/x.js' },
  });

  assert.equal(shouldHideA2AInternalMessage(toolUse), true);
  assert.equal(shouldHideA2AInternalMessage(toolResult), true);
  assert.equal(shouldHideA2AInternalMessage(thinking), true);
  assert.equal(shouldHideA2AInternalMessage(internalSystemError), true);
});

test('order-related internal states stay visible for traceability', () => {
  const orderThinking = asMessage({
    type: 'assistant',
    content: '客户支付了服务费，要求使用 weather 技能查询广州天气。',
    metadata: {
      isThinking: true,
      sourceChannel: 'metaweb_private',
      orderMappingExternalConversationId: 'metaweb_order:seller:1:idq1peer',
    },
  });
  const orderToolUse = asMessage({
    type: 'tool_use',
    content: 'Using tool: Bash',
    metadata: {
      toolName: 'Bash',
      sourceChannel: 'metaweb_private',
      orderMappingExternalConversationId: 'metaweb_private:order:idq1peer',
    },
  });
  const orderToolResult = asMessage({
    type: 'tool_result',
    content: 'guangzhou: +22°C',
    metadata: {
      toolResult: 'guangzhou: +22°C',
      orderExecutionTrace: true,
    },
  });
  const orderProtocolBubble = asMessage({
    type: 'assistant',
    content: '[NeedsRating] 你好！广州的天气信息已经为你准备好啦。',
    metadata: {
      direction: 'outgoing',
      simplemsgKind: 'order_protocol',
      txid: 'a'.repeat(64),
    },
  });
  const refundSystemNotice = asMessage({
    type: 'system',
    content: '系统提示：退款已处理完成。',
    metadata: { serviceOrderEvent: 'refunded', paymentTxid: 'b'.repeat(64) },
  });

  assert.equal(shouldHideA2AInternalMessage(orderThinking), false);
  assert.equal(shouldHideA2AInternalMessage(orderToolUse), false);
  assert.equal(shouldHideA2AInternalMessage(orderToolResult), false);
  assert.equal(shouldHideA2AInternalMessage(orderProtocolBubble), false);
  assert.equal(shouldHideA2AInternalMessage(refundSystemNotice), false);
});

test('order protocol tags in content keep a message order-related', () => {
  for (const tag of ['[ORDER]', '[ORDER_STATUS]', '[DELIVERY]', '[NeedsRating]', '[ORDER_END]']) {
    assert.equal(
      isA2AOrderRelatedMessage(asMessage({ type: 'assistant', content: `${tag} hello` })),
      true,
      tag,
    );
  }
  assert.equal(
    isA2AOrderRelatedMessage(asMessage({ type: 'assistant', content: '随便聊聊今晚的天气吧' })),
    false,
  );
});

test('ordinary conversation bubbles and local notices stay visible', () => {
  const incoming = asMessage({
    type: 'user',
    content: '晚上好呀',
    metadata: { direction: 'incoming', sourceChannel: 'metaweb_private', txid: '1'.repeat(64) },
  });
  const outgoing = asMessage({
    type: 'assistant',
    content: '晚上好，小新！',
    metadata: { direction: 'outgoing', sourceChannel: 'metaweb_private', txid: '2'.repeat(64) },
  });
  const endNotice = asMessage({
    type: 'assistant',
    content: '已结束与对方的私聊会话。',
    metadata: { a2aConversationEndSystemNotice: true, suppressRunningStatus: true },
  });
  const failedDelivery = asMessage({
    type: 'assistant',
    content: '这句回复没能广播上链。',
    metadata: { privateChatDeliveryStatus: 'failed', sourceChannel: 'metaweb_private' },
  });
  const plainAssistant = asMessage({ type: 'assistant', content: '普通回复' });

  assert.equal(shouldHideA2AInternalMessage(incoming), false);
  assert.equal(shouldHideA2AInternalMessage(outgoing), false);
  assert.equal(shouldHideA2AInternalMessage(endNotice), false);
  assert.equal(shouldHideA2AInternalMessage(failedDelivery), false);
  assert.equal(shouldHideA2AInternalMessage(plainAssistant), false);
});

test('lastA2AErrorDetail prefers the newest error and strips the Error: prefix', () => {
  const messages = [
    asMessage({
      type: 'system',
      content: 'Error: Working directory does not exist: /tmp/gone',
      metadata: { error: 'Working directory does not exist: /tmp/gone' },
    }),
    asMessage({ type: 'assistant', content: 'later reply' }),
    asMessage({
      type: 'system',
      content: 'Error: Cannot find module /tmp/x.js',
      metadata: { error: 'Cannot find module /tmp/x.js' },
    }),
    asMessage({ type: 'assistant', content: 'newest reply' }),
  ];

  assert.equal(lastA2AErrorDetail(messages), 'Cannot find module /tmp/x.js');
});

test('lastA2AErrorDetail falls back to content and truncates long details', () => {
  const fromContentOnly = [
    asMessage({ type: 'assistant', content: 'reply' }),
    asMessage({ type: 'system', content: 'Error: boom from content' }),
  ];
  assert.equal(lastA2AErrorDetail(fromContentOnly), 'boom from content');

  const longDetail = 'x'.repeat(400);
  const truncated = lastA2AErrorDetail([
    asMessage({ type: 'system', content: 'irrelevant', metadata: { error: longDetail } }),
  ]);
  assert.ok(truncated);
  assert.equal(truncated.length, 240);
  assert.ok(truncated.endsWith('…'));

  assert.equal(lastA2AErrorDetail([asMessage({ type: 'assistant', content: 'no errors' })]), null);
  assert.equal(lastA2AErrorDetail([]), null);
});
