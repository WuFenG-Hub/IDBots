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
const here = path.dirname(new URL(import.meta.url).pathname)
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
