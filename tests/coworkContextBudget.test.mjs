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

// ---------------------------------------------------------------------------
// GT#12 N4: budget evaluation trigger must be decoupled from claudeSessionId.
// After a DeepSeek reasoning-history reset claudeSessionId is null while the
// store history keeps growing; gating on it skipped snip/compact entirely.
// ---------------------------------------------------------------------------

test('N4: shouldEvaluateCoworkContextBudget evaluates with claudeSessionId present', async () => {
  const { shouldEvaluateCoworkContextBudget } = await loadRunner();

  assert.equal(shouldEvaluateCoworkContextBudget({
    claudeSessionId: 'sdk-abc',
    isRetry: false,
    messageCount: 5,
  }), true);
  assert.equal(shouldEvaluateCoworkContextBudget({
    claudeSessionId: 'sdk-abc',
    isRetry: false,
    messageCount: 0,
  }), true);
});

test('N4: reset scenario — null claudeSessionId with growing history still evaluates', async () => {
  const { shouldEvaluateCoworkContextBudget } = await loadRunner();

  // The diagnosed failure: deepseek reset cleared claudeSessionId, history
  // kept growing to 605K chars, and the old gate skipped budget checks.
  assert.equal(shouldEvaluateCoworkContextBudget({
    claudeSessionId: null,
    isRetry: false,
    messageCount: 300,
  }), true);
  assert.equal(shouldEvaluateCoworkContextBudget({
    claudeSessionId: null,
    isRetry: false,
    messageCount: 1,
  }), true);
});

test('N4: brand-new session with no history still skips the first run', async () => {
  const { shouldEvaluateCoworkContextBudget } = await loadRunner();

  assert.equal(shouldEvaluateCoworkContextBudget({
    claudeSessionId: null,
    isRetry: false,
    messageCount: 0,
  }), false);
});

test('N4: automatic error-retry re-runs never evaluate (no double compaction)', async () => {
  const { shouldEvaluateCoworkContextBudget } = await loadRunner();

  assert.equal(shouldEvaluateCoworkContextBudget({
    claudeSessionId: 'sdk-abc',
    isRetry: true,
    messageCount: 300,
  }), false);
  assert.equal(shouldEvaluateCoworkContextBudget({
    claudeSessionId: null,
    isRetry: true,
    messageCount: 300,
  }), false);
});

// --- loadRunner: load the compiled coworkRunner module with an electron mock ---
import Module from 'node:module';
import path from 'node:path';

const require = Module.createRequire(import.meta.url);

async function loadRunner() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => path.join(process.cwd(), '.cowork-temp', 'cowork-budget-trigger-test-user-data'),
        },
        session: { defaultSession: { resolveProxy: async () => 'DIRECT' } },
      };
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    return require('../dist-electron/main/libs/coworkRunner.js');
  } finally {
    Module._load = originalLoad;
  }
}

// ---------------------------------------------------------------------------
// Phase 2: the provider-reported real context size drives the estimate.
// ---------------------------------------------------------------------------

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

test('getCoworkContextBudget prefers real context size over stale store history after compaction', async () => {
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

  // The store history is huge (heuristic ~1000 tokens) but the SDK session was
  // just compacted (real last-turn context = 10 tokens). The real value wins so
  // a post-compaction turn does not immediately re-trigger tier-2 compaction.
  const withLowReal = getCoworkContextBudget({
    messages,
    modelLimits: { contextWindow: 1_000_000, maxOutputTokens: 32_768 },
    softThresholdRatio: 0.82,
    realUsageTokens: 10,
  });
  assert.equal(withLowReal.estimatedTokens, 10);
  assert.equal(withLowReal.shouldCompact, false);

  // Zero / non-finite real usage behaves like missing → heuristic fallback.
  const withoutReal = getCoworkContextBudget({
    messages,
    modelLimits: { contextWindow: 1_000_000, maxOutputTokens: 32_768 },
    softThresholdRatio: 0.82,
  });
  const withZero = getCoworkContextBudget({
    messages,
    modelLimits: { contextWindow: 1_000_000, maxOutputTokens: 32_768 },
    softThresholdRatio: 0.82,
    realUsageTokens: 0,
  });
  assert.equal(withZero.estimatedTokens, withoutReal.estimatedTokens);
  assert.ok(withoutReal.estimatedTokens > 10);
});

test('getCoworkContextBudget adds the new prompt on top of the real context size', async () => {
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
  ];

  const withPrompt = getCoworkContextBudget({
    messages,
    currentPrompt: 'x'.repeat(4_000),
    modelLimits: { contextWindow: 1_000_000, maxOutputTokens: 32_768 },
    softThresholdRatio: 0.82,
    realUsageTokens: 1_000,
  });
  // 4_000 ASCII chars ≈ 1_000 tokens + 4 frame overhead.
  assert.equal(withPrompt.estimatedTokens, 1_000 + 1_000 + 4);
});

test('getCoworkContextBudget ignores provider-reported usage above the model window (gateway per-turn totals)', async () => {
  const {
    getCoworkContextBudget,
  } = await import('../dist-electron/main/libs/coworkContextBudget.js');

  const messages = [
    {
      id: 'user-1',
      type: 'user',
      content: 'hello world',
      timestamp: 1,
    },
  ];

  // A 1M-window model must never be driven by a "3.9M used" provider number:
  // some DeepSeek gateways report per-turn totals far above the window. The
  // budget falls back to the store-history heuristic instead.
  const budget = getCoworkContextBudget({
    messages,
    modelLimits: { contextWindow: 1_000_000, maxOutputTokens: 32_768 },
    softThresholdRatio: 0.82,
    realUsageTokens: 3_884_612,
  });

  const withoutReal = getCoworkContextBudget({
    messages,
    modelLimits: { contextWindow: 1_000_000, maxOutputTokens: 32_768 },
    softThresholdRatio: 0.82,
  });

  assert.equal(budget.estimatedTokens, withoutReal.estimatedTokens);
  assert.ok(budget.estimatedTokens < 100);
  assert.equal(budget.shouldCompact, false);
});

test('getCoworkContextBudget still trusts plausible in-window provider usage', async () => {
  const {
    getCoworkContextBudget,
  } = await import('../dist-electron/main/libs/coworkContextBudget.js');

  const budget = getCoworkContextBudget({
    messages: [],
    modelLimits: { contextWindow: 1_000_000, maxOutputTokens: 32_768 },
    softThresholdRatio: 0.82,
    realUsageTokens: 450_986,
  });

  assert.equal(budget.estimatedTokens, 450_986);
  assert.equal(budget.shouldCompact, false);
});
