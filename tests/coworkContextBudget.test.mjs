import test from 'node:test';
import assert from 'node:assert/strict';

test('estimateCoworkTextTokens counts CJK more conservatively than ASCII', async () => {
  const {
    estimateCoworkTextTokens,
  } = await import('../dist-electron/main/libs/coworkContextBudget.js');

  assert.equal(estimateCoworkTextTokens('abcd'), 1);
  assert.equal(estimateCoworkTextTokens('你好世界'), 4);
  assert.equal(estimateCoworkTextTokens('hello 世界'), 4);
});

test('getCoworkContextBudget skips thinking and does not double count current prompt', async () => {
  const {
    getCoworkContextBudget,
  } = await import('../dist-electron/main/libs/coworkContextBudget.js');

  const currentPrompt = '继续处理这个问题';
  const messages = [
    {
      id: 'thinking-1',
      type: 'assistant',
      content: 'x'.repeat(50_000),
      timestamp: 1,
      metadata: { isThinking: true },
    },
    {
      id: 'user-1',
      type: 'user',
      content: currentPrompt,
      timestamp: 2,
    },
  ];

  const withoutCurrentPrompt = getCoworkContextBudget({
    messages,
    modelLimits: { contextWindow: 1_000, maxOutputTokens: 100 },
    softThresholdRatio: 0.9,
  });
  const withCurrentPrompt = getCoworkContextBudget({
    messages,
    currentPrompt,
    modelLimits: { contextWindow: 1_000, maxOutputTokens: 100 },
    softThresholdRatio: 0.9,
  });

  assert.equal(withCurrentPrompt.estimatedTokens, withoutCurrentPrompt.estimatedTokens);
  assert.equal(withCurrentPrompt.includedMessages, 1);
});

test('getCoworkContextBudget requests compaction after soft threshold', async () => {
  const {
    getCoworkContextBudget,
  } = await import('../dist-electron/main/libs/coworkContextBudget.js');

  const budget = getCoworkContextBudget({
    messages: [
      {
        id: 'user-1',
        type: 'user',
        content: 'x'.repeat(400),
        timestamp: 1,
      },
    ],
    modelLimits: { contextWindow: 200, maxOutputTokens: 40 },
    softThresholdRatio: 0.5,
  });

  assert.equal(budget.usableInputTokens, 160);
  assert.equal(budget.softThresholdTokens, 80);
  assert.equal(budget.shouldCompact, true);
});

test('isContextWindowExceededError recognizes context overflow without catching DeepSeek thinking history errors', async () => {
  const {
    isContextWindowExceededError,
  } = await import('../dist-electron/main/libs/coworkContextBudget.js');

  assert.equal(
    isContextWindowExceededError('Error: context length exceeded: maximum context length is 200000 tokens'),
    true
  );
  assert.equal(
    isContextWindowExceededError('HTTP 413 Payload Too Large'),
    true
  );
  assert.equal(
    isContextWindowExceededError('IDBotsAPI Error: 400 {"type":"error","error":{"type":"api_error","message":"The reasoning_content in the thinking mode must be passed back to the API."}}'),
    false
  );
});

test('getCoworkContextBudget uses real provider-reported input tokens when higher than the heuristic (Phase 2)', async () => {
  const {
    getCoworkContextBudget,
  } = await import('../dist-electron/main/libs/coworkContextBudget.js');

  const messages = [
    {
      id: 'user-1',
      type: 'user',
      content: 'hello',
      timestamp: 1,
    },
    {
      id: 'assistant-1',
      type: 'assistant',
      content: 'hi there',
      timestamp: 2,
    },
  ];

  // Heuristic estimate is tiny (~4 tokens); the real last-turn context is huge.
  const withReal = getCoworkContextBudget({
    messages,
    modelLimits: { contextWindow: 1_000_000, maxOutputTokens: 32_768 },
    softThresholdRatio: 0.82,
    realUsageTokens: 900_000,
  });
  assert.equal(withReal.estimatedTokens, 900_000);
  assert.equal(withReal.shouldCompact, true);

  const withoutReal = getCoworkContextBudget({
    messages,
    modelLimits: { contextWindow: 1_000_000, maxOutputTokens: 32_768 },
    softThresholdRatio: 0.82,
  });
  assert.ok(withoutReal.estimatedTokens < 100);
  assert.equal(withoutReal.shouldCompact, false);
});

test('getCoworkContextBudget keeps the heuristic as the floor when real usage is stale or missing', async () => {
  const {
    getCoworkContextBudget,
  } = await import('../dist-electron/main/libs/coworkContextBudget.js');

  const messages = [
    {
      id: 'user-1',
      type: 'user',
      content: 'x'.repeat(4_000),
      timestamp: 1,
    },
  ];

  // Real usage below the heuristic must not shrink the estimate.
  const withLowReal = getCoworkContextBudget({
    messages,
    modelLimits: { contextWindow: 1_000_000, maxOutputTokens: 32_768 },
    softThresholdRatio: 0.82,
    realUsageTokens: 10,
  });
  const withoutReal = getCoworkContextBudget({
    messages,
    modelLimits: { contextWindow: 1_000_000, maxOutputTokens: 32_768 },
    softThresholdRatio: 0.82,
  });
  assert.equal(withLowReal.estimatedTokens, withoutReal.estimatedTokens);
  assert.ok(withLowReal.estimatedTokens > 10);

  // Zero / non-finite real usage behaves like missing.
  const withZero = getCoworkContextBudget({
    messages,
    modelLimits: { contextWindow: 1_000_000, maxOutputTokens: 32_768 },
    softThresholdRatio: 0.82,
    realUsageTokens: 0,
  });
  assert.equal(withZero.estimatedTokens, withoutReal.estimatedTokens);
});
