// Encoding-mismatch self-heal (2026-09-01 incident): a sibling app instance
// on an older pre-zstd build shared this userData, kept a compression:'none'
// backend alive, and the zstd side's scheduled task died with "session
// artifact …session.jsonl.zstd uses .jsonl.zstd, but this backend is
// configured for compression \"none\"". The residual hazard for current code
// runs the other way: an old instance can drop PLAINTEXT artifacts into the
// shared root after the zstd runtime booted — the boot-time migration does
// not see that drift, and the backend memoizes its root-encoding rejection,
// so every subsequent session/ensure fails until the process is replaced.
//
// Fix under test: runTurn catches the encoding-mismatch fingerprint at
// session/ensure, re-migrates the root, supersedes the slot's kernel (fresh
// process, clean rejection cache), and retries the ensure once.
// Requires: npm run compile:electron + dsh-runtime/node_modules.

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
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-encheal-${name}`),
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

test('isSessionEncodingMismatchError matches only the backend encoding fingerprint', () => {
  const { isSessionEncodingMismatchError } = require('../dist-electron/main/libs/dshKernel/dshKernel.js')
  const incidentMessage = 'session artifact "/…/cw-x/session.jsonl.zstd" uses .jsonl.zstd, but this backend is configured for compression "none"; use a separate root or select the matching compression mode'
  assert.equal(isSessionEncodingMismatchError(new Error(incidentMessage)), true)
  assert.equal(isSessionEncodingMismatchError(new Error('…uses the unsupported flat-file layout; …')), false)
  assert.equal(isSessionEncodingMismatchError(new Error('DeepSeek API request failed')), false)
  assert.equal(isSessionEncodingMismatchError('but this backend is configured for compression "zstd"'), true, 'non-Error carries a message string')
  assert.equal(isSessionEncodingMismatchError(null), false)
})

test('plaintext drift in the shared root self-heals: re-migrate + successor runtime + retry', { skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed' }, async () => {
  const { DshTurnHub } = loadModules()
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server } = await startMockServer(48802)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-encheal-'))
  const logs = []
  const hubA = new DshTurnHub({
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
  const provider = {
    key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48802/v1',
    apiKey: 'sk-a', model: 'mock-1',
  }
  const runTurnOn = (hub, dshSessionId, prompt) => hub.runTurn({
    sessionId: `cowork-${dshSessionId}`, dshSessionId, prompt, provider,
    sections: [{ name: 'idbots:base', order: 0, text: 'You are Alice.' }],
    callbacks: callbacks(),
  })

  const hub = hubA
  try {
    // Session b exists and is resumable; then its runtime goes away so the
    // next one performs its FIRST root-encoding check only after the drift
    // lands (the backend memoizes a passing check just like a rejecting one —
    // a runtime that already checked a clean root never sees the drift).
    const outB1 = await runTurnOn(hubA, 'b', 'hello')
    assert.notEqual(outB1.kind, 'error', `setup turn: ${JSON.stringify(outB1).slice(0, 200)}`)
    await hubA.close().catch(() => undefined)

    // Fresh runtime, boot migration runs against a still-clean root, and no
    // session has loaded yet — its first root check is still pending.
    const hubB = new DshTurnHub({
      runtimeDir,
      sessionRoot,
      log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
    })
    try {
      await hubB.prewarm({ provider })
      // Simulate the old-instance drift: a plaintext artifact lands in the
      // shared root AFTER the zstd runtime booted (boot-time migration misses it).
      const strayDir = path.join(sessionRoot, '--legacy-oldapp--', 'cw-stray')
      fs.mkdirSync(strayDir, { recursive: true })
      fs.writeFileSync(path.join(strayDir, 'session.jsonl'), '{"type":"request/header"}\n')

      // Resuming session b now trips the backend's (memoized) root-encoding
      // rejection at session/ensure — the heal must recover the turn.
      const outB2 = await runTurnOn(hubB, 'b', 'hello again')
      assert.notEqual(outB2.kind, 'error', `healed turn: ${JSON.stringify(outB2).slice(0, 200)}`)
      assert.ok(
        logs.some((l) => l.message.includes('dshTurnHub.encodingMismatchHeal')),
        'heal was logged',
      )
      const boots = logs.filter((l) => l.message.includes('dshKernel.ensureRuntime')).length
      assert.ok(boots >= 2, `a successor runtime was booted (${boots} boots)`)
      assert.ok(
        !fs.existsSync(path.join(strayDir, 'session.jsonl')) && fs.existsSync(path.join(strayDir, 'session.jsonl.zstd')),
        'the drifted plaintext artifact was re-migrated onto zstd',
      )

      // Later turns run normally on the healed slot.
      const outC = await runTurnOn(hubB, 'c', 'still fine')
      assert.notEqual(outC.kind, 'error', `post-heal turn: ${JSON.stringify(outC).slice(0, 200)}`)
    } finally {
      await hubB.close().catch(() => undefined)
    }
  } finally {
    await hubA.close().catch(() => undefined)
    server.close()
    fs.rmSync(sessionRoot, { recursive: true, force: true })
  }
})
