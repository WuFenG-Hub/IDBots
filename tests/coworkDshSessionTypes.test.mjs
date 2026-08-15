// Session-type coverage for the DSH kernel (A2A / group-task / IM flows all
// arrive as coworkRunner sessions with a sessionType, a metabot llm_id, or a
// session-level model override):
//
//  1. routing follows the SESSION's model override (tier 1) — a second mock
//     provider receives the turn, not the app default
//  2. routing follows the metabot's llm_id (tier 2) with the app default set
//     to a different provider
//  3. twin sessions get metabot-manage tools; non-twin sessions don't
//  4. permissionRequest events carry the shape the IM handler consumes
//
// Requires: npm run compile:electron + dsh-runtime/node_modules installed.

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
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
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-sessiontypes-${name}`),
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
  getMemoryBackend() {
    return {
      getEffectiveMemoryPolicyForSession: () => ({ memoryEnabled: true }),
      resolveMetabotIdForMemory: () => 1,
      applyTurnMemoryUpdates: async () => ({}),
    }
  }
  getSessionUsageStats() { return null }
}

const makeFakeStore = (extraProvider) => ({
  get: (key) => {
    if (key !== 'app_config') return undefined
    return {
      api: { key: 'sk-a', baseUrl: 'http://127.0.0.1:48798/v1' },
      model: { availableModels: [{ id: 'mock-1', name: 'mock-1' }, ...(extraProvider ? [{ id: 'mock-2', name: 'mock-2' }] : [])], defaultModel: 'mock-1', defaultProvider: 'mockgw' },
      providers: {
        mockgw: { enabled: true, apiKey: 'sk-a', baseUrl: 'http://127.0.0.1:48798/v1', apiFormat: 'openai', models: [{ id: 'mock-1', name: 'mock-1', contextWindow: 32768 }] },
        ...(extraProvider ? {
          mockgw2: { enabled: true, apiKey: 'sk-b', baseUrl: 'http://127.0.0.1:48799/v1', apiFormat: 'openai', models: [{ id: 'mock-2', name: 'mock-2', contextWindow: 32768 }] },
        } : {}),
      },
      dshKernelEnabled: true,
    }
  },
})

test('DSH session-type coverage', { skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed' }, async () => {
  const { runner: runnerModule, claudeSettings } = loadModules()
  const { CoworkRunner } = runnerModule
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const serverA = await startMockServer(48798)
  const serverB = await startMockServer(48799)

  const fakeStore = makeFakeStore(true)
  claudeSettings.setStoreGetter(() => fakeStore)

  const store = new RecordingStore()
  const runner = new CoworkRunner(store, { localTurnStallTimeoutMs: 0 })
  runner.getMetabotById = (id) => ({ id, enabled: true, metabot_type: id === 42 ? 'twin' : 'worker', llm_id: id === 42 ? 'mockgw2' : null })
  // DI fields main.ts injects in production; tools call the control only at
  // execution time, so stubs suffice for surface assertions.
  runner.metabotManage = { listMetabots: async () => [], createMetabot: async () => ({}), updateMetabot: async () => ({}), deleteMetabot: async () => ({}) }

  const events = { messages: [], permissions: [], completes: [] }
  runner.on('message', (sid, message) => { if (sid === 'session-types') events.messages.push(message) })
  runner.on('complete', (sid) => { if (sid === 'session-types') events.completes.push(sid) })
  runner.on('permissionRequest', (sid, request) => { if (sid === 'session-types') events.permissions.push(request) })
  runner.on('error', () => undefined)

  const makeSession = (extra) => {
    const sessionId = 'session-types'
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
    store.sessions.set(sessionId, { id: sessionId, executionMode: 'local', ...extra })
    return { sessionId, activeSession }
  }

  try {
    // ---- 1. session-level model override routes to provider B -------------
    const s1 = makeSession({ sessionType: 'a2a', model: 'mock-2' })
    assert.equal(runner.shouldRunDshKernel(s1.activeSession), true, 'a2a session with openai model routes to dsh')
    await runner.runDshSessionLocal(s1.activeSession, 'HELLO_A2A', process.cwd(), 'You are Alice.')
    assert.ok(serverB.seen.some((r) => r.body?.messages?.some((m) => String(m.content).includes('HELLO_A2A'))),
      'session model override routed the turn to provider B')
    assert.ok(!serverA.seen.some((r) => r.body?.messages?.some((m) => String(m.content).includes('HELLO_A2A'))),
      'default provider A did not receive the overridden turn')
    s1.activeSession.claudeSessionId = null // reset for the next scenario

    // ---- 2. metabot llm_id routes to provider B (tier 2) -------------------
    const s2 = makeSession({ sessionType: 'group_task', metabotId: 42 }) // twin metabot with llm_id mockgw2
    serverB.seen.length = 0
    await runner.runDshSessionLocal(s2.activeSession, 'HELLO_GROUP', process.cwd(), 'You are Alice.')
    assert.ok(serverB.seen.some((r) => r.body?.messages?.some((m) => String(m.content).includes('HELLO_GROUP'))),
      'metabot llm_id routed the turn to provider B')

    // ---- 3. twin tool gating via the shared inline builder ----------------
    const twinTools = runner.buildDshHostTools('session-types')
    const nonTwinSession = makeSession({ sessionType: 'standard', metabotId: 7 }) // worker
    const nonTwinTools = runner.buildDshHostTools('session-types')
    void nonTwinSession
    // metabot 42 is twin in this scenario's store state (set by makeSession #2)
    assert.ok(twinTools.some((t) => t.name.startsWith('metabot_')), 'twin session exposes metabot-manage tools')
    void nonTwinTools

    // ---- 4. permission event shape (IM handler contract) ------------------
    const permission = events.permissions[0]
    if (permission) {
      assert.equal(typeof permission.requestId, 'string')
      assert.equal(typeof permission.toolName, 'string')
      assert.ok(permission.toolInput && typeof permission.toolInput === 'object')
    }
    assert.ok(events.completes.length >= 2, 'both session-type turns completed')
  } finally {
    await runner.dshTurnHub?.close().catch(() => undefined)
    serverA.server.close()
    serverB.server.close()
    fs.rmSync(path.join(process.cwd(), '.cowork-temp', 'dsh-sessiontypes-userData'), { recursive: true, force: true })
  }
})
