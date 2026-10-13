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

test('glm keeps a deliberately configured openai format; anthropic corrects to openai too', () => {
  // The gateway's anthropic /v1/messages wire serves only minimax-m3 and
  // qwen3.8-flash (pi-ai catalog) — glm on it is ModelProtocolUnsupported,
  // same as the responses wire.
  assert.equal(resolveOpenCodeGoApiFormat({ baseUrl: GATEWAY, model: 'z-ai/glm-5.3-flash', apiFormat: 'openai' }), 'openai')
  assert.equal(resolveOpenCodeGoApiFormat({ baseUrl: GATEWAY, model: 'z-ai/glm-5.3-flash', apiFormat: 'anthropic' }), 'openai')
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

// Thinking-dialect fork: the same GLM family speaks the z.ai `thinking` object
// on zhipu/z.ai OpenAI-compatible endpoints but the standard `reasoning_effort`
// field on the OpenCode Go gateway (2026-10-13 continuation: after the protocol
// correction, the zai declaration produced `400 ... unknown field "thinking"`).
test('dshModelReasoningDeclaration: GLM chat-completions dialect forks by gateway', () => {
  const reasoningPath = path.resolve(here, '..', 'dist-electron', 'main', 'libs', 'dshModelReasoning.js')
  const { dshModelReasoningDeclaration } = require(reasoningPath)

  // OpenCode gateway: plain reasoning_effort ladder, no thinkingFormat — the
  // `thinking` object is an unknown parameter there.
  const gateway = dshModelReasoningDeclaration('z-ai/glm-5.3-flash', 'openai', GATEWAY)
  assert.ok(gateway, 'gateway declaration present')
  assert.equal(gateway.compat.thinkingFormat, undefined)
  assert.equal(gateway.compat.supportsReasoningEffort, true)
  assert.deepEqual(gateway.reasoningEfforts, { off: null, low: 'low', high: 'high', max: 'max' })

  // zhipu/z.ai endpoints keep the zai thinking dialect (explicit enable/disable).
  const zai = dshModelReasoningDeclaration('glm-5.3-flash', 'openai', 'https://open.bigmodel.cn/api/coding/paas/v4')
  assert.equal(zai.compat.thinkingFormat, 'zai')
  assert.equal(zai.compat.supportsReasoningEffort, false)
  assert.deepEqual(zai.reasoningEfforts, { off: null, low: 'enabled', high: 'enabled', max: 'enabled' })

  // Unknown/absent baseUrl keeps the family default (the zai dialect) — a
  // custom relay serving GLM speaks the family's own wire, not the gateway's.
  assert.equal(
    dshModelReasoningDeclaration('glm-5.3-flash', 'openai', undefined)?.compat.thinkingFormat,
    'zai',
  )
  assert.equal(
    dshModelReasoningDeclaration('glm-5.3-flash', 'openai', null)?.compat.thinkingFormat,
    'zai',
  )

  // Other wires and families are untouched by the fork.
  assert.equal(dshModelReasoningDeclaration('glm-5.3-flash', 'responses', GATEWAY)?.compat.supportsDeveloperRole, false)
  assert.equal(dshModelReasoningDeclaration('glm-5.3-flash', 'anthropic', GATEWAY)?.compat.forceAdaptiveThinking, true)
  assert.equal(dshModelReasoningDeclaration('deepseek-v4.1-flash', 'openai', GATEWAY)?.compat.thinkingFormat, 'deepseek')
})

// End-to-end through the runtime config generator: the gateway GLM declaration
// must materialize as a plain reasoning_effort model — no thinkingFormat: 'zai'
// can reach the wire or the gateway 400s `unknown field "thinking"` again.
// Skips when dsh-runtime/node_modules is absent (same guard as
// dshRuntimeOpencodeSessionHeaders).
test('generated runtime config: gateway GLM materializes without the zai thinking dialect', async (t) => {
  const { existsSync } = await import('node:fs')
  const worktreeRoot = path.resolve(here, '..')
  if (!existsSync(path.join(worktreeRoot, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai'))) {
    t.skip('dsh-runtime dependencies not installed')
    return
  }
  const { pathToFileURL } = await import('node:url')
  const { generateRuntimeConfig } = await import(pathToFileURL(
    path.join(worktreeRoot, 'dsh-runtime', 'lib', 'generate-runtime-config.mjs')).href)
  const reasoningPath = path.resolve(here, '..', 'dist-electron', 'main', 'libs', 'dshModelReasoning.js')
  const { dshModelReasoningDeclaration } = require(reasoningPath)

  const declaration = dshModelReasoningDeclaration('z-ai/glm-5.3-flash', 'openai', GATEWAY)
  const routeModel = {
    id: 'z-ai/glm-5.3-flash',
    contextWindow: 1_048_576,
    ...(declaration ? { reasoningEfforts: declaration.reasoningEfforts, compat: declaration.compat } : {}),
  }
  const config = generateRuntimeConfig({
    sessionRoot: '/tmp/dsh-opencode-glm-dialect-test',
    providers: [{
      key: 'opencode',
      apiFormat: 'openai',
      baseUrl: GATEWAY,
      apiKeyEnv: 'IDBOTS_DSH_KEY_OPENCODE',
      models: [routeModel],
    }],
  })
  const provider = config.find((e) => e.id === 'llm-pi-ai').config.providers.opencode
  const model = provider.models.find((m) => m.id === 'z-ai/glm-5.3-flash')
  assert.ok(model, 'route model present in the pi-ai providers dict')
  // The generated config forwards the declaration verbatim; dsh-llm-pi-ai
  // materializes it into thinkingLevelMap at plugin load (resolveModelReasoning:
  // off:null stays absent from the map = "supported, send nothing").
  assert.equal(model.compat?.thinkingFormat, undefined, 'no zai thinkingFormat on the gateway wire')
  assert.equal(model.compat?.supportsReasoningEffort, true)
  assert.equal(model.reasoningEfforts?.low, 'low')
  assert.equal(model.reasoningEfforts?.high, 'high')
  assert.equal(model.reasoningEfforts?.max, 'max')
  assert.equal(model.reasoningEfforts?.off, null, 'off stays the send-nothing shape')
})
