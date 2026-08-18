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
const runtimeDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dsh-runtime')
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

  await runner.dshTurnHub?.close().catch(() => undefined)
  server.close()
  fs.rmSync(userData, { recursive: true, force: true })
})
