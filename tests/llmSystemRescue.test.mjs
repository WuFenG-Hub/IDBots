import test from 'node:test';
import assert from 'node:assert/strict';

const claudeSettings = await import('../dist-electron/main/libs/claudeSettings.js');
const { classifyOneShotLlmTerminalError } = await import('../dist-electron/main/libs/llmTerminalError.js');
const { runWithSystemRescue } = await import('../dist-electron/main/services/llmFallback.js');
const { resolveSystemRescueBrain, setStoreGetter } = claudeSettings;

// ---------------------------------------------------------------------------
// classifyOneShotLlmTerminalError
// ---------------------------------------------------------------------------

test('terminal classifier: relay quota machine codes classify as quota', () => {
  assert.equal(
    classifyOneShotLlmTerminalError(new Error('LLM request failed: 429 {"error":{"code":"free_quota_exhausted"}}')),
    'quota',
  );
  assert.equal(
    classifyOneShotLlmTerminalError(new Error('LLM request failed: 429 {"error":{"code":"quota_exhausted"}}')),
    'quota',
  );
  assert.equal(classifyOneShotLlmTerminalError('LLM request failed: 402 insufficient balance'), 'quota');
  assert.equal(classifyOneShotLlmTerminalError(new Error('Insufficient Credits')), 'quota');
});

test('terminal classifier: credential rejections classify as auth', () => {
  assert.equal(classifyOneShotLlmTerminalError(new Error('LLM request failed: 401 invalid api key')), 'auth');
  assert.equal(classifyOneShotLlmTerminalError(new Error('LLM request failed: 403')), 'auth');
  assert.equal(classifyOneShotLlmTerminalError('Authentication Fails: incorrect api key'), 'auth');
});

test('terminal classifier: model/config failures classify as config', () => {
  assert.equal(classifyOneShotLlmTerminalError(new Error('LLM request failed: 404 model not found')), 'config');
  assert.equal(classifyOneShotLlmTerminalError(new Error('No enabled provider found for model: deepseek-flash')), 'config');
  assert.equal(classifyOneShotLlmTerminalError(new Error('Provider foo is missing base URL.')), 'config');
});

test('terminal classifier: transient shapes never classify', () => {
  // A bare 429 is a rate limit (transient), not a quota death.
  assert.equal(classifyOneShotLlmTerminalError(new Error('LLM request failed: 429 too many requests')), null);
  assert.equal(classifyOneShotLlmTerminalError(new Error('LLM request failed: 500 internal server error')), null);
  assert.equal(classifyOneShotLlmTerminalError(new Error('The operation was aborted due to timeout')), null);
  assert.equal(classifyOneShotLlmTerminalError(new Error('fetch failed: ECONNRESET')), null);
  assert.equal(classifyOneShotLlmTerminalError(null), null);
});

// ---------------------------------------------------------------------------
// runWithSystemRescue
// ---------------------------------------------------------------------------

const silent = () => {};

test('rescue rung fires once after a terminal primary failure with no fallback brain', async () => {
  const attempts = [];
  const rescues = [];
  const result = await runWithSystemRescue(
    { llmId: 'deepseek-4.1-flash', llmProvider: 'metaid-free' },
    async (options) => {
      attempts.push({ llmId: options.llmId, llmProvider: options.llmProvider, effort: options.effort });
      if (options.llmProvider === 'metaid-free') {
        throw new Error('LLM request failed: 429 {"code":"free_quota_exhausted"}');
      }
      return 'ok';
    },
    {
      resolveRescue: (tried) => {
        assert.deepEqual(tried, [{ llmId: 'deepseek-4.1-flash', llmProvider: 'metaid-free' }]);
        return { llmId: 'deepseek-flash', llmProvider: 'deepseek' };
      },
      onRescue: (info) => rescues.push(info),
    },
    silent,
  );
  assert.equal(result, 'ok');
  assert.equal(attempts.length, 2);
  // The rescue attempt drops the caller's effort override (different model family).
  assert.deepEqual(attempts[1], { llmId: 'deepseek-flash', llmProvider: 'deepseek', effort: null });
  assert.equal(rescues.length, 1);
  assert.equal(rescues[0].kind, 'quota');
  assert.equal(rescues[0].toProvider, 'deepseek');
});

test('rescue rung never fires on transient failures', async () => {
  let rescueLookups = 0;
  await assert.rejects(
    runWithSystemRescue(
      { llmId: 'a', llmProvider: 'p1' },
      async () => { throw new Error('LLM request failed: 500 internal server error'); },
      { resolveRescue: () => { rescueLookups += 1; return { llmId: 'b', llmProvider: 'p2' }; } },
      silent,
    ),
    /500 internal server error/,
  );
  assert.equal(rescueLookups, 0);
});

test('rescue rung rethrows the original error when no rescue route exists', async () => {
  await assert.rejects(
    runWithSystemRescue(
      { llmId: 'a', llmProvider: 'metaid-free' },
      async () => { throw new Error('LLM request failed: 429 free_quota_exhausted'); },
      { resolveRescue: () => null },
      silent,
    ),
    /free_quota_exhausted/,
  );
});

