// Turn-agent pre-create + intent prewarm (first-sentence latency work,
// 2026-10-16).
//
// prewarmTurnAgent: kicked fire-and-forget at turn entry, it boots the slot
// AND materializes the session's runtime agent (sections/hostTools registered,
// per-session Playwright MCP spawned for automation bots) so the volatile-
// context build overlaps that work instead of stacking behind it inside
// runTurn. It mirrors runTurnExclusive's slot pinning so a later route change
// disposes the pre-created agent before the re-pin (the session write-lock
// moves with it).
//
// prewarmSessionTurnSlot (runner level): fired on USER INTENT (composer bot/
// model pick, session opened) seconds before the first send — resolves the
// exact route + automation + MCP combo without a session record.
//
// Requires: npm run compile:electron; the integration half also needs
// dsh-runtime/node_modules installed.

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = Module.createRequire(import.meta.url)
const here = import.meta.dirname
const runtimeDir = path.resolve(here, '..', 'dsh-runtime')
const runtimeReady = fs.existsSync(path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-sdk-client'))

const CHROME_CANDIDATES = process.platform === 'darwin'
  ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
  : process.platform === 'win32'
    ? [process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe', process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
const chromePath = CHROME_CANDIDATES.find((p) => p && fs.existsSync(p))

function loadModules() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-preagent-${name}`),
        },
        session: { defaultSession: { resolveProxy: async () => 'DIRECT' } },
      }
    }
    return originalLoad.apply(this, arguments)
  }
  try {
    return {
      coworkDshTurn: require('../dist-electron/main/libs/coworkDshTurn.js'),
      coworkRunner: require('../dist-electron/main/libs/coworkRunner.js'),
      claudeSettings: require('../dist-electron/main/libs/claudeSettings.js'),
    }
  } finally {
    Module._load = originalLoad
  }
}

const loaded = loadModules()

const callbacks = () => ({
  onMessage: () => `m-${Math.random().toString(36).slice(2)}`,
  onMessageUpdate: () => undefined,
  onMessageFinalize: () => undefined,
  onUsage: () => undefined,
  onApprovalRequest: () => undefined,
  onApprovalCancelled: () => undefined,
})

// ---------------------------------------------------------------------------
// Hub integration: agent pre-create.
// ---------------------------------------------------------------------------

test('prewarmTurnAgent pre-creates the session agent; the follow-up turn reuses it', {
  skip: runtimeReady ? false : 'dsh-runtime node_modules not installed',
}, async () => {
  const { DshTurnHub } = loaded.coworkDshTurn
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server } = await startMockServer(48831)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-dsh-preagent-'))
  const workspace = { cwd: sessionRoot }
  const logs = []
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot,
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
  })
  const provider = {
    key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48831/v1',
    apiKey: 'sk-a', model: 'mock-1',
  }
  const sections = [
    { name: 'idbots:base', order: 0, text: 'You are Alice.' },
    { name: 'idbots:tool-use', order: 150, text: 'Use your tools when they help.' },
  ]

  try {
    await hub.prewarmTurnAgent({
      sessionId: 'cowork-preagent',
      dshSessionId: 'preagent-1',
      provider,
      sections,
      workspace,
    })
    assert.equal(hub.running, true, 'the pre-create leaves the runtime running')
    const agentLog = logs.find((l) => l.message.includes('prewarmTurnAgent'))
    assert.ok(agentLog, 'the agent pre-create must be observable in cowork.log')
    assert.equal(agentLog.detail.runtime, 'mockgw')
    assert.equal(agentLog.detail.resumed, false, 'a fresh session is created, not resumed')
    const bootsAfterPrewarm = logs.filter((l) => l.message.includes('dshKernel.ensureRuntime')).length
    assert.equal(bootsAfterPrewarm, 1, 'the pre-create booted the runtime once')

    const outcome = await hub.runTurn({
      sessionId: 'cowork-preagent',
      dshSessionId: 'preagent-1',
      prompt: 'hello after agent pre-create',
      provider,
      workspace,
      sections,
      callbacks: callbacks(),
    })
    assert.notEqual(outcome.kind, 'error', `the turn after the pre-create must succeed: ${JSON.stringify(outcome).slice(0, 200)}`)
    assert.equal(hub.restartCount, 0, 'the turn must not restart the prewarmed process')
    const bootsAfterTurn = logs.filter((l) => l.message.includes('dshKernel.ensureRuntime')).length
    assert.equal(bootsAfterTurn, 1, 'the turn reused the pre-created agent and process')
  } finally {
    await hub.close().catch(() => undefined)
    server.close()
    fs.rmSync(sessionRoot, { recursive: true, force: true })
  }
})

test('prewarmTurnAgent pins the session so a provider change disposes before the re-pin', {
  skip: runtimeReady ? false : 'dsh-runtime node_modules not installed',
}, async () => {
  const { DshTurnHub } = loaded.coworkDshTurn
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server: serverA } = await startMockServer(48832)
  const { server: serverB } = await startMockServer(48833)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-dsh-repin-'))
  const workspace = { cwd: sessionRoot }
  const logs = []
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot,
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
  })
  const providerA = {
    key: 'mockgwa', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48832/v1',
    apiKey: 'sk-a', model: 'mock-1',
  }
  const providerB = {
    key: 'mockgwb', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48833/v1',
    apiKey: 'sk-b', model: 'mock-1',
  }
  const sections = [{ name: 'idbots:base', order: 0, text: 'You are Alice.' }]

  try {
    await hub.prewarmTurnAgent({
      sessionId: 'cowork-repin',
      dshSessionId: 'repin-1',
      provider: providerA,
      sections,
      workspace,
    })
    // The turn lands on provider B: runTurnExclusive must dispose the
    // pre-created agent on A (releasing the session write-lock) before the
    // resume on B, or the re-pin dies on SessionAlreadyOwnedError.
    const outcome = await hub.runTurn({
      sessionId: 'cowork-repin',
      dshSessionId: 'repin-1',
      prompt: 'hello on another provider',
      provider: providerB,
      workspace,
      sections,
      callbacks: callbacks(),
    })
    assert.notEqual(outcome.kind, 'error', `the re-pinned turn must succeed: ${JSON.stringify(outcome).slice(0, 200)}`)
    assert.ok(
      logs.some((l) => l.message.includes('dshTurnHub.disposeSession')),
      'the cross-slot handoff must dispose the pre-created agent on the previous slot',
    )
  } finally {
    await hub.close().catch(() => undefined)
    serverA.close()
    serverB.close()
    fs.rmSync(sessionRoot, { recursive: true, force: true })
  }
})

test('prewarmTurnSlot honors an explicit automation + MCP union (no session record)', {
  skip: !runtimeReady
    ? 'dsh-runtime node_modules not installed'
    : !chromePath
      ? 'no Chrome/Chromium found for the automation composition'
      : false,
}, async () => {
  const { DshTurnHub } = loaded.coworkDshTurn
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server } = await startMockServer(48834)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-dsh-intentslot-'))
  const workspace = { cwd: sessionRoot }
  const logs = []
  const automationCalls = []
  const mcpCalls = []
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot,
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
    // The session-keyed providers must NEVER be consulted for a synthetic
    // intent id — the explicit overrides carry the combo instead.
    browserAutomationProvider: (coworkSessionId) => {
      automationCalls.push(coworkSessionId)
      return undefined
    },
    mcpServersProvider: (coworkSessionId) => {
      mcpCalls.push(coworkSessionId)
      return []
    },
  })
  const provider = {
    key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48834/v1',
    apiKey: 'sk-a', model: 'mock-1',
  }

  try {
    await hub.prewarmTurnSlot({
      sessionId: 'intent-bot-99',
      provider,
      workspace,
      automation: { browserUse: { mode: 'launch', headless: true }, computerUse: false },
      mcpServers: [{
        name: 'intent-echo',
        transportType: 'stdio',
        command: process.execPath,
        args: [path.join(runtimeDir, 'test', 'fixtures', 'mcp-echo-server.mjs')],
      }],
    })
    const bootLog = logs.find((l) => l.message.includes('prewarmTurnSlot.boot'))
    assert.ok(bootLog, 'the intent prewarm logged the booted slot')
    assert.equal(bootLog.detail.runtime, 'mockgw.auto-b', 'the explicit browser opt-in keys the .auto-b slot')
    assert.equal(bootLog.detail.browser, true)
    assert.equal(automationCalls.length, 0, 'the session-keyed automation provider is never consulted')
    assert.equal(mcpCalls.length, 0, 'the session-keyed MCP provider is never consulted')
  } finally {
    await hub.close().catch(() => undefined)
    server.close()
    fs.rmSync(sessionRoot, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Runner level: intent prewarm route resolution (hub faked — no runtime spawn).
// ---------------------------------------------------------------------------

const coworkLogPath = () => path.join(process.cwd(), '.cowork-temp', 'dsh-preagent-userData', 'logs', 'cowork.log')

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
          'gw-bot': {
            enabled: true,
            apiKey: 'sk-bot',
            baseUrl: 'http://bot.example/v1',
            apiFormat: 'openai',
            models: [{ id: 'bot-model-1', name: 'bot-model-1' }],
          },
          'gw-pick': {
            enabled: true,
            apiKey: 'sk-pick',
            baseUrl: 'http://pick.example/v1',
            apiFormat: 'openai',
            models: [{ id: 'pick-model-1', name: 'pick-model-1' }],
          },
        },
        dshKernelEnabled: true,
      }
    },
  }
  claudeSettings.setStoreGetter(() => fakeConfigStore)
}

function makeIntentRunner({ runnerModule, sessions, metabot }) {
  const { CoworkRunner } = runnerModule
  const store = new RecordingStore(sessions)
  const runner = new CoworkRunner(store, {
    getMetabotById: (id) => (metabot && id === metabot.id ? metabot : null),
    browserAutomationForMetabot: (id) => (metabot && id === metabot.id ? { mode: 'launch', headless: true } : undefined),
    computerUseForMetabot: () => false,
    mcpServersForMetabot: (id) => (metabot && id === metabot.id
      ? [{ name: 'intent-echo', transportType: 'stdio', command: 'echo', args: [] }]
      : []),
  })
  const prewarmCalls = []
  runner.dshTurnHub = {
    prewarmTurnSlot: async (input) => { prewarmCalls.push(input) },
  }
  return { runner, prewarmCalls }
}

const intentBot = {
  id: 7,
  name: 'Intent Bot',
  llm_id: 'bot-model-1',
  llm_provider: 'gw-bot',
  llm_effort: null,
  fallback_llm_id: null,
  fallback_llm_provider: null,
  fallback_llm_effort: null,
}

test('bot intent prewarm resolves the bot brain route with explicit combo overrides', async () => {
  const { coworkRunner: runnerModule, claudeSettings } = loaded
  installApiConfig(claudeSettings)
  const { runner, prewarmCalls } = makeIntentRunner({ runnerModule, sessions: [], metabot: intentBot })

  await runner.prewarmSessionTurnSlot({ metabotId: 7, model: null, modelProvider: null, cwd: '/tmp/intent-cwd' })

  assert.equal(prewarmCalls.length, 1, 'the intent boots exactly one slot prewarm')
  const call = prewarmCalls[0]
  assert.equal(call.sessionId, 'intent-bot-7', 'the synthetic prewarm id names the bot')
  assert.equal(call.provider.key, 'gw-bot', 'the bot brain route wins with no composer pick')
  assert.equal(call.provider.model, 'bot-model-1')
  assert.equal(call.workspace?.cwd, '/tmp/intent-cwd')
  assert.deepEqual(call.automation, {
    browserUse: { mode: 'launch', headless: true },
    computerUse: false,
  }, 'the combo resolves from the bot opt-ins (no session record exists)')
  assert.equal(call.mcpServers?.length, 1, 'the explicit MCP union rides along')
  assert.equal(call.mcpServers?.[0]?.name, 'intent-echo')
})

test('bot intent prewarm lets the composer model pick win over the bot brain', async () => {
  const { coworkRunner: runnerModule, claudeSettings } = loaded
  installApiConfig(claudeSettings)
  const { runner, prewarmCalls } = makeIntentRunner({ runnerModule, sessions: [], metabot: intentBot })

  await runner.prewarmSessionTurnSlot({ metabotId: 7, model: 'pick-model-1', modelProvider: 'gw-pick', cwd: '' })

  assert.equal(prewarmCalls.length, 1)
  assert.equal(prewarmCalls[0]?.provider?.key, 'gw-pick', 'the composer pick outranks the bot brain')
  assert.equal(prewarmCalls[0]?.provider?.model, 'pick-model-1')
})

test('bot intent prewarm without a bot brain resolves the default route', async () => {
  const { coworkRunner: runnerModule, claudeSettings } = loaded
  installApiConfig(claudeSettings)
  const brainlessBot = { ...intentBot, llm_id: null, llm_provider: null, fallback_llm_id: null }
  const { runner, prewarmCalls } = makeIntentRunner({ runnerModule, sessions: [], metabot: brainlessBot })

  await runner.prewarmSessionTurnSlot({ metabotId: 7, model: null, modelProvider: null, cwd: '' })

  assert.equal(prewarmCalls.length, 1)
  assert.equal(prewarmCalls[0]?.provider?.key, 'gw-default', 'a bot without a brain rides the global default route')
  assert.equal(prewarmCalls[0]?.provider?.model, 'default-model-1')
})

test('session intent prewarm resolves from the session record without combo overrides', async () => {
  const { coworkRunner: runnerModule, claudeSettings } = loaded
  installApiConfig(claudeSettings)
  const sessions = [
    { id: 'intent-sess-1', model: 'pick-model-1', modelProvider: 'gw-pick', cwd: '/tmp/record-cwd' },
  ]
  const { runner, prewarmCalls } = makeIntentRunner({ runnerModule, sessions, metabot: null })

  await runner.prewarmSessionTurnSlot({ sessionId: 'intent-sess-1' })

  assert.equal(prewarmCalls.length, 1)
  const call = prewarmCalls[0]
  assert.equal(call.sessionId, 'intent-sess-1')
  assert.equal(call.provider.key, 'gw-pick', 'the stored session pick resolves')
  assert.equal(call.workspace?.cwd, '/tmp/record-cwd', 'the workspace pin comes from the session record')
  assert.ok(!('automation' in call), 'session intents leave automation to the hub session-keyed providers')
  assert.ok(!('mcpServers' in call), 'session intents leave the MCP union to the hub session-keyed providers')
})

test('identical intents inside the dedupe window coalesce; a pick change re-fires', async () => {
  const { coworkRunner: runnerModule, claudeSettings } = loaded
  installApiConfig(claudeSettings)
  const { runner, prewarmCalls } = makeIntentRunner({ runnerModule, sessions: [], metabot: intentBot })

  await runner.prewarmSessionTurnSlot({ metabotId: 7, model: null, modelProvider: null, cwd: '' })
  await runner.prewarmSessionTurnSlot({ metabotId: 7, model: null, modelProvider: null, cwd: '' })
  assert.equal(prewarmCalls.length, 1, 'the repeat intent is a no-op inside the dedupe window')

  await runner.prewarmSessionTurnSlot({ metabotId: 7, model: 'pick-model-1', modelProvider: 'gw-pick', cwd: '' })
  assert.equal(prewarmCalls.length, 2, 'a changed pick is a new intent and boots its route')
})

test('intent prewarm never throws and never spawns a hub without a resolvable route', async () => {
  const { coworkRunner: runnerModule, claudeSettings } = loaded
  // No providers at all: nothing can resolve.
  claudeSettings.setStoreGetter(() => ({ get: () => ({}) }))
  const store = new RecordingStore([])
  const runner = new runnerModule.CoworkRunner(store)
  await runner.prewarmSessionTurnSlot({ metabotId: 42, model: null, modelProvider: null, cwd: '' })
  assert.equal(runner.dshTurnHub, null, 'an unresolvable intent must not spawn the hub')
  await runner.prewarmSessionTurnSlot({ sessionId: 'missing-session' })
  assert.equal(runner.dshTurnHub, null)
})
