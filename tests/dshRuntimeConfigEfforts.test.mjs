// Runtime config generator: DeepSeek effort ladder declarations.
//
// pi-ai's builtin catalog pins low/medium to null for deepseek models, so a
// DeepSeek route without a declared reasoningEfforts map rejects 标准 (low) and
// 深度 (medium) with UNSUPPORTED_REASONING_EFFORT before the request leaves the
// runtime (the 2026-08-18 crash on a fresh V4 Pro session). The generator must
// declare the ladder on both DeepSeek wires, with per-protocol wire spellings.

import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const worktreeRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const generatorUrl = pathToFileURL(path.join(worktreeRoot, 'dsh-runtime', 'lib', 'generate-runtime-config.mjs')).href
const { generateRuntimeConfig } = await import(generatorUrl)

const baseInput = (provider) => ({
  sessionRoot: '/tmp/dsh-efforts-test',
  providers: [provider],
})

const deepseekRoute = (apiFormat) => ({
  key: 'deepseek',
  apiFormat,
  baseUrl: 'https://api.deepseek.com',
  apiKeyEnv: 'IDBOTS_DSH_API_KEY',
  thinkingFormat: 'deepseek',
  models: [{ id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxOutputTokens: 16_000 }],
})

const llmEntry = (config) => config.find((entry) => entry.id === 'llm-pi-ai')

test('responses route declares the verbatim low/medium/high/max ladder', () => {
  const config = llmEntry(generateRuntimeConfig(baseInput(deepseekRoute('responses'))))
  const model = config.config.providers.deepseek.models[0]
  assert.deepEqual(model.reasoningEfforts, {
    off: null,
    low: 'low',
    medium: 'medium',
    high: 'high',
    max: 'max',
  })
  // compat stays completions-only: a responses route must not carry it.
  assert.equal(config.config.providers.deepseek.compat, undefined)
})

test('completions route keeps the off/high/max alias ladder and gains compat', () => {
  const config = llmEntry(generateRuntimeConfig(baseInput(deepseekRoute('openai'))))
  const route = config.config.providers.deepseek
  assert.deepEqual(route.models[0].reasoningEfforts, {
    off: null,
    low: 'high',
    medium: 'high',
    high: 'high',
    max: 'max',
  })
  assert.equal(route.compat.thinkingFormat, 'deepseek')
  assert.equal(route.compat.supportsReasoningEffort, true)
})

test('non-deepseek routes declare nothing', () => {
  const config = llmEntry(generateRuntimeConfig(baseInput({
    key: 'mockgw',
    apiFormat: 'responses',
    baseUrl: 'http://127.0.0.1:48790/v1',
    apiKeyEnv: 'DSH_TEST_KEY',
    models: [{ id: 'mock-1', contextWindow: 32_768 }],
  })))
  assert.equal(config.config.providers.mockgw.models[0].reasoningEfforts, undefined)
})
