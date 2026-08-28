import test from 'node:test';
import assert from 'node:assert/strict';

import { ALL_PROVIDER_KEYS, defaultConfig } from '../src/renderer/config.ts';
import { mergeProvidersConfig } from '../src/renderer/services/config.ts';
import { buildOpenAICompatibleChatCompletionsUrl } from '../src/renderer/services/llmConnection.ts';

/** Built-in Command Code gateway preset (model settings page). */
const COMMAND_CODE_BASE_URL = 'https://api.commandcode.ai/provider/v1';

test('commandcode preset ships enabled=false with the managed gateway base URL', () => {
  const preset = defaultConfig.providers?.commandcode;
  assert.ok(preset, 'commandcode must exist in defaultConfig.providers');
  assert.equal(preset.enabled, false);
  assert.equal(preset.apiKey, '');
  assert.equal(preset.baseUrl, COMMAND_CODE_BASE_URL);
  // The Settings UI hides Base URL + API-format for managed providers and pins
  // Chat Completions, mirroring the DeepSeek key-only setup.
  assert.equal(preset.apiFormat, 'openai');
});

test('commandcode model catalog mirrors the gateway /models snapshot', () => {
  const models = defaultConfig.providers?.commandcode?.models ?? [];
  assert.ok(models.length >= 61, `expected at least 61 catalog models, got ${models.length}`);
  const ids = new Set<string>();
  for (const model of models) {
    assert.ok(model.id, 'every catalog model needs an id');
    assert.ok(!ids.has(model.id), `duplicate model id in commandcode catalog: ${model.id}`);
    ids.add(model.id);
    assert.ok(model.name, `catalog model ${model.id} needs a display name`);
    assert.ok(
      typeof model.contextWindow === 'number' && model.contextWindow > 0,
      `catalog model ${model.id} needs a positive contextWindow`
    );
  }
  // Spot-check vendor coverage across the multi-upstream gateway.
  for (const expected of [
    'claude-opus-5',
    'gpt-5.6-sol',
    'deepseek/deepseek-v4-pro',
    'moonshotai/Kimi-K3',
    'zai-org/GLM-5.3',
    'MiniMaxAI/MiniMax-M3',
    'Qwen/Qwen3.8-Max',
    'google/gemini-3.7-flash',
    'xai/grok-4.6',
  ]) {
    assert.ok(ids.has(expected), `expected ${expected} in the commandcode catalog`);
  }
});

test('Command Code sits right below OpenCode on the Model settings page', () => {
  const keys = ALL_PROVIDER_KEYS as readonly string[];
  const opencodeIndex = keys.indexOf('opencode');
  assert.equal(keys[opencodeIndex + 1], 'commandcode');
});

test('commandcode preset base URL joins into the gateway Chat Completions endpoint', () => {
  // The stored preset must resolve to the live POST target of the pinned
  // OpenAI-format flow, not just hold the right string in config.
  assert.equal(
    buildOpenAICompatibleChatCompletionsUrl(COMMAND_CODE_BASE_URL, 'commandcode'),
    'https://api.commandcode.ai/provider/v1/chat/completions'
  );
});

test('existing users get commandcode merged in without losing stored providers', () => {
  const legacyProviders = {
    deepseek: {
      enabled: true,
      apiKey: 'sk-legacy',
      baseUrl: 'https://api.deepseek.com',
      apiFormat: 'openai' as const,
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
    },
    openai: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.openai.com',
      apiFormat: 'openai' as const,
    },
  };
  const merged = mergeProvidersConfig(legacyProviders) as Record<string, any>;
  assert.ok(merged.commandcode, 'merge must surface commandcode for pre-existing users');
  assert.equal(merged.commandcode.baseUrl, COMMAND_CODE_BASE_URL);
  assert.equal(merged.commandcode.models?.length >= 61, true);
  // Stored provider state survives untouched.
  assert.equal(merged.deepseek.enabled, true);
  assert.equal(merged.deepseek.apiKey, 'sk-legacy');
});
