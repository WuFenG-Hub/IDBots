// DSH boot-storm fixes (2026-10-16, sessions bd646510/c3419940/63e14cfb):
// app start fanned out 4-6 concurrent Electron-as-node runtime boots, and the
// hub-global webSearch block appearing with the first official-DeepSeek turn
// successor-booted every older slot in the same window — the main process
// starved (eventloop:lag 12-16s) and every in-process budget fired late.
//
//   1. queueKernelBoot serializes process spawns hub-wide (one boot at a
//      time; reuse/no-op ensures never queue).
//   2. The web-search mount state is per SLOT (fix/websearch-provider-gating,
//      PR #100): a DeepSeek-route slot carries the block from its own boot #1
//      and a non-DeepSeek slot never carries it, so no slot's config can flap
//      because of another slot's turn. That structurally retired the
//      construction-time webSearchSeed this file used to exercise.
//   3. App-start warmup boots the top combo first and the rest strictly
//      serially (covered in coworkDshWarmup.test.mjs — its two-slot
//      expectation now also proves serialization).
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

function loadModules() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-bootstorm-${name}`),
        },
        session: { defaultSession: { resolveProxy: async () => 'DIRECT' } },
      }
    }
    return originalLoad.apply(this, arguments)
  }
  try {
    return {
      coworkDshTurn: require('../dist-electron/main/libs/coworkDshTurn.js'),
    }
  } finally {
    Module._load = originalLoad
  }
}

const loaded = loadModules()

// ---------------------------------------------------------------------------
// Integration: serialized boots + per-slot webSearch block from boot #1.
// ---------------------------------------------------------------------------

test('concurrent cold boots serialize through the hub boot queue', {
  skip: runtimeReady ? false : 'dsh-runtime node_modules not installed',
  timeout: 180000,
}, async (t) => {
  const { DshTurnHub } = loaded.coworkDshTurn
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const serverA = await startMockServer(48841)
  const serverB = await startMockServer(48842)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-dsh-bootqueue-'))
  const logs = []
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot,
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
  })
  const providerA = {
    key: 'mockgw-a', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48841/v1',
    apiKey: 'sk-a', model: 'mock-1',
  }
  const providerB = {
    key: 'mockgw-b', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48842/v1',
    apiKey: 'sk-b', model: 'mock-1',
  }
  t.after(async () => {
    await hub.close().catch(() => undefined)
    serverA.server.close()
    serverB.server.close()
    fs.rmSync(sessionRoot, { recursive: true, force: true })
  })

  // Fire both cold boots together: without the boot queue both processes
  // spawn in the same window (the storm shape).
  await Promise.all([
    hub.prewarmTurnSlot({ sessionId: 'boot-a', provider: providerA, workspace: { cwd: sessionRoot } }),
    hub.prewarmTurnSlot({ sessionId: 'boot-b', provider: providerB, workspace: { cwd: sessionRoot } }),
  ])

  const queueWaits = logs.filter((l) => l.message.includes('bootQueueWait'))
  assert.ok(
    queueWaits.some((l) => (l.detail.waitMs ?? 0) >= 250),
    `the second boot queued behind the first instead of spawning concurrently (waits: ${JSON.stringify(queueWaits.map((l) => l.detail))})`,
  )
  assert.equal(hub.runtimeSlotCount, 2, 'both slots booted through the queue')
})

test('the web-search block is fixed per slot from boot #1: DeepSeek slot carries it, a non-DeepSeek slot never flaps', {
  skip: runtimeReady ? false : 'dsh-runtime node_modules not installed',
  timeout: 180000,
}, async (t) => {
  const { DshTurnHub } = loaded.coworkDshTurn
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const deepSeekServer = await startMockServer(48843)
  const otherServer = await startMockServer(48844)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-dsh-wsslot-'))
  const logs = []
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot,
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
  })
  const otherProvider = {
    key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48844/v1',
    apiKey: 'sk-a', model: 'mock-1',
  }
  const deepSeekProvider = {
    key: 'deepseek', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48843',
    apiKey: 'sk-ds', model: 'mock-1',
  }
  t.after(async () => {
    await hub.close().catch(() => undefined)
    deepSeekServer.server.close()
    otherServer.server.close()
    fs.rmSync(sessionRoot, { recursive: true, force: true })
  })

  // Boot the NON-DeepSeek slot first — the pre-#100 shape where a later
  // DeepSeek turn used to flip a hub-global flag and successor-boot it.
  await hub.prewarmTurnSlot({ sessionId: 'other-boot', provider: otherProvider, workspace: { cwd: sessionRoot } })
  const otherConfigPath = path.join(sessionRoot, 'cordis.runtime.mockgw.json')
  assert.ok(fs.existsSync(otherConfigPath), `the non-DeepSeek slot config landed at ${otherConfigPath}`)
  const otherConfigBefore = fs.readFileSync(otherConfigPath, 'utf8')
  assert.ok(!otherConfigBefore.includes('@deepseek-ai/dsh-web'), 'a non-DeepSeek slot never mounts the web trio')
  assert.ok(!otherConfigBefore.includes('IDBOTS_DSH_DEEPSEEK_WEBSEARCH_KEY'), 'and never references the DeepSeek search key env')

  // The DeepSeek slot's very first config carries the block — rememberTurnInputs
  // sets the slot state before buildRuntimeConfig, so there is no second boot.
  await hub.prewarmTurnSlot({ sessionId: 'deepseek-boot', provider: deepSeekProvider, workspace: { cwd: sessionRoot } })
  const deepSeekConfigPath = path.join(sessionRoot, 'cordis.runtime.deepseek.json')
  assert.ok(fs.existsSync(deepSeekConfigPath), `the DeepSeek slot config landed at ${deepSeekConfigPath}`)
  const deepSeekConfig = fs.readFileSync(deepSeekConfigPath, 'utf8')
  assert.ok(
    deepSeekConfig.includes('@deepseek-ai/dsh-web-search-deepseek'),
    'the web-search provider entry is in the DeepSeek slot\'s very first boot config',
  )
  assert.ok(
    deepSeekConfig.includes('127.0.0.1:48843/anthropic/v1'),
    'the baseURL derived from the slot\'s own DeepSeek route rides the entry',
  )
  assert.ok(
    deepSeekConfig.includes('IDBOTS_DSH_DEEPSEEK_WEBSEARCH_KEY'),
    'the key is referenced by env NAME (the value rides the child env)',
  )

  // The DeepSeek boot must not have touched the other slot: same config text,
  // and a repeat prewarm is a reuse, not a successor boot.
  assert.equal(fs.readFileSync(otherConfigPath, 'utf8'), otherConfigBefore, 'the non-DeepSeek slot config did not change')
  await hub.prewarmTurnSlot({ sessionId: 'other-again', provider: otherProvider, workspace: { cwd: sessionRoot } })
  assert.ok(
    logs.some((l) => l.message === 'dshTurnHub.prewarmTurnSlot.reuse' && l.detail.runtime === 'mockgw'),
    'the non-DeepSeek slot was reused — no flap-driven successor boot',
  )
  assert.equal(hub.runtimeSlotCount, 2, 'exactly the two slots exist')
})
