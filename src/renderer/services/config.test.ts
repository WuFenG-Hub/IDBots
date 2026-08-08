import test from 'node:test';
import assert from 'node:assert/strict';

import type { AppConfig } from '../config';
import {
  applyProviderApiFormatMigrations,
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
