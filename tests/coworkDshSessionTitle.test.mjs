// Session-title host-mirror E2E: a local cowork session starts with the
// renderer's placeholder title (first line of the first user message, 50
// chars). The host-side summary refinement (coworkRunner's
// scheduleHostSessionTitleRefinement — the host-owned replacement for the
// stock dsh-session-title-first-prompt-llm provider, which can never refine
// IDBots prompts because the context-wrapped first kernel message exceeds its
// input cap) must write the summary into the store AND emit it as a runner
// 'sessionTitle' event — the two channels the sidebar reads. Also guards the
// ordering rule: once the summary has landed, a late kernel deterministic
// fallback must never regress the title.
//
// Requires: pnpm run compile:electron + dsh-runtime/node_modules installed.

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = Module.createRequire(import.meta.url)
const runtimeDir = path.resolve(import.meta.dirname, '..', 'dsh-runtime')
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

const HOST_SUMMARY_TITLE = 'Host Summary Title'

function loadModules() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-title-${name}`),
        },
        session: { defaultSession: { resolveProxy: async () => 'DIRECT' } },
      }
    }
    return originalLoad.apply(this, arguments)
  }
  try {
    const modules = {
      runner: require('../dist-electron/main/libs/coworkRunner.js'),
      claudeSettings: require('../dist-electron/main/libs/claudeSettings.js'),
    }
    // Stub the system-brain one-shot summarizer: the host refinement path is
    // what is under test, not the upstream model call. coworkRunner calls it
    // as a property on the coworkUtil exports object, so patching the cached
    // exports after load takes effect at call time.
    const coworkUtilPath = require.resolve('../dist-electron/main/libs/coworkUtil.js')
    require.cache[coworkUtilPath].exports.generateSessionTitle = async () => HOST_SUMMARY_TITLE
    return modules
  } finally {
    Module._load = originalLoad
  }
}

class RecordingStore {
  constructor() {
    this.messages = []
    this.sessions = new Map()
    this.configValue = {}
  }
  getSession(id) { return this.sessions.get(id) ?? null }
  getSessionWithoutMessages(id) { return this.sessions.get(id) ?? null }
  getConfig() { return this.configValue }
  updateSession(id, updates) {
    const existing = this.sessions.get(id) ?? { id, messages: this.messages }
    this.sessions.set(id, { ...existing, ...updates })
  }
  addMessage(sessionId, message) {
    const stored = { id: `m-${this.messages.length + 1}`, timestamp: Date.now(), ...message }
    this.messages.push({ sessionId, ...stored })
    return stored
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
  getMessageById(sessionId, messageId) {
    return this.messages.find((m) => m.sessionId === sessionId && m.id === messageId) ?? null
  }
  updateMessage(sessionId, messageId, updates) {
    const entry = this.messages.find((m) => m.sessionId === sessionId && m.id === messageId)
    if (!entry) return
    if (updates.content !== undefined) entry.content = updates.content
    if (updates.metadata !== undefined) entry.metadata = { ...(entry.metadata ?? {}), ...updates.metadata }
  }
  getSessionUsageStats() { return null }
  listCapabilityDrafts() { return [] }
}

test('host summary refinement replaces the placeholder title in store + sidebar event', { skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed' }, async () => {
  const { runner: runnerModule, claudeSettings } = loadModules()
  const { CoworkRunner } = runnerModule
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server } = await startMockServer(48792)

  const fakeStore = {
    get: (key) => {
      if (key !== 'app_config') return undefined
      return {
        api: { key: 'sk-test', baseUrl: 'http://127.0.0.1:48792/v1' },
        model: { availableModels: [{ id: 'mock-1', name: 'mock-1' }], defaultModel: 'mock-1', defaultProvider: 'mockgw' },
        providers: {
          mockgw: {
            enabled: true,
            apiKey: 'sk-title-test',
            baseUrl: 'http://127.0.0.1:48792/v1',
            apiFormat: 'openai',
            models: [{ id: 'mock-1', name: 'mock-1', contextWindow: 32768 }],
          },
        },
        dshKernelEnabled: true,
      }
    },
  }
  claudeSettings.setStoreGetter(() => fakeStore)

  const store = new RecordingStore()
  const runner = new CoworkRunner(store, { localTurnStallTimeoutMs: 0 })
  const prompt = 'refactor the cowork sidebar title pipeline'
  // The exact placeholder contract shared by CoworkView (start-time title) and
  // the runner's opt-in guard: first line of the first user message, 50 chars.
  const placeholder = prompt.split('\n')[0].slice(0, 50)
  const sessionId = `dsh-title-${process.pid}-${Date.now().toString(36)}`
  // Mirror the product start path (main.ts cowork:session:start): the record
  // carries the placeholder title and the first user message BEFORE the turn.
  store.updateSession(sessionId, { title: placeholder, sessionType: 'standard', status: 'running' })
  store.addMessage(sessionId, { type: 'user', content: prompt })
  const activeSession = {
    sessionId,
    claudeSessionId: null,
    workspaceRoot: process.cwd(),
    confirmationMode: 'modal',
    pendingPermission: null,
    abortController: new AbortController(),
    executionMode: 'local',
    localTurnState: 'none',
  }
  runner.activeSessions.set(sessionId, activeSession)

  const titleEvents = []
  runner.on('sessionTitle', (sid, title) => { if (sid === sessionId) titleEvents.push(title) })
  runner.on('error', () => undefined)
  const handleErrorOrig = runner.handleError.bind(runner)
  let failure = null
  runner.handleError = (sid, message) => { failure = message; handleErrorOrig(sid, message) }

  try {
    const turn = runner.runDshSessionLocal(activeSession, prompt, process.cwd(), 'You are Alice, an on-chain assistant.')
    await turn
    assert.ok(!failure, `turn should not fail: ${failure}`)

    // The stubbed host refinement resolves immediately, so the summary races
    // the kernel's deterministic fallback (which differs from the placeholder
    // here: 5 words / 40 bytes vs the 50-char first line). Whichever lands
    // first, the sidebar must end on the summary: a summary already in the
    // store detaches late fallbacks, a fallback first is overwritten by the
    // summary.
    const summary = await waitFor(
      () => titleEvents.find((title) => title === HOST_SUMMARY_TITLE),
      25000,
      'host summary title event',
    )
    assert.notEqual(summary, placeholder, 'summary title replaced the truncation placeholder')

    // Let any in-flight kernel fallback settle, then assert the final state.
    await sleep(500)
    assert.equal(
      store.getSession(sessionId)?.title,
      HOST_SUMMARY_TITLE,
      'store title ends on the host summary — a late kernel fallback must not regress it',
    )
    const summaryIndex = titleEvents.indexOf(HOST_SUMMARY_TITLE)
    assert.ok(
      !titleEvents.slice(summaryIndex + 1).some((title) => title !== HOST_SUMMARY_TITLE),
      `no title event after the summary may change it: ${JSON.stringify(titleEvents)}`,
    )
  } finally {
    await runner.dshTurnHub?.close().catch(() => undefined)
    server.close()
  }
})

test('runtime config no longer mounts the kernel first-prompt provider (host-owned refinement)', () => {
  const configSource = fs.readFileSync(path.join(runtimeDir, 'lib', 'generate-runtime-config.mjs'), 'utf8')
  assert.ok(
    !configSource.includes('dsh-session-title-first-prompt-llm'),
    'generate-runtime-config.mjs must not compose dsh-session-title-first-prompt-llm by default',
  )
  assert.ok(
    configSource.includes('dsh-session-title'),
    'the fallback title service stays mounted for the instant deterministic title',
  )
  const runnerSource = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'main', 'libs', 'coworkRunner.ts'), 'utf8')
  assert.ok(
    runnerSource.includes('scheduleHostSessionTitleRefinement'),
    'coworkRunner owns the host-side summary refinement',
  )
})
