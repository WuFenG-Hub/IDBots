import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildA2AGuidanceRestartPrompt,
  getLatestA2APrivateChatControlState,
  shouldRestartA2APrivateChatForGuidance,
} from '../src/main/services/a2aGuidanceRestart';
import type { CoworkMessage } from '../src/main/coworkStore';

const message = (
  id: string,
  content: string,
  metadata: CoworkMessage['metadata'] = {},
): CoworkMessage => ({
  id,
  type: 'assistant',
  content,
  timestamp: Number(id),
  metadata,
});

test('shouldRestartA2APrivateChatForGuidance treats auto-bye metadata as ended', () => {
  assert.equal(
    shouldRestartA2APrivateChatForGuidance({
      session: { messages: [] },
      sourceChannel: 'metaweb_private',
      mappingMetadata: {
        byeSent: true,
        endedByAutoPolicy: true,
        endedAt: 1_770_000_000,
      },
    }),
    true,
  );
});

test('latest restart control marker reactivates guidance queueing', () => {
  const session = {
    status: 'running',
    messages: [
      message('1', 'bye', { a2aConversationEnded: true }),
      message('2', '我们继续。', { a2aConversationRestarted: true }),
    ],
  };

  assert.equal(getLatestA2APrivateChatControlState(session), 'active');
  assert.equal(
    shouldRestartA2APrivateChatForGuidance({
      session,
      sourceChannel: 'metaweb_private',
      mappingMetadata: { byeSent: true },
    }),
    false,
  );
});

test('completed private A2A sessions restart from guide even after a prior restart marker', () => {
  const session = {
    status: 'completed',
    messages: [
      message('1', 'bye', { a2aConversationEnded: true }),
      message('2', '你好啊，我们又见面了。', { a2aConversationRestarted: true }),
      message('3', 'hi', { direction: 'incoming' }),
      message('4', 'Hi again!', { direction: 'outgoing' }),
    ],
  };

  assert.equal(getLatestA2APrivateChatControlState(session), 'active');
  assert.equal(
    shouldRestartA2APrivateChatForGuidance({
      session,
      sourceChannel: 'metaweb_private',
      mappingMetadata: {
        byeSent: false,
        endedAt: 1_780_673_752_466,
        restartedAt: 1_780_673_770_239,
      },
    }),
    true,
  );
});

test('end control marker requires restart even without mapping bye metadata', () => {
  const session = {
    messages: [
      message('1', 'bye', { a2aConversationEnded: true }),
    ],
  };

  assert.equal(getLatestA2APrivateChatControlState(session), 'ended');
  assert.equal(
    shouldRestartA2APrivateChatForGuidance({
      session,
      sourceChannel: 'metaweb_private',
      mappingMetadata: {},
    }),
    true,
  );
});

test('buildA2AGuidanceRestartPrompt keeps guidance local and summarizes recent A2A context', () => {
  const prompts = buildA2AGuidanceRestartPrompt({
    localName: 'AliceBot',
    peerName: 'BobBot',
    guidance: '先温和地重新打开话题。',
    messages: [
      message('1', 'hello', { direction: 'incoming' }),
      message('2', 'bye', { direction: 'outgoing' }),
    ],
  });

  assert.match(prompts.systemPrompt, /Generate exactly one outgoing private-chat message/);
  assert.match(prompts.systemPrompt, /Use the human operator guidance as private local guidance only/);
  assert.match(prompts.systemPrompt, /BobBot: hello/);
  assert.match(prompts.systemPrompt, /AliceBot: bye/);
  assert.match(prompts.userPrompt, /先温和地重新打开话题/);
});
