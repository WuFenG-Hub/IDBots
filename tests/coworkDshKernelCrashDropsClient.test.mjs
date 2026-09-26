// DshKernel crash liveness: when the runtime process dies on its own
// (kernel crash/OOM/kill — the 2026-09-24 spill-ENOENT incident killed the
// shared zhipu runtime with exit 1), the notification pump used to keep the
// dead client, so `running` stayed true and the turn hub "reused the live
// runtime" on every subsequent turn — an 8-minute "DSH runtime is not
// running" cascade until an unrelated config change restarted the slot.
// Fix under test: unexpected transport death drops the dead client (so
// `running` reports false and the next ensureRuntime boots a successor),
// clears the per-process mapper/slot bookkeeping (same contract as
// restart()), and reaps the child through the SDK close ladder in the
// background. Additionally, concurrent ensureRuntime calls coalesce onto a
// single runtime boot — the crash respawn-once path restarts outside the
// hub's per-slot serialization chain, and an unmerged second caller inside
// the ~20s wire-handshake window would boot a duplicate runtime (first
// client dropped unclosed → leaked process, two writers on one sessionRoot).
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
 * transport-death shape the SDK reports for an exited runtime process. The
 * close spy records the background reap through the SDK kill ladder. */
const deadTransportClient = (events = []) => ({
  subscribe: () => ({
    next: () => Promise.reject(new Error('idbots-dsh-runtime: DeepSeek Harness runtime exited\nexit code: 1')),
  }),
  close: () => {
    events.push('close')
    return Promise.resolve()
  },
})

const newKernel = (errors = []) => new (loadModules().DshKernel)({
  runtimeDir: here,
  handlers: { onError: (error) => errors.push(error.message) },
  log: () => {},
})

test('unexpected transport death drops the dead client so the next turn reboots', async () => {
  const errors = []
  const kernel = newKernel(errors)
  const events = []
  const client = deadTransportClient(events)
  kernel.client = client
  kernel.runtimeConfig = { stale: true }
  kernel.mappers.set('cw-x', {})
  kernel.slotIds.set('cw-x', {})
  assert.equal(kernel.running, true, 'precondition: booted kernel reports running')

  await kernel.pumpNotifications(client)

  assert.equal(kernel.client, null, 'the dead client reference is dropped')
  assert.equal(kernel.running, false, 'running no longer reports a dead process as live')
  assert.equal(kernel.runtimeConfig, null, 'stale boot config is cleared (restart() contract)')
  assert.equal(kernel.mappers.size, 0, 'per-process mapper state is cleared for the successor')
  assert.equal(kernel.slotIds.size, 0, 'per-process slot state is cleared for the successor')
  assert.equal(errors.length, 1, 'the fatal channel fired exactly once')
  assert.match(errors[0], /runtime exited/, 'the error names the exit')
  assert.equal(events.includes('close'), true, 'the dead child is reaped through the close ladder')
})

test('a superseded pump must not touch a successor client (identity guard)', async () => {
  const errors = []
  const kernel = newKernel(errors)
  const oldEvents = []
  const oldClient = deadTransportClient(oldEvents)
  const successor = { alive: true }
  // restart() already swapped in the successor; the OLD pump's subscription
  // rejects afterwards during the close ladder.
  kernel.client = successor
  kernel.runtimeConfig = { fresh: true }
  kernel.mappers.set('cw-y', {})
  await kernel.pumpNotifications(oldClient)
  assert.equal(kernel.client, successor, 'the successor client is intact')
  assert.equal(kernel.running, true, 'the successor keeps the kernel running')
  assert.deepEqual(kernel.runtimeConfig, { fresh: true }, 'the successor config survives')
  assert.equal(kernel.mappers.size, 1, 'the successor mapper state survives')
  assert.equal(oldEvents.includes('close'), true, 'the pump still reaps its OWN old child')
})

test('a deliberate close stays silent — no onError, no reap from the pump', async () => {
  const errors = []
  const kernel = newKernel(errors)
  const events = []
  const client = deadTransportClient(events)
  kernel.client = client
  kernel.closed = true
  await kernel.pumpNotifications(client)
  assert.equal(errors.length, 0, 'close() explains the death itself — onError stays quiet')
  assert.equal(events.includes('close'), false, 'close() owns the ladder; the pump does not double-reap')
})

test('concurrent ensureRuntime calls coalesce onto one runtime boot', async () => {
  const { DshKernel } = loadModules()
  const kernel = new DshKernel({
    runtimeDir: here,
    handlers: { onError: () => {} },
    log: () => {},
  })
  let boots = 0
  let inBoot = 0
  // Stub the single-flight body: count boots and hold each one open long
  // enough that a racy second caller would start its own boot if the merge
  // were missing.
  kernel.bootRuntime = async (config) => {
    boots += 1
    inBoot += 1
    assert.equal(inBoot, 1, 'only one boot is ever in flight')
    await new Promise((resolve) => setTimeout(resolve, 60))
    inBoot -= 1
    kernel.client = { config }
    kernel.runtimeConfig = config
  }
  const configA = { sessionRoot: '/tmp/a', providers: [] }
  const configB = { sessionRoot: '/tmp/a', providers: [] }
  await Promise.all([
    kernel.ensureRuntime(configA),
    kernel.ensureRuntime(configB),
    kernel.ensureRuntime(configA),
  ])
  assert.equal(boots, 1, 'three concurrent callers shared a single boot (no duplicate runtime process)')
  assert.equal(kernel.client.config, configA, 'the first caller\'s boot won')
  // A later caller now reuses the live client instead of booting again.
  await kernel.ensureRuntime(configB)
  assert.equal(boots, 1, 'a sequential caller after the boot reuses the client')
})

test('a failed boot clears the memo so the next caller retries fresh', async () => {
  const { DshKernel } = loadModules()
  const kernel = new DshKernel({
    runtimeDir: here,
    handlers: { onError: () => {} },
    log: () => {},
  })
  let boots = 0
  kernel.bootRuntime = async () => {
    boots += 1
    if (boots === 1) throw new Error('boot failed')
    kernel.client = { ok: true }
  }
  await assert.rejects(kernel.ensureRuntime({ sessionRoot: '/tmp/a', providers: [] }), /boot failed/)
  assert.equal(kernel.ensureInFlight, null, 'the memo cleared on failure')
  await kernel.ensureRuntime({ sessionRoot: '/tmp/a', providers: [] })
  assert.equal(boots, 2, 'the next caller booted instead of replaying the failure')
})
