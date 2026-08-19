// Regression test for the DSH host-tool registry being PER-SESSION
// (cross-session clobbering, 2026-08-19):
//
//  coworkRunner used to keep ONE dshHostToolRegistry field rebuilt at the
//  start of EVERY DSH turn of ANY session, while executeDshHostTool looked
//  tools up in that same global map. A worker turn starting between a Twin
//  turn's start and its tool dispatch replaced the registry with the worker
//  set, so Twin-only tools (metabot_list, local_workers_list, ...) failed
//  with `unknown host tool` — and in the reverse direction a worker session
//  transiently saw Twin-only tools (privilege leak).
//
//  This test reproduces that exact interleave against the real dispatcher:
//
//  1. a TWIN session starts a DSH turn and stays mid-turn (STEER_TEST →
//     slow_tool, 1.5s window)
//  2. a WORKER session runs a full turn to completion (rebuilds ITS registry
//     entry — under the old code this clobbered the shared map)
//  3. while the twin turn is still in flight, dispatch metabot_list for the
//     twin session → must succeed; dispatch it for the worker session → must
//     fail with `unknown host tool` (leak direction)
//  4. removeActiveSession prunes the session's registry entry
//
// Requires: npm run compile:electron + dsh-runtime/node_modules installed.

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = Module.createRequire(import.meta.url)
const runtimeDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dsh-runtime')
const runtimeReady = fs.existsSync(path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-sdk-client'))

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

function loadModules() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-hostreg-${name}`),
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
      getEffectiveMemoryPolicyForSession: () => ({ memoryEnabled: true }),
      resolveMetabotIdForMemory: () => 1,
      applyTurnMemoryUpdates: async () => ({}),
      listUserMemories: noMemories,
      listDailySummaries: noMemories,
      searchDailySummaries: noMemories,
    }
  }
  getSessionUsageStats() { return null }
}

const fakeStore = {
  get: (key) => {
    if (key !== 'app_config') return undefined
    return {
      api: { key: 'sk-a', baseUrl: 'http://127.0.0.1:48810/v1' },
      model: { availableModels: [{ id: 'mock-1', name: 'mock-1' }], defaultModel: 'mock-1', defaultProvider: 'mockgw' },
      providers: {
        mockgw: { enabled: true, apiKey: 'sk-a', baseUrl: 'http://127.0.0.1:48810/v1', apiFormat: 'openai', models: [{ id: 'mock-1', name: 'mock-1', contextWindow: 32768 }] },
      },
      dshKernelEnabled: true,
    }
  },
}

test('DSH host-tool registry is per-session (no cross-session clobbering)', { skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed' }, async () => {
  const { runner: runnerModule, claudeSettings } = loadModules()
  const { CoworkRunner } = runnerModule
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server } = await startMockServer(48810)

  // Clean BEFORE the run: a previously hung run never reaches its finally,
  // and resume-first would adopt its poisoned session log forever after.
  fs.rmSync(path.join(process.cwd(), '.cowork-temp', 'dsh-hostreg-userData'), { recursive: true, force: true })

  claudeSettings.setStoreGetter(() => fakeStore)

  const store = new RecordingStore()
  const runner = new CoworkRunner(store, { localTurnStallTimeoutMs: 0 })
  // Fixture tools (slow_tool) ride the runtime composition via the hub seam.
  runner.dshRuntimeExtraEntries = [
    { id: 'idbots-test-tools', name: path.join(runtimeDir, 'test', 'fixtures', 'test-tools.mjs') },
  ]
  runner.getMetabotById = (id) => ({ id, enabled: true, metabot_type: id === 42 ? 'twin' : 'worker', llm_id: null })
  // DI field main.ts injects in production; metabot_list executes it.
  // The control surface is synchronous: list() + listProviders().
  runner.metabotManage = {
    list: () => [{ id: 42, name: 'twin-stub', type: 'twin', enabled: true, allow_chat_skills: [] }],
    listProviders: () => [],
    create: async () => ({ success: true }),
    update: async () => ({ success: true }),
    remove: async () => ({ success: true }),
  }
  runner.on('error', () => undefined)

  const runTag = `${process.pid}-${Date.now().toString(36)}`
  const makeSession = (label, extra) => {
    const sessionId = `dsh-hostreg-${label}-${runTag}`
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
    }
    runner.activeSessions.set(sessionId, activeSession)
    store.sessions.set(sessionId, { id: sessionId, executionMode: 'local', messages: [], ...extra })
    return { sessionId, activeSession }
  }

  const twin = makeSession('twin', { sessionType: 'group_task', metabotId: 42 })
  const worker = makeSession('worker', { sessionType: 'standard', metabotId: 7 })

  try {
    // 1. Twin turn starts and stays mid-turn on slow_tool (1.5s window).
    const twinTurn = runner.runDshSessionLocal(twin.activeSession, 'STEER_TEST', process.cwd(), 'You are the Twin.')
    const slowToolSeen = (sid) => store.messages.some((m) => m.sessionId === sid && m.type === 'tool_use' && m.metadata?.toolName === 'slow_tool')
    await waitFor(() => slowToolSeen(twin.sessionId), 25000, 'twin turn slow_tool')

    // 2. A worker session starts ITS turn while the twin turn is in flight and
    //    also stays mid-turn on slow_tool. Its registry rebuild must not touch
    //    the twin's entry (under the old global map it clobbered it outright).
    const workerTurn = runner.runDshSessionLocal(worker.activeSession, 'STEER_TEST', process.cwd(), 'You are a worker.')
    await waitFor(() => slowToolSeen(worker.sessionId), 25000, 'worker turn slow_tool')

    // 3. Dispatch through the REAL dispatcher with BOTH turns mid-flight (this
    //    is what the hub does when the model calls a tool).
    const twinResult = await runner.executeDshHostTool(twin.sessionId, 'metabot_list', {})
    assert.equal(twinResult.ok, true, `twin session keeps metabot_list across a concurrent worker turn (got: ${twinResult.error ?? 'ok'})`)
    assert.ok(String(twinResult.text).includes('twin-stub'), 'metabot_list executed against the twin registry')

    // Leak direction: the worker session must NOT see twin-only tools, even
    //    while its own registry entry is live.
    const workerResult = await runner.executeDshHostTool(worker.sessionId, 'metabot_list', {})
    assert.equal(workerResult.ok, false, 'worker session must not see twin-only metabot_list')
    assert.match(workerResult.error, /unknown host tool: metabot_list/)

    // Structural check: both registries coexist, keyed by session id.
    assert.equal(runner.dshHostToolRegistry.get(twin.sessionId)?.has('metabot_list'), true, 'twin registry entry retains twin-only tools')
    assert.equal(runner.dshHostToolRegistry.get(worker.sessionId)?.has('metabot_list'), false, 'worker registry entry never had twin-only tools')

    await Promise.all([twinTurn, workerTurn])

    // 4. Turn teardown (removeActiveSession) prunes each session's entry.
    assert.equal(runner.dshHostToolRegistry.has(twin.sessionId), false, 'twin registry entry is pruned at turn teardown')
    assert.equal(runner.dshHostToolRegistry.has(worker.sessionId), false, 'worker registry entry is pruned at turn teardown')
  } finally {
    await runner.dshTurnHub?.close().catch(() => undefined)
    server.close()
    fs.rmSync(path.join(process.cwd(), '.cowork-temp', 'dsh-hostreg-userData'), { recursive: true, force: true })
  }
})
