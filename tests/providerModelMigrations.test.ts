import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyProviderApiFormatMigrations,
  applyProviderModelMigrations,
  PROVIDER_MODEL_MIGRATION_VERSION,
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
  assert.equal(migrated.providerModelMigrationVersion, PROVIDER_MODEL_MIGRATION_VERSION);
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
  assert.equal(migrated.providerModelMigrationVersion, PROVIDER_MODEL_MIGRATION_VERSION);
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

// ---------------------------------------------------------------------------
// Model migration v3 (2026-09-28): GLM-5.3-Flash vision flip across every
// provider. The SKU is natively multimodal and all gateways proxy the same
// upstream model, but rows created before the capability was known carry the
// fail-safe supportsImage:false default — which kept every gateway-served
// GLM-5.3 Flash from reading images. The flip is one-shot (version-stamped)
// and idempotent.
// ---------------------------------------------------------------------------

/** The stored-config shape of the 2026-09-28 incident machine. */
function glmFlashGatewayConfig(): unknown {
  return {
    model: { defaultModel: 'glm-5.3-flash' },
    providerModelMigrationVersion: 2,
    providers: {
      opencode: {
        enabled: true,
        apiKey: 'sk-oc',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        models: [
          { id: 'glm-5.3-flash', name: 'glm-5.3-flash', supportsImage: false },
          { id: 'glm-5.3', name: 'glm-5.3', supportsImage: false },
        ],
      },
      commandcode: {
        enabled: true,
        apiKey: 'sk-cc',
        baseUrl: 'https://api.commandcode.ai/provider/v1',
        models: [
          { id: 'z-ai/glm-5.3-flash', name: 'GLM-5.3 Flash', supportsImage: false, contextWindow: 1_048_576 },
        ],
      },
      'custom-scnet': {
        enabled: true,
        apiKey: 'sk-sc',
        baseUrl: 'https://api.scnet.cn/api/llm/v1',
        models: [
          { id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash', supportsImage: false },
        ],
      },
      zhipu: {
        enabled: true,
        apiKey: 'sk-zp',
        baseUrl: 'https://open.bigmodel.cn/api/v1',
        models: [
          { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', supportsImage: true, contextWindow: 1_048_576 },
        ],
      },
      deepseek: {
        enabled: true,
        apiKey: 'sk-ds',
        baseUrl: 'https://api.deepseek.com',
        models: [
          { id: 'glm-5.3-flash', name: 'hypothetical deepseek-row copy', supportsImage: false },
        ],
      },
    },
  };
}

test('model migration v3 flips GLM-5.3-Flash rows to vision on every provider (gateway prefixes and case variants included)', () => {
  const migrated = applyProviderModelMigrations(asConfig(glmFlashGatewayConfig()));

  const byId = (provider: string, id: string) =>
    migrated.providers[provider]!.models!.find((model) => model.id === id)!;

  // Bare gateway id — the fail-safe false default becomes true.
  assert.equal(byId('opencode', 'glm-5.3-flash').supportsImage, true);
  // Vendor-prefixed id matches on the last path segment.
  assert.equal(byId('commandcode', 'z-ai/glm-5.3-flash').supportsImage, true);
  // Case variants match case-insensitively.
  assert.equal(byId('custom-scnet', 'GLM-5.3-Flash').supportsImage, true);
  // Already-checked rows are untouched (same value).
  assert.equal(byId('zhipu', 'glm-5.3-flash').supportsImage, true);
  // The text-only flagship never flips.
  assert.equal(byId('opencode', 'glm-5.3').supportsImage, false);
  // deepseek never participates in model migrations.
  assert.equal(byId('deepseek', 'glm-5.3-flash').supportsImage, false);
  assert.equal(migrated.providerModelMigrationVersion, PROVIDER_MODEL_MIGRATION_VERSION);
});

test('model migration v3 is idempotent — a second pass changes nothing', () => {
  const once = applyProviderModelMigrations(asConfig(glmFlashGatewayConfig()));
  const twice = applyProviderModelMigrations(once);
  assert.deepEqual(twice.providers, once.providers);
  assert.equal(twice.providerModelMigrationVersion, PROVIDER_MODEL_MIGRATION_VERSION);
});

test('v3-stamped configs run no migrations at all', () => {
  const stamped = asConfig({
    ...glmFlashGatewayConfig(),
    providerModelMigrationVersion: PROVIDER_MODEL_MIGRATION_VERSION,
  });
  const migrated = applyProviderModelMigrations(stamped);
  assert.equal(migrated.providers.opencode!.models![0].supportsImage, false);
  assert.equal(migrated.providerModelMigrationVersion, PROVIDER_MODEL_MIGRATION_VERSION);
});
