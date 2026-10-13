// DSH turn-route composition: OpenCode Go per-model protocol correction.
//
// dshTurnProviderFromRoute is the single composition point every DSH turn
// (warmup, first turn, guarded retries) rides, and the effort-rides-route
// declaration lookup keys off the CORRECTED apiFormat. This file pins the
// wiring end to end through the real CoworkRunner: an opencode provider row
// with the 'responses' default must send glm-5.3-flash to chat completions
// (the 2026-10-13 ModelProtocolUnsupported incident) while deepseek-flash
// keeps the verified-working Responses wire, and the configured effort must
// still ride the corrected route.
//
// Host-side only: the turn hub is not started; the private route methods are
// exercised directly (they are TS-private, not runtime-private).
//
// Requires: npm run compile:electron
import test from 'node:test'
import assert from 'node:assert/strict'
import Module from 'node:module'
import path from 'node:path'

const require = Module.createRequire(import.meta.url)

function loadModules() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `opencode-protocol-${name}`),
        },
        session: { defaultSession: { resolveProxy: async () => 'DIRECT' } },
      }
    }
    return originalLoad.apply(this, arguments)
  }
  try {
    return {
      runner: require('../dist-electron/main/libs/coworkRunner.js'),
      claudeSettings: require('../dist-electron/main/libs/claudeSettings.js'),
    }
  } finally {
    Module._load = originalLoad
  }
}

function installApiConfig(claudeSettings, overrides = {}) {
  const fakeConfigStore = {
    get: (key) => {
      if (key !== 'app_config') return undefined
      return {
        api: { key: 'sk-oc', baseUrl: 'https://opencode.ai/zen/go/v1' },
        model: {
          availableModels: [
            { id: 'z-ai/glm-5.3-flash', name: 'GLM-5.3 Flash' },
            { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' },
            { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
          ],
          defaultModel: 'z-ai/glm-5.3-flash',
          defaultProvider: 'opencode',
        },
        providers: {
          opencode: {
            enabled: true,
            apiKey: 'sk-oc',
            baseUrl: 'https://opencode.ai/zen/go/v1',
            apiFormat: 'responses',
            models: [
              { id: 'z-ai/glm-5.3-flash', name: 'GLM-5.3 Flash' },
              { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' },
              { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
            ],
          },
          ...overrides.providers,
        },
        dshKernelEnabled: true,
      }
    },
  }
  claudeSettings.setStoreGetter(() => fakeConfigStore)
}

function runnerForSession(claudeSettings, session) {
  const { runner: runnerModule } = loadModules()
  const { CoworkRunner } = runnerModule
  installApiConfig(claudeSettings)
  const store = { getSession: () => session }
  return new CoworkRunner(store, { getMetabotById: () => null })
}

test('opencode glm-5.3-flash rides chat completions with the effort still attached', () => {
  const { claudeSettings } = loadModules()
  const runner = runnerForSession(claudeSettings, { id: 's1', model: 'z-ai/glm-5.3-flash', modelProvider: 'opencode' })
  const route = runner.resolveSessionDshRoute('s1')
  assert.equal(route.provider, 'opencode')
  assert.equal(route.model, 'z-ai/glm-5.3-flash')

  const turnRoute = runner.dshTurnProviderFromRoute(route, { reasoningEffort: 'max' })
  // The incident: the provider-level 'responses' default must not reach the
  // gateway for GLM.
  assert.equal(turnRoute.apiFormat, 'openai')
  // Wire-corrected routes ride a suffixed key: the runtime unions models by
  // provider key with ONE apiFormat per entry, so GLM's chat-completions
  // entry must never share a bucket with deepseek's responses entry (the
  // 2026-10-14 runtime-boot failure).
  assert.equal(turnRoute.key, 'opencode.oc')
  // Effort rides the corrected route: the GLM chat-completions declaration
  // (zai thinking dialect) keys off the corrected apiFormat.
  assert.equal(turnRoute.reasoningEffort, 'max')
})

test('opencode deepseek keeps the responses default on the same provider', () => {
  const { claudeSettings } = loadModules()
  const runner = runnerForSession(claudeSettings, { id: 's2', model: 'deepseek-flash', modelProvider: 'opencode' })
  const route = runner.resolveSessionDshRoute('s2')
  const turnRoute = runner.dshTurnProviderFromRoute(route, { reasoningEffort: 'high' })
  // Verified-working route (the reporter's control case): the provider-level
  // 'responses' default must survive the correction untouched — including the
  // route key, so deepseek keeps riding the plain 'opencode' runtime slot.
  assert.equal(turnRoute.apiFormat, 'responses')
  assert.equal(turnRoute.key, 'opencode')
})

test('opencode responses-only model is corrected up to the Responses wire', () => {
  const { claudeSettings } = loadModules()
  // Provider CONFIGURED as openai (chat completions) with a responses-only
  // model: corrects up to responses and rides the suffixed '.rs' key.
  installApiConfig(claudeSettings, { providers: { opencode: {
    enabled: true,
    apiKey: 'sk-oc',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    apiFormat: 'openai',
    models: [
      { id: 'z-ai/glm-5.3-flash', name: 'GLM-5.3 Flash' },
      { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
    ],
  } } })
  const { runner: runnerModule } = loadModules()
  const { CoworkRunner } = runnerModule
  const runner = new CoworkRunner({ getSession: () => ({ id: 's3', model: 'gpt-5.6-luna', modelProvider: 'opencode' }) }, { getMetabotById: () => null })
  const route = runner.resolveSessionDshRoute('s3')
  const turnRoute = runner.dshTurnProviderFromRoute(route, {})
  assert.equal(turnRoute.apiFormat, 'responses')
  assert.equal(turnRoute.key, 'opencode.rs')
})
