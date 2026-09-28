// Kill-safety of the DSH runtime lifecycle: nothing may retire or restart a
// runtime process while work is still running on it — host-controller turns
// OR kernel-initiated activity (continuable-subagent turns have no host
// controller and were invisible to the old accounting).
//
// Incident (2026-09-28 16:32 UTC, sessions 540635be / cf70e758 / 406a8208):
// a providers config change on the shared zhipu.auto-bc slot booted a
// successor; ~5 min later BOTH processes exited (exit 0 — the runtime's
// SIGTERM handler also exits 0, masking the killer) under three in-flight
// turns. Two holes: dshKernel.ensureRuntime silently restart()ed a live
// process whenever the incoming config JSON drifted (no guard, no log), and
// settleDrains/reap counted only host controllers.
//
// Fix under test:
//  1. ensureRuntime NEVER restarts a running kernel (config application is
//     hub-owned and explicit).
//  2. The hub treats recent kernel-side notifications (any session event,
//     status, lifecycle edge) as busy: drained kernels are not retired,
//     slots are not reaped, config changes take successor+drain instead of
//     an in-place restart.
//  3. In-place restart happens ONLY when truly idle, and logs itself.
//
// Requires: pnpm run compile:electron + dsh-runtime/node_modules installed.

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
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-killguard-${name}`),
        },
      }
    }
    return originalLoad.apply(this, arguments)
  }
  try {
    return {
      hub: require('../dist-electron/main/libs/coworkDshTurn.js'),
      kernel: require('../dist-electron/main/libs/dshKernel/dshKernel.js'),
    }
  } finally {
    Module._load = originalLoad
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A minimal kernel stand-in exercising exactly the surface the hub touches:
 *  running / hasRecentActivity / lastNotificationAt / close / restart /
 *  ensureRuntime / disposeSession. */
const fakeKernel = (overrides = {}) => {
  const state = {
    running: true,
    lastNotificationAt: Date.now(),
    closeCalls: 0,
    restartCalls: 0,
    async close() { state.closeCalls += 1; state.running = false },
    async restart() { state.restartCalls += 1 },
    async ensureRuntime() {},
    async disposeSession() { return { disposed: true } },
    hasRecentActivity(graceMs) {
      return state.running && state.lastNotificationAt > 0
        && Date.now() - state.lastNotificationAt < Math.max(0, graceMs)
    },
    ...overrides,
  }
  return state
}

test('ensureRuntime reuses a running kernel whatever the config says — no silent restart', {
  skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed',
}, async () => {
  const { kernel: kernelModule } = loadModules()
  const { DshKernel } = kernelModule
  const k = new DshKernel({ handlers: {} })
  const client = { close: async () => { throw new Error('must not be called') } }
  // White-box: simulate a live runtime (boot normally assigns these).
  k.client = client
  k.runtimeConfig = { sessionRoot: '/a', providers: [{ key: 'p', models: [] }], sections: [] }
  const drifted = { sessionRoot: '/b', providers: [{ key: 'q', models: [] }], sections: [] }
  await k.ensureRuntime(drifted)
  assert.equal(k.client, client, 'the live client is untouched')
  assert.deepEqual(k.runtimeConfig.providers[0], { key: 'p', models: [] }, 'recorded config unchanged')
})

test('a kernel without notifications has no recent activity', {
  skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed',
}, async () => {
  const { kernel: kernelModule } = loadModules()
  const { DshKernel } = kernelModule
  const k = new DshKernel({ handlers: {} })
  assert.equal(k.hasRecentActivity(60_000), false, 'lastNotificationAt 0 → never active')
  k.lastNotificationAt = Date.now() - 5_000
  assert.equal(k.hasRecentActivity(10_000), true, 'recent notification counts within grace')
  assert.equal(k.hasRecentActivity(1_000), false, 'and not beyond grace')
  assert.equal(k.hasRecentActivity(0), false, 'grace 0 disables the protection')
})

test('settleDrains retires a drained kernel only after kernel-side silence', {
  skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed',
}, () => {
  const { hub: hubModule } = loadModules()
  const { DshTurnHub } = hubModule
  const logs = []
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-killguard-drain-')),
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
    kernelActivityGraceMs: 200,
  })
  try {
    const drained = fakeKernel()
    hub.slots.get('mockgw') ?? hub.getOrCreateSlot('mockgw')
    hub.slots.get('mockgw').drainingKernels.push(drained)

    // Kernel-side notifications flowed a moment ago → keep the process.
    hub.settleDrains('mockgw')
    assert.equal(drained.closeCalls, 0, 'activity within grace defers retirement')
    assert.ok(logs.some((l) => l.message.includes('drainRetireDeferredByActivity')),
      'the deferral is visible in the hub log')

    // Silence past the grace window → retire, with diagnostics.
    drained.lastNotificationAt = Date.now() - 10_000
    hub.settleDrains('mockgw')
    assert.equal(drained.closeCalls, 1, 'a silent drained kernel is retired')
    const closed = logs.find((l) => l.message.includes('drainedRuntimeClosed'))
    assert.ok(closed, 'retirement logged')
    assert.ok(Number.isFinite(closed.detail.idleForMs), 'retirement log carries the idle age')

    // A dead process (not running) is settled immediately regardless.
    const dead = fakeKernel({ running: false, lastNotificationAt: Date.now() })
    hub.slots.get('mockgw').drainingKernels.push(dead)
    hub.settleDrains('mockgw')
    assert.equal(dead.closeCalls, 1, 'a dead kernel is bookkeeping-closed')
  } finally {
    void hub.close().catch(() => undefined)
  }
})

test('reapIdleSlots keeps a slot whose kernel showed recent activity', {
  skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed',
}, async () => {
  const { hub: hubModule } = loadModules()
  const { DshTurnHub } = hubModule
  const logs = []
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-killguard-reap-')),
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
    runtimeIdleTtlMs: 100,
    kernelActivityGraceMs: 60_000,
  })
  try {
    const active = fakeKernel()
    const slot = hub.getOrCreateSlot('mockgw')
    slot.kernel = active
    slot.lastUsedAt = Date.now() - 60_000 // host-side idle long past the TTL
    await hub.reapIdleSlots()
    assert.equal(hub.slots.has('mockgw'), true, 'kernel-side activity keeps the slot')
    assert.equal(active.closeCalls, 0)

    active.lastNotificationAt = Date.now() - 120_000 // silent past grace
    await hub.reapIdleSlots()
    assert.equal(hub.slots.has('mockgw'), false, 'silent + idle slot is reaped')
    assert.equal(active.closeCalls, 1)
  } finally {
    void hub.close().catch(() => undefined)
  }
})

test('config drift under kernel-side activity takes successor+drain, never an in-place restart', {
  skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed',
}, async () => {
  const { hub: hubModule } = loadModules()
  const { DshTurnHub } = hubModule
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server } = await startMockServer(48831)
  const logs = []
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-killguard-flap-')),
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
    kernelActivityGraceMs: 60_000,
  })
  const provider = {
    key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48831/v1',
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
    // Seed the slot with a "running" kernel that has fresh kernel-side
    // activity (a continuable subagent turn streaming) and a stale config.
    const busy = fakeKernel()
    const slot = hub.getOrCreateSlot('mockgw')
    slot.kernel = busy
    slot.lastConfigJson = JSON.stringify({ stale: 'previous-config' })

    const kernel = await hub.ensureKernel({
      sessionId: 'cowork-flap', dshSessionId: 'cw-flap', prompt: '',
      provider, sections: [{ name: 'idbots:base', order: 0, text: 'You are Alice.' }],
      callbacks: callbacks(),
    })
    assert.notEqual(kernel, busy, 'the turn does not run on the busy old kernel')
    assert.ok(slot.drainingKernels.includes(busy), 'the old kernel drains instead of being killed')
    assert.equal(busy.restartCalls, 0, 'no in-place restart under activity')
    assert.equal(busy.closeCalls, 0, 'the old process is left alive to finish its work')
    assert.ok(logs.some((l) => l.message.includes('successor runtime and draining the old one')),
      'the successor boot is logged with its reason')
    await hub.close().catch(() => undefined)
    server.close()
  } finally {
    await hub.close().catch(() => undefined)
    server.close()
  }
})

test('config drift on a truly idle kernel restarts in place — explicit and logged', {
  skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed',
}, async () => {
  const { hub: hubModule } = loadModules()
  const { DshTurnHub } = hubModule
  const logs = []
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-killguard-idle-')),
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
    kernelActivityGraceMs: 60_000,
  })
  const provider = {
    key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48831/v1',
    apiKey: 'sk-a', model: 'mock-1',
  }
  const callbacks = () => ({
    onMessage: () => 'm',
    onMessageUpdate: () => undefined,
    onMessageFinalize: () => undefined,
    onUsage: () => undefined,
    onApprovalRequest: () => undefined,
    onApprovalCancelled: () => undefined,
  })
  try {
    const idle = fakeKernel({ lastNotificationAt: Date.now() - 120_000 })
    const slot = hub.getOrCreateSlot('mockgw')
    slot.kernel = idle
    slot.lastConfigJson = JSON.stringify({ stale: 'previous-config' })

    const kernel = await hub.ensureKernel({
      sessionId: 'cowork-idle-restart', dshSessionId: 'cw-idle-restart', prompt: '',
      provider, sections: [], callbacks: callbacks(),
    })
    assert.equal(kernel, idle, 'an idle kernel is reused after the in-place restart')
    assert.equal(idle.restartCalls, 1, 'the restart happened exactly once')
    assert.ok(logs.some((l) => l.message.includes('inPlaceRuntimeRestart')),
      'the restart is logged for post-mortems')
  } finally {
    await hub.close().catch(() => undefined)
  }
})

test('pump notifications refresh the kernel activity clock', {
  skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed',
}, async () => {
  const { kernel: kernelModule } = loadModules()
  const { DshKernel } = kernelModule
  const k = new DshKernel({ handlers: { onStatus: () => undefined } })
  k.lastNotificationAt = 0
  // White-box: drive the private pump with a one-shot async iterator.
  const notifications = [
    { method: 'session.status', params: { sessionId: 's1', status: 'running' } },
  ]
  let i = 0
  const subscription = {
    next: async () => (i < notifications.length
      ? notifications[i++]
      : Promise.reject(new Error('TransportClosedError: stream closed'))),
  }
  const client = { subscribe: () => subscription }
  await k.pumpNotifications(client)
  assert.ok(k.lastNotificationAt > 0, 'the observed notification stamped the activity clock')
  assert.ok(k.hasRecentActivity(60_000), 'a kernel-side status edge counts as recent activity')
  await sleep(0)
})
