import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultConfig, normalizeDeepSeekAppConfig } from '../src/renderer/config.ts';
import {
  applyDeepSeekEffortDefaultMigrations,
  mergeProvidersConfig,
} from '../src/renderer/services/config.ts';

const legacyAvailableModels = [
  { id: 'deepseek-chat', name: 'DeepSeek Chat', supportsImage: false },
  { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', supportsImage: false },
];

const legacyProviderModels = [
  { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', supportsImage: false },
  { id: 'deepseek-chat', name: 'DeepSeek Chat', supportsImage: false },
];

test('defaultConfig uses DeepSeek V4 Flash and Pro as the built-in DeepSeek defaults', () => {
  assert.deepEqual(
    defaultConfig.model.availableModels.map(({ id, name }) => ({ id, name })),
    [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    ],
  );
  assert.equal(defaultConfig.model.defaultModel, 'deepseek-v4-flash');
  assert.deepEqual(
    defaultConfig.model.availableModels.find(({ id }) => id === 'deepseek-v4-pro')?.options,
    {
      reasoningEffort: 'low',
      thinking: { type: 'enabled' },
    },
  );
  assert.equal(
    defaultConfig.model.availableModels.find(({ id }) => id === 'deepseek-v4-pro')?.contextWindow,
    1_000_000,
  );
  assert.equal(
    defaultConfig.model.availableModels.find(({ id }) => id === 'deepseek-v4-pro')?.maxOutputTokens,
    32_768,
  );
  assert.deepEqual(
    defaultConfig.providers?.deepseek.models?.map(({ id, name }) => ({ id, name })),
    [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    ],
  );
  assert.deepEqual(
    defaultConfig.providers?.deepseek.models?.find(({ id }) => id === 'deepseek-v4-pro')?.options,
    {
      reasoningEffort: 'low',
      thinking: { type: 'enabled' },
    },
  );
  assert.equal(
    defaultConfig.providers?.deepseek.models?.find(({ id }) => id === 'deepseek-v4-pro')?.contextWindow,
    1_000_000,
  );
  assert.equal(
    defaultConfig.providers?.deepseek.models?.find(({ id }) => id === 'deepseek-v4-pro')?.maxOutputTokens,
    32_768,
  );
});

test('normalizeDeepSeekAppConfig migrates legacy DeepSeek defaults in stored config', () => {
  const normalized = normalizeDeepSeekAppConfig({
    ...defaultConfig,
    model: {
      ...defaultConfig.model,
      availableModels: legacyAvailableModels,
      defaultModel: 'deepseek-chat',
    },
    providers: {
      ...defaultConfig.providers!,
      deepseek: {
        ...defaultConfig.providers!.deepseek,
        models: legacyProviderModels,
      },
    },
  });

  assert.equal(normalized.model.defaultModel, 'deepseek-v4-flash');
  assert.deepEqual(
    normalized.model.availableModels.map(({ id }) => id),
    ['deepseek-v4-flash', 'deepseek-v4-pro'],
  );
  assert.deepEqual(
    normalized.model.availableModels.find(({ id }) => id === 'deepseek-v4-pro')?.options,
    {
      reasoningEffort: 'low',
      thinking: { type: 'enabled' },
    },
  );
  assert.equal(
    normalized.model.availableModels.find(({ id }) => id === 'deepseek-v4-pro')?.contextWindow,
    1_000_000,
  );
  assert.equal(
    normalized.model.availableModels.find(({ id }) => id === 'deepseek-v4-pro')?.maxOutputTokens,
    32_768,
  );
  assert.deepEqual(
    normalized.providers?.deepseek.models?.map(({ id }) => id),
    ['deepseek-v4-flash', 'deepseek-v4-pro'],
  );
  assert.deepEqual(
    normalized.providers?.deepseek.models?.find(({ id }) => id === 'deepseek-v4-pro')?.options,
    {
      reasoningEffort: 'low',
      thinking: { type: 'enabled' },
    },
  );
  assert.equal(
    normalized.providers?.deepseek.models?.find(({ id }) => id === 'deepseek-v4-pro')?.contextWindow,
    1_000_000,
  );
  assert.equal(
    normalized.providers?.deepseek.models?.find(({ id }) => id === 'deepseek-v4-pro')?.maxOutputTokens,
    32_768,
  );
});

test('normalizeDeepSeekAppConfig upgrades legacy ids without dropping custom DeepSeek models', () => {
  const normalized = normalizeDeepSeekAppConfig({
    ...defaultConfig,
    model: {
      ...defaultConfig.model,
      availableModels: [
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', supportsImage: false },
        { id: 'deepseek-r1-custom', name: 'DeepSeek R1 Custom', supportsImage: false },
      ],
      defaultModel: 'deepseek-reasoner',
    },
    providers: {
      ...defaultConfig.providers!,
      deepseek: {
        ...defaultConfig.providers!.deepseek,
        models: [
          { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false },
          { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', supportsImage: false },
        ],
      },
    },
  });

  assert.equal(normalized.model.defaultModel, 'deepseek-v4-pro');
  assert.deepEqual(
    normalized.model.availableModels.map(({ id }) => id),
    ['deepseek-v4-pro', 'deepseek-r1-custom'],
  );
  assert.deepEqual(
    normalized.providers?.deepseek.models?.map(({ id }) => id),
    ['deepseek-v4-flash', 'deepseek-v4-pro'],
  );
  assert.deepEqual(
    normalized.providers?.deepseek.models?.find(({ id }) => id === 'deepseek-v4-pro')?.options,
    {
      reasoningEffort: 'low',
      thinking: { type: 'enabled' },
    },
  );
});

test('normalizeDeepSeekAppConfig backfills legacy DeepSeek api config into provider config', () => {
  const normalized = normalizeDeepSeekAppConfig({
    ...defaultConfig,
    api: {
      key: 'legacy-deepseek-key',
      baseUrl: 'https://api.deepseek.com/anthropic',
    },
    providers: {
      ...defaultConfig.providers!,
      deepseek: {
        ...defaultConfig.providers!.deepseek,
        enabled: false,
        apiKey: '',
        baseUrl: 'https://api.deepseek.com',
        apiFormat: 'openai',
      },
    },
  });

  assert.equal(normalized.providers?.deepseek.enabled, true);
  assert.equal(normalized.providers?.deepseek.apiKey, 'legacy-deepseek-key');
  assert.equal(normalized.providers?.deepseek.baseUrl, 'https://api.deepseek.com/anthropic');
  assert.equal(normalized.providers?.deepseek.apiFormat, 'anthropic');
});

test('mergeProvidersConfig preserves existing provider credentials when incoming config is only the default empty template', () => {
  const currentProviders = {
    ...defaultConfig.providers!,
    deepseek: {
      ...defaultConfig.providers!.deepseek,
      enabled: true,
      apiKey: 'deepseek-existing-key',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiFormat: 'anthropic' as const,
    },
    anthropic: {
      ...defaultConfig.providers!.anthropic,
      enabled: true,
      apiKey: 'anthropic-existing-key',
      baseUrl: 'https://api.anthropic.com',
      apiFormat: 'anthropic' as const,
    },
  };

  const merged = mergeProvidersConfig(currentProviders, {
    ...defaultConfig.providers!,
    deepseek: {
      ...defaultConfig.providers!.deepseek,
    },
    anthropic: {
      ...defaultConfig.providers!.anthropic,
    },
  });

  assert.equal(merged?.deepseek.apiKey, 'deepseek-existing-key');
  assert.equal(merged?.deepseek.baseUrl, 'https://api.deepseek.com/anthropic');
  assert.equal(merged?.deepseek.enabled, true);
  assert.equal(merged?.anthropic.apiKey, 'anthropic-existing-key');
  assert.equal(merged?.anthropic.enabled, true);
});

test('mergeProvidersConfig applies explicit provider credential updates', () => {
  const merged = mergeProvidersConfig(
    {
      ...defaultConfig.providers!,
      deepseek: {
        ...defaultConfig.providers!.deepseek,
        enabled: true,
        apiKey: 'old-key',
      },
    },
    {
      ...defaultConfig.providers!,
      deepseek: {
        ...defaultConfig.providers!.deepseek,
        enabled: true,
        apiKey: 'new-key',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiFormat: 'anthropic' as const,
      },
    },
  );

  assert.equal(merged?.deepseek.apiKey, 'new-key');
  assert.equal(merged?.deepseek.baseUrl, 'https://api.deepseek.com/anthropic');
  assert.equal(merged?.deepseek.apiFormat, 'anthropic');
});

test('applyDeepSeekEffortDefaultMigrations rewrites the legacy max factory default to 快速 (low)', () => {
  const legacyOptions = { reasoningEffort: 'max', thinking: { type: 'enabled' } };
  const migrated = applyDeepSeekEffortDefaultMigrations({
    ...defaultConfig,
    model: {
      ...defaultConfig.model,
      availableModels: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false, options: { ...legacyOptions } },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', supportsImage: false, options: { ...legacyOptions } },
      ] as typeof defaultConfig.model.availableModels,
    },
    providers: {
      ...defaultConfig.providers!,
      deepseek: {
        ...defaultConfig.providers!.deepseek,
        models: [
          { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false, options: { ...legacyOptions } },
        ] as NonNullable<typeof defaultConfig.providers>['deepseek']['models'],
      },
    },
  });

  assert.equal(migrated.deepSeekEffortDefaultMigrationVersion, 1);
  for (const model of [...migrated.model.availableModels, ...(migrated.providers?.deepseek.models ?? [])]) {
    assert.equal(model.options?.reasoningEffort, 'low');
    assert.deepEqual(model.options?.thinking, { type: 'enabled' });
  }
});

test('applyDeepSeekEffortDefaultMigrations leaves customized efforts and other providers untouched', () => {
  const customized = { reasoningEffort: 'medium', thinking: { type: 'enabled' } };
  const otherProviderMax = { reasoningEffort: 'max', thinking: { type: 'enabled' } };
  const config = applyDeepSeekEffortDefaultMigrations({
    ...defaultConfig,
    model: {
      ...defaultConfig.model,
      availableModels: [
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', supportsImage: false, options: { ...customized } },
        { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', supportsImage: true, options: { ...otherProviderMax } },
      ] as typeof defaultConfig.model.availableModels,
    },
  });

  assert.equal(config.model.availableModels.find(({ id }) => id === 'deepseek-v4-pro')?.options?.reasoningEffort, 'medium');
  assert.equal(config.model.availableModels.find(({ id }) => id === 'gpt-5.6-sol')?.options?.reasoningEffort, 'max');
});

test('applyDeepSeekEffortDefaultMigrations is one-shot after the version stamp', () => {
  const once = applyDeepSeekEffortDefaultMigrations({
    ...defaultConfig,
    deepSeekEffortDefaultMigrationVersion: 1,
    model: {
      ...defaultConfig.model,
      availableModels: [
        // Deliberately back on max after the migration already ran — a user
        // choice made after upgrade must never be re-stomped.
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', supportsImage: false, options: { reasoningEffort: 'max', thinking: { type: 'enabled' } } },
      ] as typeof defaultConfig.model.availableModels,
    },
  });
  assert.equal(once.model.availableModels[0]?.options?.reasoningEffort, 'max');
});
