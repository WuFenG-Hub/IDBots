import assert from 'node:assert/strict';
import test from 'node:test';

import {
  A2A_GUIDANCE_RESTART_MAX_CONTEXT_LINE_CHARS,
  A2A_GUIDANCE_RESTART_MAX_TOKENS,
  buildA2AGuidanceRestartPrompt,
  generateA2AGuidanceRestartMessage,
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

test('buildA2AGuidanceRestartPrompt routes guidance through the shared operator-guidance block', () => {
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
  assert.match(prompts.systemPrompt, /BobBot: hello/);
  assert.match(prompts.systemPrompt, /AliceBot: bye/);
  // Guidance lives in the shared system-prompt block (same persona rules as
  // regular guided turns), not verbatim in the user prompt.
  assert.match(prompts.systemPrompt, /Human Operator Guidance/);
  assert.match(prompts.systemPrompt, /Never relay guidance verbatim/i);
  assert.match(prompts.systemPrompt, /Never attribute statements to the operator/i);
  assert.match(prompts.systemPrompt, /先温和地重新打开话题/);
  assert.match(prompts.userPrompt, /Write the next outgoing private-chat message now/);
  assert.doesNotMatch(prompts.userPrompt, /先温和地重新打开话题/);
});

test('generateA2AGuidanceRestartMessage retries empty replies and returns the first non-empty reply', async () => {
  const calls: Array<{ signal?: AbortSignal }> = [];
  const reply = await generateA2AGuidanceRestartMessage({
    systemPrompt: 'sys',
    userPrompt: 'user',
    llmId: 'llm-1',
    performChat: async (_system, _user, _llmId, options) => {
      calls.push({ signal: options?.signal });
      return calls.length === 1 ? '   ' : '  重新打个招呼。  ';
    },
  });

  assert.equal(reply, '重新打个招呼。');
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.signal instanceof AbortSignal), true);
});

test('generateA2AGuidanceRestartMessage returns empty string after all attempts return empty', async () => {
  let calls = 0;
  const reply = await generateA2AGuidanceRestartMessage({
    systemPrompt: 'sys',
    userPrompt: 'user',
    performChat: async () => {
      calls += 1;
      return '';
    },
  });

  assert.equal(reply, '');
  assert.equal(calls, 2);
});

test('generateA2AGuidanceRestartMessage rethrows the last error after all attempts fail', async () => {
  let calls = 0;
  await assert.rejects(
    generateA2AGuidanceRestartMessage({
      systemPrompt: 'sys',
      userPrompt: 'user',
      performChat: async () => {
        calls += 1;
        throw new Error(`LLM request failed: attempt ${calls}`);
      },
    }),
    /attempt 2/
  );
  assert.equal(calls, 2);
});

test('generateA2AGuidanceRestartMessage does not retry after a successful first attempt', async () => {
  let calls = 0;
  const reply = await generateA2AGuidanceRestartMessage({
    systemPrompt: 'sys',
    userPrompt: 'user',
    performChat: async () => {
      calls += 1;
      return 'ok';
    },
  });

  assert.equal(reply, 'ok');
  assert.equal(calls, 1);
});

test('buildA2AGuidanceRestartPrompt truncates overlong recent messages', () => {
  const longContent = '长'.repeat(A2A_GUIDANCE_RESTART_MAX_CONTEXT_LINE_CHARS * 3);
  const prompts = buildA2AGuidanceRestartPrompt({
    localName: 'AliceBot',
    peerName: 'BobBot',
    guidance: '重新打开话题。',
    messages: [message('1', longContent, { direction: 'incoming' })],
  });

  const embeddedLine = prompts.systemPrompt
    .split('\n')
    .find((line) => line.startsWith('BobBot: '));
  assert.ok(embeddedLine, 'expected the recent message line to be embedded');
  assert.equal(embeddedLine!.length, A2A_GUIDANCE_RESTART_MAX_CONTEXT_LINE_CHARS + 1);
  assert.ok(embeddedLine!.endsWith('…'));
});

test('generateA2AGuidanceRestartMessage passes a generous maxTokens budget to performChat', async () => {
  const seenMaxTokens: Array<number | undefined> = [];
  await generateA2AGuidanceRestartMessage({
    systemPrompt: 'sys',
    userPrompt: 'user',
    performChat: async (_system, _user, _llmId, options) => {
      seenMaxTokens.push(options?.maxTokens);
      return 'ok';
    },
  });

  assert.deepEqual(seenMaxTokens, [A2A_GUIDANCE_RESTART_MAX_TOKENS]);
  assert.ok(A2A_GUIDANCE_RESTART_MAX_TOKENS > 2048);
});

test('generateA2AGuidanceRestartMessage honors an explicit maxTokens override', async () => {
  const seenMaxTokens: Array<number | undefined> = [];
  await generateA2AGuidanceRestartMessage({
    systemPrompt: 'sys',
    userPrompt: 'user',
    maxTokens: 8192,
    performChat: async (_system, _user, _llmId, options) => {
      seenMaxTokens.push(options?.maxTokens);
      return 'ok';
    },
  });

  assert.deepEqual(seenMaxTokens, [8192]);
});
