// OpenCode Go gateway per-model protocol resolution.
//
// The gateway serves each model over exactly ONE wire protocol and answers
// every other protocol with HTTP 400 ModelProtocolUnsupported — while the app
// configures ONE provider-level apiFormat for the whole 'opencode' provider.
// The 'responses' default works for deepseek (verified live by the 2026-10-13
// incident reporter) but sends GLM to /v1/responses, which the gateway does
// not serve for that family: the reporter's glm-5.3-flash turns died with
// `{"type":"ModelProtocolUnsupported","message":"Model does not support this
// protocol."}` at EVERY effort level (the effort pick was coincidental).
// resolveOpenCodeGoApiFormat corrects the route per model — GLM down to chat
// completions (where dshModelReasoningDeclaration supplies the explicit zai
// thinking dialect), the responses-only set (luna / grok-4.6-4.7 /
// muse-spark, zai-org/feedback#840) up to the Responses wire.
//
// Requires: npm run compile:electron
import test from 'node:test'
import assert from 'node:assert/strict'
import Module from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = Module.createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const helperPath = path.resolve(here, '..', 'dist-electron', 'main', 'libs', 'opencodeGoProtocol.js')
const { resolveOpenCodeGoApiFormat } = require(helperPath)

const GATEWAY = 'https://opencode.ai/zen/go/v1'

test('glm rides chat completions even under the responses provider default', () => {
  for (const model of [
    'z-ai/glm-5.3-flash', // the incident id (gateway catalog shape)
    'glm-5.3-flash',      // bare id shape
    'GLM-5.3-Flash',      // display-case shape
    'zai-org/GLM-5.2',
    'glm-4.6-air',
  ]) {
    assert.equal(
      resolveOpenCodeGoApiFormat({ baseUrl: GATEWAY, model, apiFormat: 'responses' }),
      'openai',
      `${model} must not ride /v1/responses on the gateway`,
    )
  }
})

test('glm keeps a deliberately configured openai/anthropic format', () => {
  assert.equal(resolveOpenCodeGoApiFormat({ baseUrl: GATEWAY, model: 'z-ai/glm-5.3-flash', apiFormat: 'openai' }), 'openai')
  assert.equal(resolveOpenCodeGoApiFormat({ baseUrl: GATEWAY, model: 'z-ai/glm-5.3-flash', apiFormat: 'anthropic' }), 'anthropic')
})

test('deepseek keeps the responses default — the verified-working route', () => {
  // Regression guard for the fix itself: the correction exists BECAUSE the
  // responses default is right for deepseek; it must not be flattened to
  // chat completions.
  assert.equal(resolveOpenCodeGoApiFormat({ baseUrl: GATEWAY, model: 'deepseek-flash', apiFormat: 'responses' }), 'responses')
  assert.equal(resolveOpenCodeGoApiFormat({ baseUrl: GATEWAY, model: 'deepseek-v4.1-flash', apiFormat: 'responses' }), 'responses')
})

test('unknown models keep the configured format', () => {
  assert.equal(resolveOpenCodeGoApiFormat({ baseUrl: GATEWAY, model: 'moonshotai/kimi-k3', apiFormat: 'responses' }), 'responses')
  assert.equal(resolveOpenCodeGoApiFormat({ baseUrl: GATEWAY, model: 'qwen3.8-max', apiFormat: 'openai' }), 'openai')
  assert.equal(resolveOpenCodeGoApiFormat({ baseUrl: GATEWAY, model: '', apiFormat: 'responses' }), 'responses')
})

test('responses-only models ride the Responses wire from any other format', () => {
  for (const model of ['gpt-5.6-luna', 'openai/gpt-5.6-luna', 'grok-4.6', 'xai/grok-4.7', 'muse-spark-1.2-contributor']) {
    assert.equal(
      resolveOpenCodeGoApiFormat({ baseUrl: GATEWAY, model, apiFormat: 'openai' }),
      'responses',
      `${model} must ride /v1/responses on the gateway`,
    )
  }
})

test('non-gateway base URLs are never corrected', () => {
  // An 'opencode'-keyed provider pointed at a custom relay keeps the user's
  // format: the relay owns its protocol matrix, not the gateway.
  assert.equal(
    resolveOpenCodeGoApiFormat({ baseUrl: 'https://relay.example.internal/v1', model: 'z-ai/glm-5.3-flash', apiFormat: 'responses' }),
    'responses',
  )
  assert.equal(
    resolveOpenCodeGoApiFormat({ baseUrl: 'https://api.deepseek.com', model: 'gpt-5.6-luna', apiFormat: 'openai' }),
    'openai',
  )
  assert.equal(resolveOpenCodeGoApiFormat({ baseUrl: '', model: 'z-ai/glm-5.3-flash', apiFormat: 'responses' }), 'responses')
  assert.equal(resolveOpenCodeGoApiFormat({ baseUrl: null, model: 'z-ai/glm-5.3-flash', apiFormat: 'responses' }), 'responses')
})

test('proxy resolveUpstreamAPIType: gateway correction wins over the explicit responses format', () => {
  const proxyPath = path.resolve(here, '..', 'dist-electron', 'main', 'libs', 'coworkOpenAICompatProxy.js')
  const { resolveUpstreamAPIType } = require(proxyPath).__openAICompatProxyTestUtils
  // GLM on the gateway: configured 'responses' must fall back to chat_completions
  // (the 2026-10-13 incident path through the A2A/private-chat proxy).
  assert.equal(
    resolveUpstreamAPIType('opencode', 'z-ai/glm-5.3-flash', 'responses', GATEWAY),
    'chat_completions',
  )
  // deepseek on the gateway keeps responses; deepseek flash off-gateway keeps
  // the provider-level responses rule; openai keeps responses everywhere.
  assert.equal(resolveUpstreamAPIType('opencode', 'deepseek-flash', 'responses', GATEWAY), 'responses')
  assert.equal(resolveUpstreamAPIType('deepseek', 'deepseek-v4-flash', undefined, 'https://api.deepseek.com'), 'responses')
  assert.equal(resolveUpstreamAPIType('openai', 'gpt-x', 'openai', undefined), 'responses')
  // Non-gateway route with glm: unchanged legacy behavior.
  assert.equal(resolveUpstreamAPIType('zhipu', 'glm-5.3', 'responses', 'https://open.bigmodel.cn/api/v1'), 'responses')
})
