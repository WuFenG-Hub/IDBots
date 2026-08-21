// Runtime config generator: official DeepSeek rides the first-party
// dsh-llm-deepseek adapter.
//
// The native adapter owns the 'deepseek-official' route (chat-completions wire,
// off/low/high/max effort ladder, reasoning in the dedicated reasoning_content
// channel). A route marked `native` must mount a dedicated llm-deepseek plugin
// entry and never enter the llm-pi-ai providers dict; every other provider
// keeps riding pi-ai unchanged.

import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const worktreeRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const generatorUrl = pathToFileURL(path.join(worktreeRoot, 'dsh-runtime', 'lib', 'generate-runtime-config.mjs')).href
const { generateRuntimeConfig } = await import(generatorUrl)

const baseInput = (providers) => ({
  sessionRoot: '/tmp/dsh-native-test',
  providers,
})

const nativeDeepSeekRoute = {
  key: 'deepseek-official',
  apiFormat: 'responses',
  baseUrl: 'https://api.deepseek.com',
  apiKeyEnv: 'IDBOTS_DSH_API_KEY',
  native: true,
  models: [{ id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxOutputTokens: 16_000 }],
}

const entryById = (config, id) => config.find((e) => e.id === id)
const piAiProviders = (config) => entryById(config, 'llm-pi-ai').config.providers

test('native deepseek mounts a dedicated llm-deepseek entry, not a pi-ai route', () => {
  const config = generateRuntimeConfig(baseInput([
    nativeDeepSeekRoute,
    { key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48790/v1', apiKeyEnv: 'K', models: [{ id: 'mock-1', contextWindow: 32_768 }] },
  ]))

  const native = entryById(config, 'llm-deepseek-deepseek-official')
  assert.ok(native, 'native plugin entry present')
  assert.equal(native.name, '@deepseek-ai/dsh-llm-deepseek')
  assert.equal(native.config.apiKeyEnv, 'IDBOTS_DSH_API_KEY')
  assert.equal(native.config.baseURL, 'https://api.deepseek.com')
  assert.equal(native.config.thinking, 'enabled')
  assert.equal(native.config.reasoningEffort, 'high')
  assert.equal(native.config.defaultContextWindow, 1_000_000)
  assert.deepEqual(native.config.models, [
    { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', contextWindow: 1_000_000, maxTokens: 16_000 },
  ])
  // Never a pi-ai route for the native provider; other providers unaffected.
  assert.equal(piAiProviders(config).deepseek, undefined)
  assert.ok(piAiProviders(config).mockgw)
})

test('native baseURL normalization collapses compat-suffix bases onto the host root', () => {
  for (const baseUrl of [
    'https://api.deepseek.com',
    'https://api.deepseek.com/',
    'https://api.deepseek.com/responses',
    'https://api.deepseek.com/anthropic',
    'https://api.deepseek.com/anthropic/v1',
    'https://api.deepseek.com/v1',
  ]) {
    const config = generateRuntimeConfig(baseInput([{ ...nativeDeepSeekRoute, baseUrl }]))
    const native = entryById(config, 'llm-deepseek-deepseek-official')
    assert.equal(native.config.baseURL, 'https://api.deepseek.com', `base ${baseUrl}`)
  }
})

test('model entries without maxOutputTokens fall back to the default ceiling', () => {
  const config = generateRuntimeConfig(baseInput([{
    ...nativeDeepSeekRoute,
    models: [{ id: 'deepseek-v4-flash', contextWindow: 1_000_000 }],
  }]))
  const native = entryById(config, 'llm-deepseek-deepseek-official')
  assert.equal(native.config.models[0].maxTokens, 32_768)
})

test('native vision catalog emits inputModalities and request-image budgets', () => {
  const config = generateRuntimeConfig(baseInput([{
    ...nativeDeepSeekRoute,
    models: [
      { id: 'deepseek-v4-flash', contextWindow: 1_000_000, maxOutputTokens: 32_768 },
      {
        id: 'deepseek-v4-flash-vision-exp',
        contextWindow: 1_000_000,
        maxOutputTokens: 32_768,
        input: ['text', 'image'],
      },
    ],
  }]))
  const native = entryById(config, 'llm-deepseek-deepseek-official')
  assert.equal(native.config.models[0].inputModalities, undefined)
  assert.deepEqual(native.config.models[1], {
    id: 'deepseek-v4-flash-vision-exp',
    name: 'deepseek-v4-flash-vision-exp',
    contextWindow: 1_000_000,
    maxTokens: 32_768,
    inputModalities: ['text', 'image'],
    imagePixelBudget: 640_000,
    imageMaxBytes: 1_048_576,
  })
  assert.equal(
    config.some((e) => e.name === '@deepseek-ai/dsh-authorization'),
    false,
  )
})

test('non-native routes mount nothing native', () => {
  const config = generateRuntimeConfig(baseInput([
    { key: 'mockgw', apiFormat: 'responses', baseUrl: 'http://127.0.0.1:48790/v1', apiKeyEnv: 'K', models: [{ id: 'mock-1', contextWindow: 32_768 }] },
  ]))
  assert.equal(config.filter((e) => e.name === '@deepseek-ai/dsh-llm-deepseek').length, 0)
  assert.ok(piAiProviders(config).mockgw)
})
