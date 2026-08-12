import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('computeCoworkContextUsage reports usage ratio against the context window', async () => {
  const {
    computeCoworkContextUsage,
  } = await import('../dist-electron/main/libs/coworkContextUsage.js');

  const usage = computeCoworkContextUsage({
    messages: [
      { id: 'user-1', type: 'user', content: 'a'.repeat(4000), timestamp: 1 },
      { id: 'assistant-1', type: 'assistant', content: 'b'.repeat(4000), timestamp: 2 },
    ],
    modelLimits: { contextWindow: 10_000, maxOutputTokens: 1_000 },
  });

  // 4000 ascii chars -> 1000 tokens each, plus 4 frame tokens per message.
  assert.equal(usage.usedTokens, 1004 + 1004);
  assert.equal(usage.contextWindow, 10_000);
  assert.ok(Math.abs(usage.usageRatio - usage.usedTokens / 10_000) < 1e-9);
});

test('computeCoworkContextUsage clamps the ratio to [0, 1]', async () => {
  const {
    computeCoworkContextUsage,
  } = await import('../dist-electron/main/libs/coworkContextUsage.js');

  const overflow = computeCoworkContextUsage({
    messages: [
      { id: 'user-1', type: 'user', content: 'a'.repeat(400_000), timestamp: 1 },
    ],
    modelLimits: { contextWindow: 1_000, maxOutputTokens: 100 },
  });
  assert.equal(overflow.usageRatio, 1);

  const empty = computeCoworkContextUsage({
    messages: [],
    modelLimits: { contextWindow: 128_000, maxOutputTokens: 8_192 },
  });
  assert.equal(empty.usedTokens, 0);
  assert.equal(empty.usageRatio, 0);
  assert.equal(empty.contextWindow, 128_000);
});

test('computeCoworkContextUsage skips thinking/system messages and counts system prompt', async () => {
  const {
    computeCoworkContextUsage,
  } = await import('../dist-electron/main/libs/coworkContextUsage.js');

  const usage = computeCoworkContextUsage({
    messages: [
      {
        id: 'thinking-1',
        type: 'assistant',
        content: 'x'.repeat(50_000),
        timestamp: 1,
        metadata: { isThinking: true },
      },
      { id: 'system-1', type: 'system', content: 'y'.repeat(50_000), timestamp: 2 },
    ],
    systemPrompt: 'z'.repeat(400),
    modelLimits: { contextWindow: 0, maxOutputTokens: 0 },
  });

  // Only the system prompt counts: 400 ascii chars -> 100 tokens.
  assert.equal(usage.usedTokens, 100);
  // A zero context window must never produce a NaN/Infinity ratio.
  assert.equal(usage.usageRatio, 0);
});

test('computeCoworkContextUsage counts only the most recent N messages when capped', async () => {
  const {
    computeCoworkContextUsage,
  } = await import('../dist-electron/main/libs/coworkContextUsage.js');

  // 100 messages of 400 ascii chars each -> 100 tokens + 4 frame tokens each.
  const messages = Array.from({ length: 100 }, (_, index) => ({
    id: `user-${index}`,
    type: 'user',
    content: 'a'.repeat(400),
    timestamp: index + 1,
  }));

  const capped = computeCoworkContextUsage({
    messages,
    modelLimits: { contextWindow: 128_000, maxOutputTokens: 8_192 },
    maxRecentMessages: 80,
  });
  assert.equal(capped.usedTokens, 80 * 104);

  const uncapped = computeCoworkContextUsage({
    messages,
    modelLimits: { contextWindow: 128_000, maxOutputTokens: 8_192 },
  });
  assert.equal(uncapped.usedTokens, 100 * 104);
});

test('context ring estimate is not overridden by the provider whole-request input', () => {
  const mainSource = read('src/main/main.ts');

  // The ring must NOT pass the provider's last-turn input_tokens as the
  // displayed usedTokens. That number is the FULL request payload — the SDK
  // preset system prompt, every MCP/builtin tool definition, and the whole
  // history. On DeepSeek sessions the fixed overhead alone read as hundreds of
  // thousands of tokens (observed 541K for a session whose store history is
  // ~50K tokens), so a conversation that just started showed "54%". The
  // compaction budget (getCoworkContextBudget in coworkRunner.ts) still uses
  // the provider value as its overflow safety net; only the ring's display
  // estimate must stay conversation-only.
  const sessionGetIndex = mainSource.indexOf('cowork:session:get');
  const callStart = mainSource.indexOf('computeCoworkContextUsage({', sessionGetIndex);
  assert.ok(callStart > sessionGetIndex, 'session:get handler must call computeCoworkContextUsage');
  const callChunk = mainSource.slice(callStart, callStart + 600);
  assert.ok(
    !callChunk.includes('realUsageTokens:'),
    'ring estimate must not be overridden by the provider whole-request input'
  );
  assert.ok(
    callChunk.includes('systemPrompt: session.systemPrompt'),
    'ring estimate must keep counting the conversation system prompt'
  );
});