test('rescue rung fires after BOTH brains fail terminally, and the combined error names the rescue failure', async () => {
  const triedSeen = [];
  await assert.rejects(
    runWithSystemRescue(
      { llmId: 'm1', llmProvider: 'metaid-free', fallbackLlmId: 'm2', fallbackLlmProvider: 'deepseek' },
      async (options) => {
        if (options.llmProvider === 'rescue-provider') throw new Error('LLM request failed: 503 rescue down');
        throw new Error('LLM request failed: 401 invalid api key');
      },
      {
        resolveRescue: (tried) => {
          triedSeen.push(tried);
          return { llmId: 'm3', llmProvider: 'rescue-provider' };
        },
      },
      silent,
    ),
    (error) => {
      assert.match(error.message, /invalid api key/);
      assert.match(error.message, /system rescue 'm3@rescue-provider' also failed: LLM request failed: 503 rescue down/);
      return true;
    },
  );
  // The resolver saw both configured brains as already-tried.
  assert.deepEqual(triedSeen[0], [
    { llmId: 'm1', llmProvider: 'metaid-free' },
    { llmId: 'm2', llmProvider: 'deepseek' },
  ]);
});

test('a successful fallback brain short-circuits the rescue rung', async () => {
  let rescueLookups = 0;
  const result = await runWithSystemRescue(
    { llmId: 'm1', llmProvider: 'metaid-free', fallbackLlmId: 'm2', fallbackLlmProvider: 'deepseek' },
    async (options) => {
      if (options.llmProvider === 'metaid-free') throw new Error('LLM request failed: 429 free_quota_exhausted');
      return 'fallback-ok';
    },
    { resolveRescue: () => { rescueLookups += 1; return null; } },
    silent,
  );
  assert.equal(result, 'fallback-ok');
  assert.equal(rescueLookups, 0);
});

test('rescue rung is skipped when the caller signal already aborted', async () => {
  const controller = new AbortController();
  let rescueLookups = 0;
  await assert.rejects(
    runWithSystemRescue(
      { llmId: 'a', llmProvider: 'metaid-free', signal: controller.signal },
      async () => {
        controller.abort();
        throw new Error('LLM request failed: 429 free_quota_exhausted');
      },
      { resolveRescue: () => { rescueLookups += 1; return { llmId: 'b', llmProvider: 'p2' }; } },
      silent,
    ),
    /free_quota_exhausted/,
  );
  assert.equal(rescueLookups, 0);
});

// ---------------------------------------------------------------------------
// resolveSystemRescueBrain
// ---------------------------------------------------------------------------

function withAppConfig(appConfig, fn) {
  setStoreGetter(() => ({
    get(key) {
      return key === 'app_config' ? appConfig : null;
    },
  }));
  try {
    return fn();
  } finally {
    setStoreGetter(() => null);
  }
}

const FREE_PROVIDER = {
  enabled: true,
  apiKey: 'relay-key',
  baseUrl: 'https://relay.example.com/v1',
  apiFormat: 'openai',
  models: [{ id: 'deepseek-4.1-flash' }],
};

test('system rescue brain: picks the first enabled keyed non-free provider', () => {
  withAppConfig({
    model: { defaultModel: 'deepseek-4.1-flash', defaultProvider: 'metaid-free' },
    providers: {
      'metaid-free': FREE_PROVIDER,
      deepseek: {
        enabled: true,
        apiKey: 'sk-test',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiFormat: 'anthropic',
        models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
      },
    },
  }, () => {
    // The default model is served only by the free relay, so the rescue brain
    // rides the deepseek provider's own first model.
    assert.deepEqual(resolveSystemRescueBrain(), { llmId: 'deepseek-flash', llmProvider: 'deepseek' });
  });
});

test('system rescue brain: prefers the app default model when the provider serves it', () => {
  withAppConfig({
    model: { defaultModel: 'deepseek-v4-pro' },
    providers: {
      deepseek: {
        enabled: true,
        apiKey: 'sk-test',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiFormat: 'anthropic',
        models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
      },
    },
  }, () => {
    assert.deepEqual(resolveSystemRescueBrain(), { llmId: 'deepseek-v4-pro', llmProvider: 'deepseek' });
  });
});

test('system rescue brain: skips disabled, key-less and model-less providers', () => {
  withAppConfig({
    providers: {
      disabled: { enabled: false, apiKey: 'sk', baseUrl: 'https://a.example.com', models: [{ id: 'm' }] },
      keyless: { enabled: true, apiKey: '', baseUrl: 'https://b.example.com', models: [{ id: 'm' }] },
      modelfree: { enabled: true, apiKey: 'sk', baseUrl: 'https://c.example.com', models: [] },
    },
  }, () => {
    assert.equal(resolveSystemRescueBrain(), null);
  });
});

test('system rescue brain: honors excludeProviders and never offers the free relay', () => {
  withAppConfig({
    providers: {
      'metaid-free': FREE_PROVIDER,
      deepseek: {
        enabled: true,
        apiKey: 'sk-test',
        baseUrl: 'https://api.deepseek.com/anthropic',
        models: [{ id: 'deepseek-flash' }],
      },
      qwen: {
        enabled: true,
        apiKey: 'sk-qwen',
        baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
        models: [{ id: 'qwen3.5-plus' }],
      },
    },
  }, () => {
    assert.deepEqual(
      resolveSystemRescueBrain({ excludeProviders: ['metaid-free', 'deepseek'] }),
      { llmId: 'qwen3.5-plus', llmProvider: 'qwen' },
    );
    assert.equal(resolveSystemRescueBrain({ excludeProviders: ['deepseek', 'qwen'] }), null);
  });
});
