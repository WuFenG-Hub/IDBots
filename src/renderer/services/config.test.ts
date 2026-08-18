import test from 'node:test';
import assert from 'node:assert/strict';

import type { AppConfig } from '../config';
import {
  applyProviderApiFormatMigrations,
  mergeProvidersConfig,
  PROVIDER_API_FORMAT_MIGRATION_VERSION,
} from './config';

/**
 * Build a minimal AppConfig with just enough shape for the api-format migration
 * (the migration only reads/writes `providers` + the version stamp).
 */
function makeConfig(
  providers: Record<string, unknown>,
  version?: number,
): AppConfig {
  return {
    api: { key: '', baseUrl: '' },
    model: { availableModels: [], defaultModel: '' },
    providers: providers as AppConfig['providers'],
    theme: 'system',
    language: 'zh',
    app: { port: 3000, isDevelopment: false },
    providerApiFormatMigrationVersion: version,
  } as unknown as AppConfig;
}

test('applyProviderApiFormatMigrations upgrades factory-default opencode to responses', () => {
  const config = makeConfig({
    opencode: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiFormat: 'openai',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false, contextWindow: 1_000_000 }],
    },
  });

  const result = applyProviderApiFormatMigrations(config);
  assert.equal(result.providers!.opencode.apiFormat, 'responses');
  assert.equal(result.providerApiFormatMigrationVersion, PROVIDER_API_FORMAT_MIGRATION_VERSION);
});

test('applyProviderApiFormatMigrations migrates opencode even when an API key is configured', () => {
  // An actively-used opencode (filled-in key) still on the legacy 'openai'
  // default must be upgraded to 'responses', matching the product intent that
  // all opencode users move to the Responses endpoint.
  const config = makeConfig({
    opencode: {
      enabled: true,
      apiKey: 'sk-user-key',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiFormat: 'openai',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false, contextWindow: 1_000_000 }],
    },
  });

  const result = applyProviderApiFormatMigrations(config);
  assert.equal(result.providers!.opencode.apiFormat, 'responses');
});

test('applyProviderApiFormatMigrations leaves manually-chosen responses untouched', () => {
  // User already switched to 'responses' — keep it.
  const config = makeConfig({
    opencode: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiFormat: 'responses',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false, contextWindow: 1_000_000 }],
    },
  });

  const result = applyProviderApiFormatMigrations(config);
  assert.equal(result.providers!.opencode.apiFormat, 'responses');
});

test('applyProviderApiFormatMigrations leaves manually-chosen anthropic untouched', () => {
  // A user who deliberately picked the Anthropic-compatible format keeps it.
  const config = makeConfig({
    opencode: {
      enabled: true,
      apiKey: 'sk-user-key',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiFormat: 'anthropic',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false, contextWindow: 1_000_000 }],
    },
  });

  const result = applyProviderApiFormatMigrations(config);
  assert.equal(result.providers!.opencode.apiFormat, 'anthropic');
});

test('applyProviderApiFormatMigrations is idempotent at the current version', () => {
  const config = makeConfig(
    {
      opencode: {
        enabled: false,
        apiKey: '',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        apiFormat: 'openai',
        models: [],
      },
    },
    PROVIDER_API_FORMAT_MIGRATION_VERSION,
  );

  const result = applyProviderApiFormatMigrations(config);
  // Already at target version — no change, not even the field values.
  assert.equal(result.providers!.opencode.apiFormat, 'openai');
});

test('applyProviderApiFormatMigrations does not touch deepseek or other providers', () => {
  const config = makeConfig({
    deepseek: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.deepseek.com',
      apiFormat: 'openai',
      models: [],
    },
    openai: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.openai.com',
      apiFormat: 'openai',
      models: [],
    },
  });

  const result = applyProviderApiFormatMigrations(config);
  assert.equal(result.providers!.deepseek.apiFormat, 'openai');
  assert.equal(result.providers!.openai.apiFormat, 'openai');
});

test('applyProviderApiFormatMigrations v2 moves factory-default deepseek anthropic to openai', () => {
  // Official-harness alignment: configs still parked on the official anthropic
  // endpoint default are migrated to chat completions on the plain base URL.
  const config = makeConfig({
    deepseek: {
      enabled: true,
      apiKey: 'sk-ds',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiFormat: 'anthropic',
      models: [],
    },
  });

  const result = applyProviderApiFormatMigrations(config);
  assert.equal(result.providers!.deepseek.apiFormat, 'openai');
  assert.equal(result.providers!.deepseek.baseUrl, 'https://api.deepseek.com');
  assert.equal(result.providerApiFormatMigrationVersion, PROVIDER_API_FORMAT_MIGRATION_VERSION);
});

test('applyProviderApiFormatMigrations v2 leaves custom deepseek endpoints untouched', () => {
  // A user behind a self-hosted proxy keeps their format and base URL.
  const config = makeConfig({
    deepseek: {
      enabled: true,
      apiKey: 'sk-ds',
      baseUrl: 'https://my-proxy.example/anthropic',
      apiFormat: 'anthropic',
      models: [],
    },
  });

  const result = applyProviderApiFormatMigrations(config);
  assert.equal(result.providers!.deepseek.apiFormat, 'anthropic');
  assert.equal(result.providers!.deepseek.baseUrl, 'https://my-proxy.example/anthropic');
});

test('mergeProvidersConfig rewrites free-provider model names to display names', () => {
  // Users provisioned before the rename have the raw relay id stored as the
  // model name; normalization must map it to the product display name while
  // keeping the wire id (sent to the relay API) untouched.
  const stored = makeConfig({
    'metaid-free': {
      enabled: true,
      apiKey: 'mrk_x',
      baseUrl: 'https://relay.example',
      apiFormat: 'openai',
      models: [{ id: 'deepseek-chat', name: 'deepseek-chat', supportsImage: false }],
    },
    deepseek: {
      enabled: true,
      apiKey: 'sk-ds',
      baseUrl: 'https://api.deepseek.com',
      apiFormat: 'openai',
      models: [{ id: 'deepseek-chat', name: 'deepseek-chat', supportsImage: false }],
    },
  });

  const merged = mergeProvidersConfig(undefined, stored.providers);
  const freeModels = merged!['metaid-free']!.models!;
  assert.equal(freeModels[0].id, 'deepseek-chat');
  assert.equal(freeModels[0].name, 'deepseek-v4-flash');
  // A user-configured provider with the same model id keeps its stored name.
  const deepseekModels = merged!.deepseek!.models!;
  assert.equal(deepseekModels[0].name, 'deepseek-chat');
});
