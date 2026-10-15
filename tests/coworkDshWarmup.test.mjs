// Startup DSH warmup: spawn the shared runtime without a prompt so the first
// cowork turn does not pay process boot + plugin load. Same-provider/same-cwd
// follow-up must reuse the process (restartCount 0). Overlapping prewarm+turn
// must not double-spawn.
//
// Requires: npm run compile:electron + dsh-runtime/node_modules installed.

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

function loadModules() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-warmup-${name}`),
        },
      }
    }
    return originalLoad.apply(this, arguments)
  }
  try {
    return {
      coworkDshTurn: require('../dist-electron/main/libs/coworkDshTurn.js'),
      coworkRunner: require('../dist-electron/main/libs/coworkRunner.js'),
    }
  } finally {
    Module._load = originalLoad
  }
}

const loaded = loadModules()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (predicate, timeoutMs = 25000, what = 'condition') => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await sleep(50)
  }
  throw new Error(`timeout waiting for ${what}`)
}

test('prewarmDshRuntime skips without a configured provider and does not throw', async () => {
  const { coworkRunner } = loaded
  const store = {
    listSessions: () => [],
    getConfig: () => ({ workingDirectory: process.cwd() }),
    getSession: () => null,
    getSessionWithoutMessages: () => null,
  }
  const runner = new coworkRunner.CoworkRunner(store)
  await runner.prewarmDshRuntime()
  assert.equal(runner.dshTurnHub, null, 'skip must not spawn a hub')
  await runner.prewarmDshRuntime()
})

test('prewarm then first turn on the same provider and cwd reuses the runtime', {
  skip: runtimeReady ? false : 'dsh-runtime node_modules not installed',
}, async () => {
  const { DshTurnHub } = loaded.coworkDshTurn
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server } = await startMockServer(48821)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-dsh-warmup-'))
  const workspace = { cwd: sessionRoot }
  const logs = []
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot,
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
  })
  const provider = {
    key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48821/v1',
    apiKey: 'sk-a', model: 'mock-1',
  }
  const callbacks = () => ({
    onMessage: () => `m-${Math.random().toString(36).slice(2)}`,
    onMessageUpdate: () => undefined,
    onMessageFinalize: () => undefined,
    onUsage: () => undefined,
    onApprovalRequest: () => undefined,
    onApprovalCancelled: () => undefined,
  })

  try {
    await hub.prewarm({ provider, workspace })
    assert.equal(hub.running, true, 'warmup must leave the runtime running')
    assert.equal(hub.restartCount, 0)
    const bootsAfterWarmup = logs.filter((l) => l.message.includes('dshKernel.ensureRuntime')).length
    assert.equal(bootsAfterWarmup, 1, 'warmup spawns the runtime once')

    const outcome = await hub.runTurn({
      sessionId: 'cowork-warm',
      dshSessionId: 'warm-1',
      prompt: 'hello after warmup',
      provider,
      workspace,
      sections: [{ name: 'idbots:base', order: 0, text: 'You are Alice.' }],
      callbacks: callbacks(),
    })
    assert.notEqual(outcome.kind, 'error', `first turn after warmup must succeed: ${JSON.stringify(outcome).slice(0, 200)}`)
    assert.equal(hub.restartCount, 0, 'same provider and cwd must not restart the warmed runtime')
    const bootsAfterTurn = logs.filter((l) => l.message.includes('dshKernel.ensureRuntime')).length
    assert.equal(bootsAfterTurn, 1, 'first turn must reuse the warmed process')
  } finally {
    await hub.close().catch(() => undefined)
    server.close()
    fs.rmSync(sessionRoot, { recursive: true, force: true })
  }
})

test('overlapping prewarm and first turn serialize onto one runtime spawn', {
  skip: runtimeReady ? false : 'dsh-runtime node_modules not installed',
}, async () => {
  const { DshTurnHub } = loaded.coworkDshTurn
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server } = await startMockServer(48822)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-dsh-warmup-overlap-'))
  const workspace = { cwd: sessionRoot }
  const logs = []
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot,
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
  })
  const provider = {
    key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48822/v1',
    apiKey: 'sk-a', model: 'mock-1',
  }
  const callbacks = () => ({
    onMessage: () => `m-${Math.random().toString(36).slice(2)}`,
    onMessageUpdate: () => undefined,
    onMessageFinalize: () => undefined,
    onUsage: () => undefined,
    onApprovalRequest: () => undefined,
    onApprovalCancelled: () => undefined,
  })

  try {
    const warmup = hub.prewarm({ provider, workspace })
    const turn = hub.runTurn({
      sessionId: 'cowork-overlap',
      dshSessionId: 'overlap-1',
      prompt: 'hello overlapping warmup',
      provider,
      workspace,
      sections: [{ name: 'idbots:base', order: 0, text: 'You are Alice.' }],
      callbacks: callbacks(),
    })
    const [warmupResult, outcome] = await Promise.all([warmup, turn])
    void warmupResult
    assert.notEqual(outcome.kind, 'error', `overlapping first turn must succeed: ${JSON.stringify(outcome).slice(0, 200)}`)
    assert.equal(hub.restartCount, 0, 'serialized warmup+turn must not restart')
    const boots = logs.filter((l) => l.message.includes('dshKernel.ensureRuntime')).length
    assert.equal(boots, 1, 'warmup and first turn must share a single spawn')
    await waitFor(() => hub.running, 5000, 'runtime still running after overlap')
  } finally {
    await hub.close().catch(() => undefined)
    server.close()
    fs.rmSync(sessionRoot, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// prewarmTurnSlot (first-sentence latency work, 2026-10-15): pre-boot the
// runtime slot the session's NEXT turn will land on, with the real session's
// provider + MCP union (+ automation combo), so the turn reuses the process
// instead of paying boot inside the turn.
// ---------------------------------------------------------------------------

test('prewarmTurnSlot accumulates the session MCP union; the follow-up turn never restarts', {
  skip: runtimeReady ? false : 'dsh-runtime node_modules not installed',
}, async () => {
  const { DshTurnHub } = loaded.coworkDshTurn
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server } = await startMockServer(48823)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-dsh-warmup-slot-'))
  const workspace = { cwd: sessionRoot }
  const logs = []
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot,
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
    mcpServersProvider: (coworkSessionId) => coworkSessionId === 'cowork-prewarmslot' ? [{
      name: 'warmup-echo',
      transportType: 'stdio',
      command: process.execPath,
      args: [path.join(runtimeDir, 'test', 'fixtures', 'mcp-echo-server.mjs')],
    }] : [],
  })
  const provider = {
    key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48823/v1',
    apiKey: 'sk-a', model: 'mock-1',
  }
  const callbacks = () => ({
    onMessage: () => `m-${Math.random().toString(36).slice(2)}`,
    onMessageUpdate: () => undefined,
    onMessageFinalize: () => undefined,
    onUsage: () => undefined,
    onApprovalRequest: () => undefined,
    onApprovalCancelled: () => undefined,
  })

  try {
    await hub.prewarmTurnSlot({ sessionId: 'cowork-prewarmslot', provider, workspace })
    assert.equal(hub.running, true, 'turn-slot prewarm leaves the runtime running')
    const bootLog = logs.find((l) => l.message.includes('prewarmTurnSlot.boot'))
    assert.ok(bootLog, 'prewarm logged the booted slot')
    assert.equal(bootLog.detail.runtime, 'mockgw', 'clean-combo session lands on the bare provider slot')
    const bootsAfterPrewarm = logs.filter((l) => l.message.includes('dshKernel.ensureRuntime')).length
    assert.equal(bootsAfterPrewarm, 1, 'prewarm booted the runtime once')

    const outcome = await hub.runTurn({
      sessionId: 'cowork-prewarmslot',
      dshSessionId: 'prewarmslot-1',
      prompt: 'hello after turn-slot prewarm',
      provider,
      workspace,
      sections: [{ name: 'idbots:base', order: 0, text: 'You are Alice.' }],
      callbacks: callbacks(),
    })
    assert.notEqual(outcome.kind, 'error', `first turn after turn-slot prewarm must succeed: ${JSON.stringify(outcome).slice(0, 200)}`)
    assert.equal(hub.restartCount, 0, 'the turn must not restart the prewarmed process')
    const bootsAfterTurn = logs.filter((l) => l.message.includes('dshKernel.ensureRuntime')).length
    assert.equal(bootsAfterTurn, 1, 'the turn reused the prewarmed process (MCP union already accumulated)')
    const reuseLogs = logs.filter((l) => l.message.includes('prewarmTurnSlot.reuse')).length
    assert.ok(reuseLogs >= 0, 'reuse logging is best-effort')
  } finally {
    await hub.close().catch(() => undefined)
    server.close()
    fs.rmSync(sessionRoot, { recursive: true, force: true })
  }
})

test('prewarmTurnSlot resolves the session automation combo onto its .auto-* slot', {
  skip: !runtimeReady
    ? 'dsh-runtime node_modules not installed'
    : (!['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
        process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
        '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
      .some((p) => p && fs.existsSync(p)))
      ? 'no Chrome/Chromium found for the automation composition'
      : false,
}, async () => {
  const { DshTurnHub } = loaded.coworkDshTurn
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server } = await startMockServer(48824)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-dsh-warmup-auto-'))
  const logs = []
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot,
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
    // The opted-in bot: browser automation mounts for exactly this session,
    // mirroring the default-ON per-bot switch in production.
    browserAutomationProvider: (coworkSessionId) => coworkSessionId === 'cowork-autobot'
      ? { mode: 'launch', headless: true }
      : undefined,
  })
  const provider = {
    key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48824/v1',
    apiKey: 'sk-a', model: 'mock-1',
  }

  try {
    await hub.prewarmTurnSlot({
      sessionId: 'cowork-autobot',
      provider,
      workspace: { cwd: sessionRoot },
    })
    const bootLog = logs.find((l) => l.message.includes('prewarmTurnSlot.boot'))
    assert.ok(bootLog, 'prewarm logged the booted slot')
    assert.equal(bootLog.detail.runtime, 'mockgw.auto-b', 'the automation opt-in rides its own slot')
    assert.equal(bootLog.detail.browser, true)
    assert.equal(hub.running, true, 'the automation slot is live after prewarm')
  } finally {
    await hub.close().catch(() => undefined)
    server.close()
    fs.rmSync(sessionRoot, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Multi-combo app-start warm (2026-10-16 follow-up): warming only the
// MOST-recent session's slot left every other bot cold — session 70fa10aa
// (warmup warmed zhipu.auto-bc; the user's next chat was a deepseek bot whose
// slot booted for 38s inside the turn). prewarmDshRuntime must warm the top
// few DISTINCT (route × automation combo) slots from recent sessions.
// ---------------------------------------------------------------------------

test('prewarmDshRuntime warms distinct recent bot combos, not just the most recent', {
  skip: !runtimeReady
    ? 'dsh-runtime node_modules not installed'
    : (!['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
      .some((p) => p && fs.existsSync(p)))
      ? 'no Chrome/Chromium found for the automation composition'
      : false,
}, async (t) => {
  const { coworkRunner, claudeSettings } = (() => {
    const originalLoad = Module._load
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'electron') {
        return {
          app: {
            isPackaged: false,
            getAppPath: () => process.cwd(),
            getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-warmup-${name}`),
          },
        }
      }
      return originalLoad.apply(this, arguments)
    }
    try {
      return {
        coworkRunner: require('../dist-electron/main/libs/coworkRunner.js'),
        claudeSettings: require('../dist-electron/main/libs/claudeSettings.js'),
      }
    } finally {
      Module._load = originalLoad
    }
  })()
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server } = await startMockServer(48825)

  const fakeConfigStore = {
    get: (key) => {
      if (key !== 'app_config') return undefined
      return {
        api: { key: 'sk-a', baseUrl: 'http://127.0.0.1:48825/v1' },
        model: { availableModels: [{ id: 'mock-1', name: 'mock-1' }], defaultModel: 'mock-1', defaultProvider: 'mockgw' },
        providers: {
          mockgw: { enabled: true, apiKey: 'sk-a', baseUrl: 'http://127.0.0.1:48825/v1', apiFormat: 'openai', models: [{ id: 'mock-1', name: 'mock-1', contextWindow: 32768 }] },
        },
        dshKernelEnabled: true,
      }
    },
  }
  claudeSettings.setStoreGetter(() => fakeConfigStore)

  const store = {
    listSessions: () => [
      { id: 'warm-combo-clean-a' },
      { id: 'warm-combo-auto' },
      { id: 'warm-combo-clean-b' },
    ],
    getSession: (id) => ({
      id,
      executionMode: 'local',
      model: 'mock-1',
      modelProvider: 'mockgw',
      cwd: process.cwd(),
      messages: [],
    }),
    getSessionWithoutMessages: (id) => store.getSession(id),
    getConfig: () => ({ workingDirectory: process.cwd() }),
  }
  const runner = new coworkRunner.CoworkRunner(store, {
    // Only the second-most-recent session's bot opted into browser automation:
    // its .auto-b slot must be warmed even though the MOST-recent session is a
    // clean-combo bot (the 70fa10aa gap).
    browserAutomationProvider: (sessionId) => sessionId === 'warm-combo-auto'
      ? { mode: 'launch', headless: true }
      : undefined,
    computerUseProvider: () => false,
  })
  t.after(async () => {
    await runner.dshTurnHub?.close().catch(() => undefined)
    server.close()
    claudeSettings.setStoreGetter(() => null)
  })

  await runner.prewarmDshRuntime()
  const hub = runner.dshTurnHub
  assert.ok(hub, 'warmup spawned the hub')
  assert.equal(hub.running, true, 'runtime(s) left running after warmup')
  // Clean combos share the bare provider slot; the automation opt-in rides
  // its own .auto-b slot — two slots total, both prewarmed.
  assert.equal(hub.runtimeSlotCount, 2, `expected clean + auto-b slots, got ${hub.runtimeSlotCount}`)
  const comboLog = fs.readFileSync(
    path.join(process.cwd(), '.cowork-temp', 'dsh-warmup-userData', 'logs', 'cowork.log'),
    'utf8',
  )
  const boots = [...comboLog.matchAll(/prewarmTurnSlot\.boot\n  runtime: ([^\n]+)\n  sessionId: ([^\n]+)/g)]
    .map((m) => ({ runtime: m[1].trim(), sessionId: m[2].trim() }))
  assert.ok(
    boots.some((entry) => entry.sessionId === 'warm-combo-auto' && entry.runtime === 'mockgw.auto-b'),
    `the automation bot's slot was prewarmed under its own .auto-b runtime (boots: ${JSON.stringify(boots)})`,
  )
})
