import test from 'node:test';
import assert from 'node:assert/strict';

const { backfillFreeBrainFallbacks, collectUsablePaidProviderKeys } = await import('../dist-electron/main/services/brainFallbackBackfill.js');

function makeStore(bots) {
  return {
    listMetabots: () => bots,
    updateMetabot: (id, input) => {
      const bot = bots.find((candidate) => candidate.id === id);
      if (!bot) return null;
      Object.assign(bot, input);
      return bot;
    },
  };
}

const FREE_PROVIDER = {
  enabled: true,
  apiKey: 'relay-key',
  baseUrl: 'https://relay.example.com/v1',
  models: [{ id: 'deepseek-4.1-flash' }],
};

const DEEPSEEK_PROVIDER = {
  enabled: true,
  apiKey: 'sk-test',
  baseUrl: 'https://api.deepseek.com/anthropic',
  models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
};

function freePrimaryBot(id, extra = {}) {
  return { id, name: `bot-${id}`, llm_id: 'deepseek-4.1-flash', llm_provider: 'metaid-free', fallback_llm_id: null, ...extra };
}

test('backfill seeds the fallback brain of a free-primary bot that has none', () => {
  const bots = [freePrimaryBot(1)];
  const result = backfillFreeBrainFallbacks({
    metabotStore: makeStore(bots),
    getAppConfig: () => ({ providers: { 'metaid-free': FREE_PROVIDER, deepseek: DEEPSEEK_PROVIDER } }),
    log: () => {},
  });
  assert.equal(result.backfilled, 1);
  assert.equal(result.sourceProvider, 'deepseek');
  assert.equal(bots[0].fallback_llm_id, 'deepseek-flash');
  assert.equal(bots[0].fallback_llm_provider, 'deepseek');
  assert.equal(bots[0].fallback_llm_effort, null);
});

test('backfill prefers the app default model when the source provider serves it', () => {
  const bots = [freePrimaryBot(1)];
  backfillFreeBrainFallbacks({
    metabotStore: makeStore(bots),
    getAppConfig: () => ({
      model: { defaultModel: 'deepseek-v4-pro' },
      providers: { 'metaid-free': FREE_PROVIDER, deepseek: DEEPSEEK_PROVIDER },
    }),
    log: () => {},
  });
  assert.equal(bots[0].fallback_llm_id, 'deepseek-v4-pro');
});

test('backfill skips bots with a fallback brain and bots on a paid primary', () => {
  const bots = [
    freePrimaryBot(1, { fallback_llm_id: 'some-model', fallback_llm_provider: 'qwen' }),
    freePrimaryBot(2, { llm_id: 'deepseek-flash', llm_provider: 'deepseek' }),
  ];
  const result = backfillFreeBrainFallbacks({
    metabotStore: makeStore(bots),
    getAppConfig: () => ({ providers: { 'metaid-free': FREE_PROVIDER, deepseek: DEEPSEEK_PROVIDER } }),
    log: () => {},
  });
  assert.equal(result.backfilled, 0);
  assert.equal(result.skippedHasFallback, 1);
  assert.equal(result.skippedNotFree, 1);
  assert.equal(bots[0].fallback_llm_id, 'some-model');
  assert.equal(bots[1].fallback_llm_id, null);
});

test('backfill covers legacy free-primary bots without a provider hint', () => {
  // Legacy rows carry no llm_provider; an llm_id served by the free provider
  // still marks the primary brain as free-riding.
  const bots = [freePrimaryBot(1, { llm_provider: null })];
  const result = backfillFreeBrainFallbacks({
    metabotStore: makeStore(bots),
    getAppConfig: () => ({ providers: { 'metaid-free': FREE_PROVIDER, deepseek: DEEPSEEK_PROVIDER } }),
    log: () => {},
  });
  assert.equal(result.backfilled, 1);
  assert.equal(bots[0].fallback_llm_provider, 'deepseek');
});

test('backfill is idempotent across runs', () => {
  const bots = [freePrimaryBot(1)];
  const deps = {
    metabotStore: makeStore(bots),
    getAppConfig: () => ({ providers: { 'metaid-free': FREE_PROVIDER, deepseek: DEEPSEEK_PROVIDER } }),
    log: () => {},
  };
  assert.equal(backfillFreeBrainFallbacks(deps).backfilled, 1);
  assert.equal(backfillFreeBrainFallbacks(deps).backfilled, 0);
});

test('onlyProviderKeys restricts the fallback source to the newly usable providers', () => {
  const bots = [freePrimaryBot(1)];
  const result = backfillFreeBrainFallbacks({
    metabotStore: makeStore(bots),
    getAppConfig: () => ({
      providers: {
        'metaid-free': FREE_PROVIDER,
        deepseek: DEEPSEEK_PROVIDER,
        qwen: { enabled: true, apiKey: 'sk-q', baseUrl: 'https://qwen.example.com', models: [{ id: 'qwen3.5-plus' }] },
      },
    }),
    onlyProviderKeys: ['qwen'],
    log: () => {},
  });
  assert.equal(result.sourceProvider, 'qwen');
  assert.equal(bots[0].fallback_llm_id, 'qwen3.5-plus');
});

test('backfill is a no-op when no usable non-free provider exists', () => {
  const bots = [freePrimaryBot(1)];
  const result = backfillFreeBrainFallbacks({
    metabotStore: makeStore(bots),
    getAppConfig: () => ({ providers: { 'metaid-free': FREE_PROVIDER } }),
    log: () => {},
  });
  assert.equal(result.backfilled, 0);
  assert.equal(result.sourceProvider, null);
  assert.equal(bots[0].fallback_llm_id, null);
});

test('collectUsablePaidProviderKeys excludes free, disabled, key-less and model-less providers', () => {
  const keys = collectUsablePaidProviderKeys({
    providers: {
      'metaid-free': FREE_PROVIDER,
      disabled: { enabled: false, apiKey: 'sk', models: [{ id: 'm' }] },
      keyless: { enabled: true, apiKey: '', models: [{ id: 'm' }] },
      modelfree: { enabled: true, apiKey: 'sk', models: [] },
      ollama: { enabled: true, apiKey: '', models: [{ id: 'llama3' }] },
      deepseek: DEEPSEEK_PROVIDER,
    },
  });
  assert.deepEqual(keys, ['ollama', 'deepseek']);
});
