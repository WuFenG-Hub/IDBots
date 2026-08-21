// P0: shared DSH runtime must not run Twin then Worker bash in the first
// session's folder. Composition bash/fs plugin cwd stays first-pinned so a
// cwd change does not restart the runtime; execution cwd rides session/ensure
// (session.header.cwd).
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
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-wscwd-${name}`),
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

const markerOf = (dir) => {
  const file = path.join(dir, 'marker.txt')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null
}

test('two cowork sessions write bash markers into their own workspaces', {
  skip: runtimeReady ? false : 'dsh-runtime node_modules not installed',
}, async () => {
  const { DshTurnHub } = loadModules()
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server } = await startMockServer(48825)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-wscwd-sess-'))
  const workspaceA = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-wscwd-a-'))
  const workspaceB = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-wscwd-b-'))
  const logs = []
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot,
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
  })
  const provider = {
    key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48825/v1',
    apiKey: 'sk-a', model: 'mock-1',
  }
  const callbacks = () => ({
    onMessage: () => `m-${Math.random().toString(36).slice(2)}`,
    onMessageUpdate: () => undefined,
    onMessageFinalize: () => undefined,
    onUsage: () => undefined,
    onApprovalRequest: (ask) => {
      void hub.respondApproval(ask.id, 'allowed-once').catch(() => undefined)
    },
    onApprovalCancelled: () => undefined,
  })

  const runTurn = (dshSessionId, workspace, token) => hub.runTurn({
    sessionId: `cowork-${dshSessionId}`,
    dshSessionId,
    prompt: `RUN_BASH_WRITE:${token}`,
    provider,
    workspace,
    sections: [{ name: 'idbots:base', order: 0, text: 'You are Alice.' }],
    callbacks: callbacks(),
  })

  try {
    const outA = await runTurn('twin-1', { cwd: workspaceA }, 'twin')
    assert.notEqual(outA.kind, 'error', `turn A must complete: ${JSON.stringify(outA).slice(0, 200)}`)
    const outB = await runTurn('worker-1', { cwd: workspaceB }, 'worker')
    assert.notEqual(outB.kind, 'error', `turn B must complete: ${JSON.stringify(outB).slice(0, 200)}`)

    assert.equal(hub.restartCount, 0, 'second workspace must not restart the shared runtime')
    assert.equal(markerOf(workspaceA), 'twin', `workspace A marker: ${markerOf(workspaceA)}`)
    assert.equal(markerOf(workspaceB), 'worker', `workspace B marker: ${markerOf(workspaceB)}`)
    assert.equal(markerOf(sessionRoot), null, 'sessionRoot must not receive cowork bash writes')
  } finally {
    await hub.close().catch(() => undefined)
    server.close()
    fs.rmSync(sessionRoot, { recursive: true, force: true })
    fs.rmSync(workspaceA, { recursive: true, force: true })
    fs.rmSync(workspaceB, { recursive: true, force: true })
  }
})
