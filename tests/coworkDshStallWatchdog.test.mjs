// DSH turn stall watchdog: a turn whose provider stream wedges (SSE opens,
// one delta, never finishes) is cancelled after the stall deadline, settles
// with a localized diagnostic system message, and returns the session to
// idle — never a hollow `completed`.
//
// Requires: npm run compile:electron + dsh-runtime/node_modules installed.

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = Module.createRequire(import.meta.url)
const runtimeDir = path.resolve(import.meta.dirname, '..', 'dsh-runtime')
const runtimeReady = fs.existsSync(path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-sdk-client'))

function loadModules() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-stallwatch-${name}`),
        },
        session: { defaultSession: { resolveProxy: async () => 'DIRECT' } },
      }
    }
    return originalLoad.apply(this, arguments)
  }
  try {
    return {
      runner: require('../dist-electron/main/libs/coworkRunner.js'),
      claudeSettings: require('../dist-electron/main/libs/claudeSettings.js'),
    }
  } finally {
    Module._load = originalLoad
  }
}

class RecordingStore {
  constructor() {
    this.messages = []
    this.sessions = new Map()
  }
  getSession(id) { return this.sessions.get(id) ?? null }
  // Runner reads the session goal through this lighter accessor every DSH turn.
  getSessionWithoutMessages(id) { return this.sessions.get(id) ?? null }
  getConfig() { return {} }
  updateSession(id, updates) {
    const existing = this.sessions.get(id) ?? { id }
    this.sessions.set(id, { ...existing, ...updates })
  }
  addMessage(sessionId, message) {
    const stored = { id: `m-${this.messages.length + 1}`, timestamp: Date.now(), ...message }
    this.messages.push({ sessionId, ...stored })
    return stored
  }
  updateMessage(sessionId, messageId, updates) {
    const entry = this.messages.find((m) => m.sessionId === sessionId && m.id === messageId)
    if (!entry) return
    if (updates.content !== undefined) entry.content = updates.content
    if (updates.metadata !== undefined) entry.metadata = { ...(entry.metadata ?? {}), ...updates.metadata }
  }
  getConversationSourceContextBySession() {
    return { hasSourceContext: false }
  }
  getMemoryBackend() {
    const noMemories = () => []
    return {
      getEffectiveMemoryPolicyForSession: () => ({ memoryEnabled: false }),
      resolveMetabotIdForMemory: () => 1,
      applyTurnMemoryUpdates: async () => ({}),
      listUserMemories: noMemories,
      listDailySummaries: noMemories,
      searchDailySummaries: noMemories,
    }
  }
  getSessionUsageStats() { return null }
}

test('DSH turn stall watchdog cancels a wedged turn', { skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed' }, async () => {
  const { runner: runnerModule, claudeSettings } = loadModules()
  const { CoworkRunner } = runnerModule
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server } = await startMockServer(48797)

  const userData = path.join(process.cwd(), '.cowork-temp', 'dsh-stallwatch-userData')
  fs.rmSync(userData, { recursive: true, force: true })

  const fakeStore = {
    get: (key) => {
      if (key !== 'app_config') return undefined
      return {
        api: { key: 'sk-a', baseUrl: 'http://127.0.0.1:48797/v1' },
        model: { availableModels: [{ id: 'mock-1', name: 'mock-1' }], defaultModel: 'mock-1', defaultProvider: 'mockgw' },
        providers: {
          mockgw: { enabled: true, apiKey: 'sk-a', baseUrl: 'http://127.0.0.1:48797/v1', apiFormat: 'openai', models: [{ id: 'mock-1', name: 'mock-1', contextWindow: 32768 }] },
        },
        dshKernelEnabled: true,
      }
    },
  }
  claudeSettings.setStoreGetter(() => fakeStore)

  const store = new RecordingStore()
  const runner = new CoworkRunner(store, { dshTurnStallTimeoutMs: 1500 })

  const sessionId = 'stall-watch'
  const activeSession = {
    sessionId,
    claudeSessionId: null,
    workspaceRoot: process.cwd(),
    confirmationMode: 'modal',
    pendingPermission: null,
    abortController: new AbortController(),
    executionMode: 'local',
    localTurnState: 'none',
    permissionMode: 'default',
    readFiles: new Map(),
  }
  runner.activeSessions.set(sessionId, activeSession)
  store.sessions.set(sessionId, { id: sessionId, executionMode: 'local', messages: [] })
  runner.on('error', () => undefined)
  runner.on('permissionRequest', () => undefined)

  const completed = new Promise((resolve) => runner.once('complete', resolve))
  await runner.runDshSessionLocal(activeSession, 'HANG_TEST please', process.cwd(), 'You are Alice.')

  // The turn promise itself must settle (not hang forever)...
  assert.ok(true, 'runDshSessionLocal settled after the watchdog fired')
  await completed
  assert.equal(store.sessions.get(sessionId)?.status, 'idle', 'wedged turn settles the session as idle, not completed')
  const diagnostic = store.messages.find((m) => m.sessionId === sessionId && m.metadata?.dshTurnStalled === true)
  assert.ok(diagnostic, 'stall diagnostic system message recorded (metadata flag for the i18n renderer)')
  assert.equal(runner.dshStallStrikesBySessionId.get(sessionId), 1, 'the watchdog cancellation recorded a strike')

  await runner.dshTurnHub?.close().catch(() => undefined)
  server.close()
  fs.rmSync(userData, { recursive: true, force: true })
})

// Group Task #26 regression: a long foreground bash command (render, first
// run downloads headless Chrome) emits no LLM-side events while executing —
// the watchdog must treat the in-flight tool call as progress instead of
// cancelling the turn at the deadline. The watchdog here (1.5s) is far
// shorter than the command (5s), so the old code cancelled mid-tool.
test('DSH turn survives a long-running foreground tool call past the stall deadline', { skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed' }, async () => {
  const { runner: runnerModule, claudeSettings } = loadModules()
  const { CoworkRunner } = runnerModule
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server } = await startMockServer(48798)

  const userData = path.join(process.cwd(), '.cowork-temp', 'dsh-stallwatch-long-userData')
  fs.rmSync(userData, { recursive: true, force: true })

  const fakeStore = {
    get: (key) => {
      if (key !== 'app_config') return undefined
      return {
        api: { key: 'sk-a', baseUrl: 'http://127.0.0.1:48798/v1' },
        model: { availableModels: [{ id: 'mock-1', name: 'mock-1' }], defaultModel: 'mock-1', defaultProvider: 'mockgw' },
        providers: {
          mockgw: { enabled: true, apiKey: 'sk-a', baseUrl: 'http://127.0.0.1:48798/v1', apiFormat: 'openai', models: [{ id: 'mock-1', name: 'mock-1', contextWindow: 32768 }] },
        },
        dshKernelEnabled: true,
      }
    },
  }
  claudeSettings.setStoreGetter(() => fakeStore)

  const store = new RecordingStore()
  const runner = new CoworkRunner(store, { dshTurnStallTimeoutMs: 1500 })

  const sessionId = 'stall-watch-long-tool'
  const activeSession = {
    sessionId,
    claudeSessionId: null,
    workspaceRoot: process.cwd(),
    confirmationMode: 'modal',
    pendingPermission: null,
    abortController: new AbortController(),
    executionMode: 'local',
    localTurnState: 'none',
    permissionMode: 'default',
    readFiles: new Map(),
  }
  runner.activeSessions.set(sessionId, activeSession)
  store.sessions.set(sessionId, { id: sessionId, executionMode: 'local', messages: [] })
  runner.on('error', () => undefined)
  runner.on('permissionRequest', () => undefined)

  const startedAt = Date.now()
  const completed = new Promise((resolve) => runner.once('complete', resolve))
  await runner.runDshSessionLocal(activeSession, 'RUN_LONG_BASH please', process.cwd(), 'You are Alice.')
  await completed

  const toolUse = store.messages.find((m) => m.sessionId === sessionId && m.metadata?.toolName === 'bash')
  assert.ok(toolUse, 'bash tool call was issued')
  const toolResult = store.messages.find(
    (m) => m.sessionId === sessionId && m.type === 'tool_result' && m.metadata?.toolUseId === toolUse.metadata.toolUseId,
  )
  assert.ok(toolResult, 'bash tool result settled')
  assert.match(String(toolResult.content ?? toolResult.metadata?.toolResult ?? ''), /LONG_BASH_DONE/, 'the long command ran to completion')
  assert.ok(Date.now() - startedAt >= 4800, 'the command genuinely took longer than the stall deadline')
  assert.equal(store.sessions.get(sessionId)?.status, 'completed', 'turn completes normally — the watchdog did not cancel it')
  const stalled = store.messages.find((m) => m.sessionId === sessionId && m.metadata?.dshTurnStalled === true)
  assert.equal(stalled, undefined, 'no stall diagnostic fired while the tool was in flight')
  // A normally completed turn clears the consecutive-stall ladder.
  assert.equal(runner.dshStallStrikesBySessionId.get(sessionId), undefined, 'healthy completion clears the stall-strike ladder')

  await runner.dshTurnHub?.close().catch(() => undefined)
  server.close()
  fs.rmSync(userData, { recursive: true, force: true })
})

// 2026-09-28 regression (session 2bcfbb63): a heavy-context turn legitimately
// shows ZERO host-side events while the provider prefills/queues the request
// (glm-5.3 at max effort on a ~900-message context: >10 min to first byte,
// three watchdog cancellations, every re-send killed at the same ceiling).
// The adaptive deadline must (a) record a strike on each cancellation so the
// re-send gets a wider window, and (b) widen the FIRST attempt by the live
// context size. Both extension tests run at scale 1/300 so production
// minutes collapse to test seconds while the base stays overridden-fast.
test('DSH stall watchdog records a strike and widens the next deadline', { skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed' }, async () => {
  const { runner: runnerModule, claudeSettings } = loadModules()
  const { CoworkRunner } = runnerModule
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server } = await startMockServer(48799)

  const userData = path.join(process.cwd(), '.cowork-temp', 'dsh-stallwatch-strike-userData')
  fs.rmSync(userData, { recursive: true, force: true })

  const fakeStore = {
    get: (key) => {
      if (key !== 'app_config') return undefined
      return {
        api: { key: 'sk-a', baseUrl: 'http://127.0.0.1:48799/v1' },
        model: { availableModels: [{ id: 'mock-1', name: 'mock-1' }], defaultModel: 'mock-1', defaultProvider: 'mockgw' },
        providers: {
          mockgw: { enabled: true, apiKey: 'sk-a', baseUrl: 'http://127.0.0.1:48799/v1', apiFormat: 'openai', models: [{ id: 'mock-1', name: 'mock-1', contextWindow: 32768 }] },
        },
        dshKernelEnabled: true,
      }
    },
  }
  claudeSettings.setStoreGetter(() => fakeStore)

  const store = new RecordingStore()
  const runner = new CoworkRunner(store, { dshTurnStallTimeoutMs: 1500, dshStallExtensionScale: 1 / 300 })

  const sessionId = 'stall-watch-strike'
  const activeSession = {
    sessionId,
    claudeSessionId: null,
    workspaceRoot: process.cwd(),
    confirmationMode: 'modal',
    pendingPermission: null,
    abortController: new AbortController(),
    executionMode: 'local',
    localTurnState: 'none',
    permissionMode: 'default',
    readFiles: new Map(),
  }
  runner.activeSessions.set(sessionId, activeSession)
  store.sessions.set(sessionId, { id: sessionId, executionMode: 'local', messages: [] })
  runner.on('error', () => undefined)
  runner.on('permissionRequest', () => undefined)

  // First attempt: no strikes yet → base deadline (1.5s) cancels the wedged
  // turn exactly as before, and the cancellation records strike 1.
  const completed = new Promise((resolve) => runner.once('complete', resolve))
  await runner.runDshSessionLocal(activeSession, 'HANG_TEST please', process.cwd(), 'You are Alice.')
  await completed
  assert.equal(store.messages.some((m) => m.sessionId === sessionId && m.metadata?.dshTurnStalled === true), true, 'first attempt cancelled at the base deadline')
  assert.equal(runner.dshStallStrikesBySessionId.get(sessionId), 1, 'the cancellation recorded a strike')

  // Second attempt: strike 1 adds 10 min × 1/300 = 2s → the SAME wedged
  // provider now survives past the 1.5s base deadline and is only cancelled
  // at the extended deadline (~3.5s). This is the "re-send must outlive the
  // ceiling that killed the first attempt" contract.
  const activeSession2 = {
    ...activeSession,
    pendingPermission: null,
    abortController: new AbortController(),
  }
  runner.activeSessions.set(sessionId, activeSession2)
  const startedAt = Date.now()
  const completed2 = new Promise((resolve) => runner.once('complete', resolve))
  await runner.runDshSessionLocal(activeSession2, 'HANG_TEST please', process.cwd(), 'You are Alice.')
  await completed2
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed >= 3000, `second attempt outlived the base deadline (elapsed ${elapsed}ms)`)
  assert.ok(elapsed < 15000, `extended deadline still bounded (elapsed ${elapsed}ms)`)
  assert.equal(runner.dshStallStrikesBySessionId.get(sessionId), 2, 'second cancellation escalated the strike ladder')

  await runner.dshTurnHub?.close().catch(() => undefined)
  server.close()
  fs.rmSync(userData, { recursive: true, force: true })
})

test('DSH stall deadline widens with live prompt context on the first attempt', { skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed' }, async () => {
  const { runner: runnerModule, claudeSettings } = loadModules()
  const { CoworkRunner } = runnerModule
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server } = await startMockServer(48796)

  const userData = path.join(process.cwd(), '.cowork-temp', 'dsh-stallwatch-ctx-userData')
  fs.rmSync(userData, { recursive: true, force: true })

  const fakeStore = {
    get: (key) => {
      if (key !== 'app_config') return undefined
      return {
        api: { key: 'sk-a', baseUrl: 'http://127.0.0.1:48796/v1' },
        model: { availableModels: [{ id: 'mock-1', name: 'mock-1' }], defaultModel: 'mock-1', defaultProvider: 'mockgw' },
        providers: {
          mockgw: { enabled: true, apiKey: 'sk-a', baseUrl: 'http://127.0.0.1:48796/v1', apiFormat: 'openai', models: [{ id: 'mock-1', name: 'mock-1', contextWindow: 32768 }] },
        },
        dshKernelEnabled: true,
      }
    },
  }
  claudeSettings.setStoreGetter(() => fakeStore)

  const store = new RecordingStore()
  const runner = new CoworkRunner(store, { dshTurnStallTimeoutMs: 1500, dshStallExtensionScale: 1 / 300 })

  const sessionId = 'stall-watch-ctx'
  // 72k live prompt tokens → 4 full 10k steps over the 32k base → 8 min of
  // extension at scale 1 → 1.6s at scale 1/300 → effective deadline 3.1s.
  const activeSession = {
    sessionId,
    claudeSessionId: null,
    workspaceRoot: process.cwd(),
    confirmationMode: 'modal',
    pendingPermission: null,
    abortController: new AbortController(),
    executionMode: 'local',
    localTurnState: 'none',
    permissionMode: 'default',
    readFiles: new Map(),
    realContextUsage: { usedTokens: 72_000, contextWindow: 128_000, usageRatio: 0.5625, isRealUsage: true },
  }
  runner.activeSessions.set(sessionId, activeSession)
  store.sessions.set(sessionId, { id: sessionId, executionMode: 'local', messages: [] })
  runner.on('error', () => undefined)
  runner.on('permissionRequest', () => undefined)

  const startedAt = Date.now()
  const completed = new Promise((resolve) => runner.once('complete', resolve))
  await runner.runDshSessionLocal(activeSession, 'HANG_TEST please', process.cwd(), 'You are Alice.')
  await completed
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed >= 3000, `heavy-context turn outlived the flat base deadline (elapsed ${elapsed}ms)`)
  assert.ok(elapsed < 15000, `context extension stays bounded (elapsed ${elapsed}ms)`)
  const diagnostic = store.messages.find((m) => m.sessionId === sessionId && m.metadata?.dshTurnStalled === true)
  assert.ok(diagnostic, 'the wedged turn still gets cancelled at the extended deadline')

  await runner.dshTurnHub?.close().catch(() => undefined)
  server.close()
  fs.rmSync(userData, { recursive: true, force: true })
})

// Pure deadline math: the adaptive ladder without any runtime.
test('computeDshStallDeadlineMs ladder, cap, and disable', { skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed' }, () => {
  const { computeDshStallDeadlineMs, DSH_TURN_STALL_TIMEOUT_MS } = loadModules().runner
  const MIN = 60_000
  // No extensions: flat base.
  assert.equal(computeDshStallDeadlineMs({ baseMs: DSH_TURN_STALL_TIMEOUT_MS }), 10 * MIN)
  // Context below the 32k base adds nothing; each full 10k step adds 2 min.
  assert.equal(computeDshStallDeadlineMs({ baseMs: 10 * MIN, contextTokens: 32_000 }), 10 * MIN)
  assert.equal(computeDshStallDeadlineMs({ baseMs: 10 * MIN, contextTokens: 41_999 }), 10 * MIN, 'partial steps do not count')
  assert.equal(computeDshStallDeadlineMs({ baseMs: 10 * MIN, contextTokens: 52_000 }), 14 * MIN)
  // Context extension caps at +20 min (132k tokens = 10 steps would be +20).
  assert.equal(computeDshStallDeadlineMs({ baseMs: 10 * MIN, contextTokens: 200_000 }), 30 * MIN)
  // Strikes stack with the context extension…
  assert.equal(computeDshStallDeadlineMs({ baseMs: 10 * MIN, strikes: 2, contextTokens: 52_000 }), 34 * MIN)
  // …and the whole deadline is clamped to the 60-min absolute cap.
  assert.equal(computeDshStallDeadlineMs({ baseMs: 10 * MIN, strikes: 9, contextTokens: 200_000 }), 60 * MIN)
  // An explicit base override larger than the cap wins (no clamping down).
  assert.equal(computeDshStallDeadlineMs({ baseMs: 90 * MIN, strikes: 5, contextTokens: 200_000 }), 90 * MIN)
  // baseMs <= 0 disables the watchdog entirely.
  assert.equal(computeDshStallDeadlineMs({ baseMs: 0, strikes: 3, contextTokens: 100_000 }), 0)
  // Scale 0 disables both extensions while keeping the base.
  assert.equal(computeDshStallDeadlineMs({ baseMs: 1500, strikes: 3, contextTokens: 100_000, scale: 0 }), 1500)
})

test('describeDshAbortReason renders object causes instead of [object Object]', { skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed' }, () => {
  const { describeDshAbortReason } = loadModules().runner
  assert.equal(describeDshAbortReason('user requested stop'), 'user requested stop')
  assert.equal(describeDshAbortReason({ kind: 'hook', reason: 'steer' }), '{"kind":"hook","reason":"steer"}')
  assert.equal(describeDshAbortReason(new Error('socket hang up')), 'socket hang up')
  assert.equal(describeDshAbortReason(undefined), 'cancelled')
  assert.equal(describeDshAbortReason(''), 'cancelled')
})
