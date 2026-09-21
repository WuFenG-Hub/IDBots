// Per-session turn queue in DshTurnHub.runTurn (2026-09-21 A2A incident).
//
// Two concurrent runTurn calls for the same DSH session (e.g. an A2A daemon
// double-dispatch, or a daemon turn racing a UI retry) used to clobber each
// other: the second overwrote controllersByDsh mid-flight and its finally
// then deleted the winner's event registrations — a turn that completed in
// the runtime never reached the host, so the bot's reply was silently lost.
//
// Fix under test: runTurn queues per dshSessionId. The queued turn must not
// reach the provider until the in-flight turn has fully settled, and each
// turn's events land on its own callbacks.
//
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
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-turnqueue-${name}`),
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

test('concurrent turns for one DSH session are serialized, never clobbered', { skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed' }, async () => {
  const { DshTurnHub } = loadModules()
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server, seen } = await startMockServer(48803)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-turnqueue-'))
  const logs = []
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot,
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
  })
  const provider = {
    key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48803/v1',
    apiKey: 'sk-a', model: 'mock-1',
  }
  const finalsA = []
  const finalsB = []
  const callbacksFor = (finals) => ({
    onMessage: () => `m-${Math.random().toString(36).slice(2)}`,
    onMessageUpdate: () => undefined,
    onMessageFinalize: (messageId, content) => finals.push(content),
    onUsage: () => undefined,
    onApprovalRequest: () => undefined,
    onApprovalCancelled: () => undefined,
  })
  const dshSessionId = 'queue-target'
  const runTurnWith = (coworkId, prompt, finals) => hub.runTurn({
    sessionId: coworkId, dshSessionId, prompt, provider,
    sections: [{ name: 'idbots:base', order: 0, text: 'You are Alice.' }],
    callbacks: callbacksFor(finals),
  })

  try {
    // Turn A starts; turn B is submitted immediately after (the double
    // dispatch shape). B must queue behind A.
    const turnA = runTurnWith('cowork-queue-a', 'QUEUE_ALPHA first turn', finalsA)
    const turnB = runTurnWith('cowork-queue-b', 'QUEUE_BETA second turn', finalsB)

    const outA = await turnA
    assert.notEqual(outA.kind, 'error', `turn A: ${JSON.stringify(outA).slice(0, 200)}`)

    // The moment A settles, no B prompt may have reached the provider yet.
    const betaEarly = seen.some((r) => JSON.stringify(r.body?.messages ?? []).includes('QUEUE_BETA'))
    assert.equal(betaEarly, false, 'queued turn reached the provider before the in-flight turn settled')
    assert.ok(
      logs.some((l) => l.message.includes('dshTurnHub.turnQueued')),
      'queue wait was logged',
    )

    const outB = await turnB
    assert.notEqual(outB.kind, 'error', `turn B: ${JSON.stringify(outB).slice(0, 200)}`)

    // Each turn's reply landed on its OWN callbacks (no controller clobber).
    assert.ok(
      finalsA.some((content) => content.includes('QUEUE_ALPHA')),
      `turn A reply delivered to A's callbacks (got: ${JSON.stringify(finalsA).slice(0, 200)})`,
    )
    assert.ok(
      finalsB.some((content) => content.includes('QUEUE_BETA')),
      `turn B reply delivered to B's callbacks (got: ${JSON.stringify(finalsB).slice(0, 200)})`,
    )
    assert.ok(
      !finalsA.some((content) => content.includes('QUEUE_BETA')),
      "turn B's reply leaked into A's callbacks",
    )
  } finally {
    await hub.close().catch(() => undefined)
    server.close()
    fs.rmSync(sessionRoot, { recursive: true, force: true })
  }
})
