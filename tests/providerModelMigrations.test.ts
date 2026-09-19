import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyProviderApiFormatMigrations,
  applyProviderModelMigrations,
} from '../src/renderer/services/config.ts';

type MigrationInput = Parameters<typeof applyProviderModelMigrations>[0];

const asConfig = (value: unknown): MigrationInput => value as MigrationInput;

// The zhipu store shape before the GLM-5.3 coding-plan line: preset catalog
// glm-5.1/5/4.7 on the factory-default anthropic endpoint.
function legacyZhipuConfig(overrides: Record<string, unknown> = {}): unknown {
  return {
    model: { defaultModel: 'glm-5.1' },
    providerModelMigrationVersion: 1,
    providerApiFormatMigrationVersion: 2,
    providers: {
      zhipu: {
        enabled: true,
        apiKey: 'sk-test',
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        apiFormat: 'anthropic',
        models: [
          { id: 'glm-5.1', name: 'GLM 5.1', supportsImage: false, contextWindow: 202_800 },
          { id: 'glm-5', name: 'GLM 5', supportsImage: false, contextWindow: 202_800 },
          { id: 'glm-4.7', name: 'GLM 4.7', supportsImage: false, contextWindow: 204_800 },
          // A user-added custom model — migrations must never touch it.
          { id: 'glm-4.5-air', name: 'GLM 4.5 Air (custom)', supportsImage: false },
        ],
      },
    },
    ...overrides,
  };
}

test('model migration v2 retires the pre-5.3 zhipu presets and injects the GLM-5.3 family', () => {
  const migrated = applyProviderModelMigrations(asConfig(legacyZhipuConfig()));

  const zhipu = migrated.providers.zhipu!;
  assert.deepEqual(
    zhipu.models!.map((model) => model.id),
    ['glm-5.3', 'glm-5.3-flash', 'glm-4.5-air'],
    'new presets prepend, retired presets drop, custom models survive',
  );
  assert.equal(zhipu.models![0].contextWindow, 1_048_576);
  assert.equal(zhipu.models![1].supportsImage, true);
  // The retired default remaps to the new flagship.
  assert.equal(migrated.model.defaultModel, 'glm-5.3');
  assert.equal(migrated.providerModelMigrationVersion, 2);
});

test('model migration v2 is idempotent and leaves deepseek untouched', () => {
  const base = asConfig(legacyZhipuConfig({
    providers: {
      deepseek: {
        enabled: true,
        apiKey: 'sk-ds',
        baseUrl: 'https://api.deepseek.com',
        apiFormat: 'openai',
        models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
      },
      zhipu: (legacyZhipuConfig() as { providers: { zhipu: object } }).providers.zhipu,
    },
  }));
  const once = applyProviderModelMigrations(base);
  const twice = applyProviderModelMigrations(once);

  assert.deepEqual(twice.providers.zhipu, once.providers.zhipu);
  assert.deepEqual(twice.providers.deepseek, base.providers.deepseek, 'deepseek never participates');
});

test('model migrations from version 0 chain v1 then v2: v1-injected glm-5.1 is retired again', () => {
  // A pre-2026-07 store: v1 injects glm-5.1 for zhipu, v2 immediately retires
  // it — the final catalog is the GLM-5.3 family regardless of entry version.
  const migrated = applyProviderModelMigrations(asConfig(legacyZhipuConfig({
    model: { defaultModel: 'glm-4.7' },
    providerModelMigrationVersion: 0,
    providers: {
      zhipu: {
        enabled: false,
        apiKey: '',
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        apiFormat: 'anthropic',
        models: [{ id: 'glm-4.7', name: 'GLM 4.7', supportsImage: false, contextWindow: 204_800 }],
      },
    },
  })));

  assert.deepEqual(
    migrated.providers.zhipu!.models!.map((model) => model.id),
    ['glm-5.3', 'glm-5.3-flash'],
  );
  assert.equal(migrated.model.defaultModel, 'glm-5.3');
  assert.equal(migrated.providerModelMigrationVersion, 2);
});

test('api-format migration v3 moves the factory-default anthropic zhipu config to responses', () => {
  const migrated = applyProviderApiFormatMigrations(asConfig(legacyZhipuConfig()));

  const zhipu = migrated.providers.zhipu!;
  assert.equal(zhipu.apiFormat, 'responses');
  assert.equal(zhipu.baseUrl, 'https://open.bigmodel.cn/api/v1');
  assert.equal(migrated.providerApiFormatMigrationVersion, 3);
  // Already-migrated configs stay put on a second pass.
  const twice = applyProviderApiFormatMigrations(migrated);
  assert.deepEqual(twice.providers.zhipu, zhipu);
});

test('api-format migration v3 never touches custom base URLs or other formats', () => {
  const proxy = applyProviderApiFormatMigrations(asConfig(legacyZhipuConfig({
    providers: {
      zhipu: {
        enabled: true,
        apiKey: 'sk-test',
        baseUrl: 'https://my-proxy.example.com/anthropic',
        apiFormat: 'anthropic',
        models: [],
      },
    },
  })));
  assert.equal(proxy.providers.zhipu!.apiFormat, 'anthropic');
  assert.equal(proxy.providers.zhipu!.baseUrl, 'https://my-proxy.example.com/anthropic');

  const openai = applyProviderApiFormatMigrations(asConfig(legacyZhipuConfig({
    providers: {
      zhipu: {
        enabled: true,
        apiKey: 'sk-test',
        baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        apiFormat: 'openai',
        models: [],
      },
    },
  })));
  assert.equal(openai.providers.zhipu!.apiFormat, 'openai');
  assert.equal(openai.providers.zhipu!.baseUrl, 'https://open.bigmodel.cn/api/coding/paas/v4');
});
