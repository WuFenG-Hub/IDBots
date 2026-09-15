// Startup DSH warmup must not be voided by the PINNED session's stale model.
//
// Regression (2026-09 field incident): runDshRuntimeWarmup() resolves the
// route of listSessions()[0] — which, per coworkStore's
// `ORDER BY s.pinned DESC, activity_at DESC, ...`, is always a PINNED session.
// resolveSessionDshRoute() re-resolves that session's stored
// model + model_provider through resolveDshProviderRoute(..., {
// requireProviderDisambiguation: true }). When the stored model id has since
// been removed from that provider's enabled catalog, resolveMatchedProvider
// returns the "Provider '<p> does not offer enabled model '<m>'; provider
// selection is required." error and resolveDshProviderRoute rethrows it as a
// ModelProviderSelectionError. The throw escaped the warmup's prewarm call
// setup, so the "route" fallback to resolveDshProviderRoute() further down
// never ran and the whole warmup degraded to WARN "Warmup failed; first turn
// will cold-start" — even though the app-global default route was perfectly
// healthy. Fix: isolate the pinned-session resolution so a stale session route
// degrades to the default route (session route precedence still wins whenever
// it resolves).
//
// Host-side coverage only: the DSH turn hub is faked (no dsh-runtime spawn),
// so this file does NOT need dsh-runtime/node_modules.
//
// Requires: npm run compile:electron

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = Module.createRequire(import.meta.url)

const userDataDir = () => path.join(process.cwd(), '.cowork-temp', 'dsh-prewarm-stale-userData')
const coworkLogPath = () => path.join(userDataDir(), 'logs', 'cowork.log')

function loadModules() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-prewarm-stale-${name}`),
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

// Mirrors coworkStore.listSessions(): the returned array is already ordered
// `pinned DESC, activity_at DESC, ...`, so [0] is the warmed session.
class RecordingStore {
  constructor(sessions) {
    this.sessions = sessions
  }
  listSessions() {
    return this.sessions
  }
  getSession(id) {
    return this.sessions.find((session) => session.id === id) ?? null
  }
  getSessionWithoutMessages(id) {
    return this.getSession(id)
  }
  getConfig() {
    return { workingDirectory: process.cwd() }
  }
}

// Two enabled providers: the app-global default (gw-default / default-model-1)
// and one whose catalog NO LONGER offers stale-model-1 (gw-stale) — the
// session rows below carry that removed id as their stored model.
function installApiConfig(claudeSettings) {
  const fakeConfigStore = {
    get: (key) => {
      if (key !== 'app_config') return undefined
      return {
        api: { key: 'sk-default', baseUrl: 'http://default.example/v1' },
        model: {
          availableModels: [{ id: 'default-model-1', name: 'default-model-1' }],
          defaultModel: 'default-model-1',
          defaultProvider: 'gw-default',
        },
        providers: {
          'gw-default': {
            enabled: true,
            apiKey: 'sk-default',
            baseUrl: 'http://default.example/v1',
            apiFormat: 'openai',
            models: [{ id: 'default-model-1', name: 'default-model-1' }],
          },
          'gw-stale': {
            enabled: true,
            apiKey: 'sk-stale',
            baseUrl: 'http://stale.example/v1',
            apiFormat: 'openai',
            // stale-model-1 was removed by the provider; only 'kept-model-9' remains.
            models: [{ id: 'kept-model-9', name: 'kept-model-9' }],
          },
          'gw-sess': {
            enabled: true,
            apiKey: 'sk-sess',
            baseUrl: 'http://sess.example/v1',
            apiFormat: 'openai',
            models: [{ id: 'sess-model-1', name: 'sess-model-1' }],
          },
        },
        dshKernelEnabled: true,
      }
    },
  }
  claudeSettings.setStoreGetter(() => fakeConfigStore)
}

function makeRunner({ runnerModule, sessions }) {
  const { CoworkRunner } = runnerModule
  const store = new RecordingStore(sessions)
  const runner = new CoworkRunner(store)
  const prewarmCalls = []
  runner.dshTurnHub = {
    prewarm: async (input) => { prewarmCalls.push(input) },
    runTurn: async () => ({ kind: 'error', error: { code: 'UNUSED', message: 'not used' } }),
    cancel: async () => undefined,
    compact: async () => ({ ok: true, compacted: false }),
  }
  return { runner, prewarmCalls }
}

const readLogDelta = (before) => {
  if (!fs.existsSync(coworkLogPath())) return ''
  const after = fs.readFileSync(coworkLogPath(), 'utf-8')
  return after.slice(before)
}
const logLength = () => (fs.existsSync(coworkLogPath()) ? fs.readFileSync(coworkLogPath(), 'utf-8').length : 0)

// ---- regression -----------------------------------------------------------

test('prewarm falls back to the default route when the pinned session model was removed by its provider', async () => {
  const { runner: runnerModule, claudeSettings } = loadModules()
  installApiConfig(claudeSettings)

  const pinnedId = 'prewarm-stale-pinned-session'
  const { runner, prewarmCalls } = makeRunner({
    runnerModule,
    sessions: [
      { id: pinnedId, model: 'stale-model-1', modelProvider: 'gw-stale', cwd: process.cwd() },
    ],
  })

  const before = logLength()
  await runner.prewarmDshRuntime()

  // RED before the fix: resolveSessionDshRoute() threw and the prewarm call
  // never happened. GREEN after: the warmup runs on the healthy default route.
  assert.equal(prewarmCalls.length, 1, 'the warmup must still spawn the runtime')
  assert.equal(
    prewarmCalls[0]?.provider?.key,
    'gw-default',
    'a stale pinned-session route must degrade to the default route, not void the warmup',
  )
  assert.equal(prewarmCalls[0]?.provider?.model, 'default-model-1')

  const delta = readLogDelta(before)
  assert.ok(
    delta.includes('Pinned session route did not resolve'),
    'the degradation must be observable in cowork.log',
  )
  assert.ok(delta.includes(pinnedId), 'the degradation log line must name the pinned session')
  assert.ok(
    !delta.includes('Warmup failed; first turn will cold-start'),
    'the warmup itself must not fail',
  )
})

// ---- positive control: session route precedence must survive the fix -------

test('prewarm still prefers the pinned session route when that route resolves', async () => {
  const { runner: runnerModule, claudeSettings } = loadModules()
  installApiConfig(claudeSettings)

  const { runner, prewarmCalls } = makeRunner({
    runnerModule,
    sessions: [
      { id: 'prewarm-live-pinned-session', model: 'sess-model-1', modelProvider: 'gw-sess', cwd: process.cwd() },
    ],
  })

  await runner.prewarmDshRuntime()

  assert.equal(prewarmCalls.length, 1)
  assert.equal(
    prewarmCalls[0]?.provider?.key,
    'gw-sess',
    'the session route still wins over the app-global default route',
  )
  assert.equal(prewarmCalls[0]?.provider?.model, 'sess-model-1')
})

// ---- no pinned session at all: default route (unchanged behaviour) ---------

test('prewarm uses the default route when there is no session to warm', async () => {
  const { runner: runnerModule, claudeSettings } = loadModules()
  installApiConfig(claudeSettings)

  const { runner, prewarmCalls } = makeRunner({ runnerModule, sessions: [] })

  await runner.prewarmDshRuntime()

  assert.equal(prewarmCalls.length, 1)
  assert.equal(prewarmCalls[0]?.provider?.key, 'gw-default')
  assert.equal(prewarmCalls[0]?.provider?.model, 'default-model-1')
})
