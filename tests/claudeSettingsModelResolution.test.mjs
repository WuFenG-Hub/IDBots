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

test('ANY enabled provider key resolves to that provider first/default model (opencode)', () => {
  const providers = {
    opencode: {
      enabled: true,
      apiKey: 'sk-test',
      baseUrl: 'https://opencode.example.com/anthropic',
      apiFormat: 'anthropic',
      models: [{ id: 'oc-flash' }, { id: 'oc-pro' }],
    },
  };

  // Global default not offered by the provider -> the provider's FIRST model.
  const firstModel = withAppConfig({
    model: { defaultModel: 'elsewhere-model', availableModels: [] },
    providers,
  }, () => resolveApiConfigForModel('opencode'));
  assert.equal(firstModel.error, undefined);
  assert.equal(firstModel.config?.provider, 'opencode');
  assert.equal(firstModel.config?.model, 'oc-flash');

  // Global default offered by the provider -> the default model wins
  // (same Fallback-1 rule the startup migration uses).
  const defaultModel = withAppConfig({
    model: { defaultModel: 'oc-pro', availableModels: [] },
    providers,
  }, () => resolveApiConfigForModel('opencode'));
  assert.equal(defaultModel.error, undefined);
  assert.equal(defaultModel.config?.model, 'oc-pro');
});

test('unresolvable override falls back to the default route with a warning (never dead-ends)', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    const result = withAppConfig({
      model: { defaultModel: 'm-default', availableModels: [] },
      providers: {
        deepseek: {
          enabled: true,
          apiKey: 'sk-test',
          baseUrl: 'https://api.deepseek.com/anthropic',
          apiFormat: 'anthropic',
          models: [{ id: 'm-default' }],
        },
      },
    }, () => resolveApiConfigForModel('removed-model-id'));

    assert.equal(result.error, undefined, 'must not fail the turn');
    assert.equal(result.config?.model, 'm-default', 'falls back to the global default route');
    assert.equal(result.config?.provider, 'deepseek');
    assert.ok(
      warnings.some((m) => m.includes("[llm-brain] unresolvable llm_id 'removed-model-id', using default route")),
      `warning missing: ${JSON.stringify(warnings)}`,
    );
  } finally {
    console.warn = originalWarn;
  }
});

test('unresolvable override with no enabled providers still errors', () => {
  const result = withAppConfig({
    model: { defaultModel: 'm-default', availableModels: [] },
    providers: {
      deepseek: {
        enabled: false,
        apiKey: 'sk-test',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiFormat: 'anthropic',
        models: [{ id: 'm-default' }],
      },
    },
  }, () => resolveApiConfigForModel('removed-model-id'));

  assert.equal(result.config, null);
  assert.match(result.error ?? '', /No enabled provider found/);
});

test('resolveDshProviderRoute falls back to the default route and names the bot in the warning', () => {
  const { resolveDshProviderRoute } = claudeSettings;
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    const route = withAppConfig({
      model: { defaultModel: 'm-default', availableModels: [] },
      providers: {
        deepseek: {
          enabled: true,
          apiKey: 'sk-test',
          baseUrl: 'https://api.deepseek.com/anthropic',
          apiFormat: 'anthropic',
          models: [{ id: 'm-default' }],
        },
      },
    }, () => resolveDshProviderRoute('opencode-gone', null, { botId: 7, botName: 'Lucy' }));

    assert.ok(route, 'DSH route must resolve (never null-without-fallback)');
    assert.equal(route.model, 'm-default');
    assert.equal(route.provider, 'deepseek');
    assert.ok(
      warnings.some((m) => m.includes("[llm-brain] bot 7 (Lucy): unresolvable llm_id 'opencode-gone', using default route")),
      `bot-named warning missing: ${JSON.stringify(warnings)}`,
    );
  } finally {
    console.warn = originalWarn;
  }
});

test('resolveDshProviderRoute still returns null when no enabled provider exists', () => {
  const { resolveDshProviderRoute } = claudeSettings;
  const route = withAppConfig({
    model: { defaultModel: 'm-default', availableModels: [] },
    providers: {
      deepseek: {
        enabled: false,
        apiKey: 'sk-test',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiFormat: 'anthropic',
        models: [{ id: 'm-default' }],
      },
    },
  }, () => resolveDshProviderRoute('opencode-gone'));
  assert.equal(route, null);
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

test('OpenCode vs DeepSeek colliding model id uses the provider hint', () => {
  const config = {
    model: { defaultModel: 'deepseek-v4-flash', availableModels: [] },
    providers: {
      deepseek: {
        enabled: true,
        apiKey: 'sk-test',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiFormat: 'anthropic',
        models: [{ id: 'deepseek-v4-flash' }],
      },
      opencode: {
        enabled: true,
        apiKey: 'sk-oc',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        apiFormat: 'anthropic',
        models: [{ id: 'deepseek-v4-flash' }],
      },
    },
  };

  const byOrder = withAppConfig(config, () => resolveApiConfigForModel('deepseek-v4-flash'));
  assert.equal(byOrder.config?.provider, 'deepseek');

  const byHint = withAppConfig(config, () =>
    resolveApiConfigForModel('deepseek-v4-flash', 'local', null, 'opencode'));
  assert.equal(byHint.config?.provider, 'opencode');
  assert.equal(byHint.config?.model, 'deepseek-v4-flash');
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
