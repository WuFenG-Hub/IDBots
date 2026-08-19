import test from 'node:test';
import assert from 'node:assert/strict';

let claudeSettings;
try {
  claudeSettings = await import('../dist-electron/main/libs/claudeSettings.js');
} catch {
  claudeSettings = await import('../dist-electron/libs/claudeSettings.js');
}

const { resolveApiConfigForModel, setStoreGetter } = claudeSettings;

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

test('DeepSeek provider key resolves to V4 Flash for MetaBot automation', () => {
  const result = withAppConfig({
    model: {
      defaultModel: 'deepseek-v4-pro',
      availableModels: [],
    },
    providers: {
      deepseek: {
        enabled: true,
        apiKey: 'sk-test',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiFormat: 'anthropic',
        models: [
          { id: 'deepseek-v4-flash' },
          { id: 'deepseek-v4-pro' },
        ],
      },
    },
  }, () => resolveApiConfigForModel('deepseek'));

  assert.equal(result.error, undefined);
  assert.equal(result.config?.model, 'deepseek-v4-flash');
});

test('non-DeepSeek provider key keeps existing provider-default resolution', () => {
  const result = withAppConfig({
    model: {
      defaultModel: 'qwen3-coder-plus',
      availableModels: [],
    },
    providers: {
      qwen: {
        enabled: true,
        apiKey: 'sk-test',
        baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
        apiFormat: 'anthropic',
        models: [
          { id: 'qwen3.5-plus' },
          { id: 'qwen3-coder-plus' },
        ],
      },
    },
  }, () => resolveApiConfigForModel('qwen'));

  assert.equal(result.error, undefined);
  assert.equal(result.config?.model, 'qwen3-coder-plus');
});

test('model id with provider hint resolves to the hinted provider on id collision', () => {
  const config = {
    model: { defaultModel: 'm1', availableModels: [] },
    providers: {
      'custom-relay': {
        enabled: true,
        apiKey: 'rk-test',
        baseUrl: 'https://relay.example.com/anthropic',
        apiFormat: 'anthropic',
        models: [{ id: 'deepseek-v4-pro' }],
      },
      deepseek: {
        enabled: true,
        apiKey: 'sk-test',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiFormat: 'anthropic',
        models: [{ id: 'deepseek-v4-pro' }],
      },
    },
  };

  // Without a hint, config order wins (custom-relay is declared first).
  const byOrder = withAppConfig(config, () => resolveApiConfigForModel('deepseek-v4-pro'));
  assert.equal(byOrder.config?.provider, 'custom-relay');

  // The stored brain provider hint overrides config order.
  const byHint = withAppConfig(config, () =>
    resolveApiConfigForModel('deepseek-v4-pro', 'local', null, 'deepseek'));
  assert.equal(byHint.config?.provider, 'deepseek');
  assert.equal(byHint.config?.model, 'deepseek-v4-pro');

  // A stale hint (provider removed) falls back to the config-order scan.
  const staleHint = withAppConfig(config, () =>
    resolveApiConfigForModel('deepseek-v4-pro', 'local', null, 'gone'));
  assert.equal(staleHint.config?.provider, 'custom-relay');
});

test('getPersistedCoworkEffortLevel converts legacy five-step values onto the four-step ladder', () => {
  const { getPersistedCoworkEffortLevel } = claudeSettings;
  const read = (coworkEffortLevel) =>
    withAppConfig({ coworkEffortLevel }, () => getPersistedCoworkEffortLevel());

  assert.equal(read('low'), 'off', 'legacy 快速(low) means thinking off');
  assert.equal(read('medium'), 'low', 'legacy 标准(medium) maps to low');
  assert.equal(read('high'), 'high');
  assert.equal(read('max'), 'max');
  assert.equal(read('off'), 'off');
  assert.equal(read(null), null);
  assert.equal(read(undefined), null);
  assert.equal(read('turbo'), null);
});

test('resolveModelOptions normalizes legacy reasoningEffort defaults', () => {
  const { resolveModelOptions } = claudeSettings;
  const config = {
    model: { defaultModel: 'm1', availableModels: [] },
    providers: {
      deepseek: {
        enabled: true,
        apiKey: 'sk-test',
        baseUrl: 'https://api.deepseek.com',
        apiFormat: 'anthropic',
        models: [
          { id: 'm1', options: { reasoningEffort: 'medium', thinking: { type: 'enabled' } } },
        ],
      },
    },
  };
  const options = withAppConfig(config, () => resolveModelOptions('m1'));
  assert.equal(options?.reasoningEffort, 'low', 'legacy medium default becomes low');
  assert.deepEqual(options?.thinking, { type: 'enabled' });
});
