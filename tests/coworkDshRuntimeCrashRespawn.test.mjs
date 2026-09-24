// Crashed-runtime respawn: when the DSH runtime process dies on its own
// (kernel crash/OOM/kill — the 2026-09-24 spill-ENOENT incident killed the
// shared zhipu runtime with exit 1), the kernel used to keep the dead client
// (`running` stayed true), so every subsequent turn "reused the live
// runtime", failed with "DeepSeek Harness runtime is not running", and
// sessions stayed broken until an unrelated config change restarted the slot
// (8-minute cascade, 146 log entries). Fix under test: the notification pump
// drops the dead client on unexpected transport death, so the NEXT turn
// boots a successor runtime and resumes the session from disk.
// Requires: pnpm run compile:electron + dsh-runtime/node_modules.

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import { execSync } from 'node:child_process'
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
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-crash-${name}`),
        },
      }
    }
    return originalLoad.apply(this, arguments)
  }
  try {
    return require('../dist-electron/main/libs/coworkDshTurn.js')
  } finally {
    Module._load = originalLoad
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (predicate, timeoutMs = 45000, what = 'condition') => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await sleep(50)
  }
  throw new Error(`timeout waiting for ${what}`)
}

test('a SIGKILLed runtime is respawned by the next turn, not turned into an error cascade', {
  skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed',
}, async () => {
  const { DshTurnHub } = loadModules()
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server } = await startMockServer(48831)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-crashrespawn-'))
  const marker = path.basename(sessionRoot)
  const logs = []
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot,
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
  })
  const callbacks = () => ({
    onMessage: () => `m-${Math.random().toString(36).slice(2)}`,
    onMessageUpdate: () => undefined,
    onMessageFinalize: () => undefined,
    onUsage: () => undefined,
    onApprovalRequest: () => undefined,
    onApprovalCancelled: () => undefined,
  })
  const route = {
    key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48831/v1',
    apiKey: 'sk-a', model: 'mock-1',
  }
  const runTurn = (prompt) => hub.runTurn({
    sessionId: 'cowork-crash', dshSessionId: 'crash-1', prompt, provider: route,
    sections: [{ name: 'idbots:base', order: 0, text: 'You are Alice.' }],
    hostTools: [],
    callbacks: callbacks(),
  })

  try {
    const outA = await runTurn('hello')
    assert.notEqual(outA.kind, 'error', `baseline turn must succeed: ${JSON.stringify(outA).slice(0, 240)}`)
    await waitFor(() => logs.some((l) => l.message.includes('dshKernel.ensureRuntime')), 45000, 'first runtime boot')

    // Kill the runtime process out from under the hub — the incident shape
    // (external death, no close(), no config change).
    execSync(`pkill -9 -f "bin.mjs .*${marker}"`)
    await waitFor(
      () => logs.some((l) => l.message.includes('dshTurnHub.pump')),
      45000,
      'hub observing the transport death',
    )

    // The kernel must no longer report the dead process as a live runtime.
    assert.equal(hub.runtimeSlotCount, 1, 'slot survives the crash')
    const outB = await runTurn('hello again after the crash')
    assert.notEqual(
      outB.kind, 'error',
      `the turn after a crashed runtime must respawn and succeed: ${JSON.stringify(outB).slice(0, 240)}`,
    )
    const boots = logs.filter((l) => l.message.includes('dshKernel.ensureRuntime')).length
    assert.equal(boots, 2, `a successor runtime was booted on demand (got ${boots} boots)`)
  } finally {
    await hub.close().catch(() => undefined)
    server.close()
    fs.rmSync(sessionRoot, { recursive: true, force: true })
  }
})
