// DshKernel crash liveness: when the runtime process dies on its own
// (kernel crash/OOM/kill — the 2026-09-24 spill-ENOENT incident killed the
// shared zhipu runtime with exit 1), the notification pump used to keep the
// dead client, so `running` stayed true and the turn hub "reused the live
// runtime" on every subsequent turn — an 8-minute "DSH runtime is not
// running" cascade until an unrelated config change restarted the slot.
// Fix under test: unexpected transport death drops the dead client (so
// `running` reports false and the next ensureRuntime boots a successor),
// while a superseded pump cannot null a successor's client and a deliberate
// close stays silent.
// Requires: pnpm run compile:electron.

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'

const require = Module.createRequire(import.meta.url)
const here = import.meta.dirname

function loadModules() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => here,
        },
      }
    }
    return originalLoad.apply(this, arguments)
  }
  try {
    return require('../dist-electron/main/libs/dshKernel/dshKernel.js')
  } finally {
    Module._load = originalLoad
  }
}

/** A client whose notification stream dies on the first pull — the
 * transport-death shape the SDK reports for an exited runtime process. */
const deadTransportClient = () => ({
  subscribe: () => ({
    next: () => Promise.reject(new Error('idbots-dsh-runtime: DeepSeek Harness runtime exited\nexit code: 1')),
  }),
})

test('unexpected transport death drops the dead client so the next turn reboots', async () => {
  const { DshKernel } = loadModules()
  const errors = []
  const kernel = new DshKernel({
    runtimeDir: here,
    handlers: { onError: (error) => errors.push(error.message) },
    log: () => {},
  })
  const client = deadTransportClient()
  kernel.client = client
  assert.equal(kernel.running, true, 'precondition: booted kernel reports running')

  await kernel.pumpNotifications(client)

  assert.equal(kernel.client, null, 'the dead client reference is dropped')
  assert.equal(kernel.running, false, 'running no longer reports a dead process as live')
  assert.equal(errors.length, 1, 'the fatal channel fired exactly once')
  assert.match(errors[0], /runtime exited/, 'the error names the exit')
})

test('a superseded pump must not null a successor client (identity guard)', async () => {
  const { DshKernel } = loadModules()
  const kernel = new DshKernel({
    runtimeDir: here,
    handlers: { onError: () => {} },
    log: () => {},
  })
  const oldClient = deadTransportClient()
  const successor = { alive: true }
  // restart() already swapped in the successor; the OLD pump's subscription
  // rejects afterwards during the close ladder.
  kernel.client = successor
  await kernel.pumpNotifications(oldClient)
  assert.equal(kernel.client, successor, 'the successor client is intact')
  assert.equal(kernel.running, true, 'the successor keeps the kernel running')
})

test('a deliberate close stays silent — no onError, no crash liveness change', async () => {
  const { DshKernel } = loadModules()
  const errors = []
  const kernel = new DshKernel({
    runtimeDir: here,
    handlers: { onError: (error) => errors.push(error.message) },
    log: () => {},
  })
  const client = deadTransportClient()
  kernel.client = client
  kernel.closed = true
  await kernel.pumpNotifications(client)
  assert.equal(errors.length, 0, 'close() explains the death itself — onError stays quiet')
})
