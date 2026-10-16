// Cerebellum turn-enhancement races (first-sentence latency, 2026-10-16
// second round — borrowing the deepseek-desktop architecture: the only
// network on the first-turn critical path is the model call itself).
//
// Sessions bd646510/c3419940 showed the per-turn cerebellum bundle and the
// effort selector hard-awaiting 15.4s on a slow relay (their own abort
// budgets fired late under process starvation), buying nothing — both
// degraded. The runner now races both enhancements against small budgets
// (bundle 600ms, effort 400ms) and proceeds with the pre-cerebellum
// fallbacks (lexical ranking, no shortlists, inject every volatile block,
// default effort chain) the moment a budget lapses. The background calls
// still settle on their own; only the WAITING stops.
//
// Also covered: the signal-bounded fetch's body read rides the same abort
// race (a headers-fast/body-stalled response used to slip the budget), and
// the event-loop lag monitor brackets future process stalls in cowork.log.
//
// Requires: npm run compile:electron

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = Module.createRequire(import.meta.url)

// coworkLog writes <userData>/logs/cowork.log; the electron mock below maps
// userData here, so the race/monitor lines can be asserted on the real file.
const coworkLogPath = () =>
  path.join(process.cwd(), '.cowork-temp', 'dsh-turnrace-userData', 'logs', 'cowork.log')

function loadModules() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-turnrace-${name}`),
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
      jevRelay: require('../dist-electron/main/services/jevRelayService.js'),
      lagMonitor: require('../dist-electron/main/libs/eventLoopLagMonitor.js'),
    }
  } finally {
    Module._load = originalLoad
  }
}

const loaded = loadModules()

class RecordingStore {
  constructor() {
    this.messages = []
    this.sessions = new Map()
  }
  getSession(id) { return this.sessions.get(id) ?? null }
  getSessionWithoutMessages(id) { return this.getSession(id) }
  getConfig() { return {} }
  getMetabotIdForSession() { return null }
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
      resolveMetabotIdForMemory: () => null,
      applyTurnMemoryUpdates: async () => ({}),
      listUserMemories: noMemories,
      listDailySummaries: noMemories,
      searchDailySummaries: noMemories,
    }
  }
  getSessionUsageStats() { return null }
}

function installApiConfig(claudeSettings) {
  const fakeConfigStore = {
    get: (key) => {
      if (key !== 'app_config') return undefined
      return {
        api: { key: 'sk-a', baseUrl: 'http://primary.example/v1' },
        model: {
          availableModels: [{ id: 'mock-a1', name: 'mock-a1' }],
          defaultModel: 'mock-a1',
          defaultProvider: 'gw-a',
        },
        providers: {
          'gw-a': {
            enabled: true,
            apiKey: 'sk-a',
            baseUrl: 'http://primary.example/v1',
            apiFormat: 'openai',
            models: [{ id: 'mock-a1', name: 'mock-a1', contextWindow: 32768, maxOutputTokens: 4096 }],
          },
        },
        dshKernelEnabled: true,
      }
    },
  }
  claudeSettings.setStoreGetter(() => fakeConfigStore)
}

const readCoworkLog = () => {
  try {
    return fs.readFileSync(coworkLogPath(), 'utf8')
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Volatile build: the turn-decision bundle race.
// ---------------------------------------------------------------------------

function makeVolatileRunner({ decisionsImpl }) {
  const { CoworkRunner } = loaded.runner
  const store = new RecordingStore()
  const runner = new CoworkRunner(store, {
    cerebellumTurnDecisions: decisionsImpl,
    coworkSkillPromptsProvider: () => ({ catalog: 'CATALOG_BLOCK_X1' }),
  })
  const sessionId = 'race-sess-1'
  store.sessions.set(sessionId, { id: sessionId, executionMode: 'local', metabotId: null, messages: [] })
  runner.activeSessions.set(sessionId, { sessionId, skillsCatalogMode: 'volatile', claudeSessionId: null })
  return { runner, sessionId }
}

test('bundle race: a hung bundle lapses inside the budget and the volatile prompt rides the fallbacks', async () => {
  const { runner, sessionId } = makeVolatileRunner({
    decisionsImpl: async () => {
      // Never settles — the slow-relay case that held the first sentence.
      await new Promise(() => undefined)
      return null
    },
  })
  const startedAt = Date.now()
  const prompt = await runner.buildVolatileContextPrompt(
    sessionId,
    'hello race',
    false,
    { includeMemoryPromptBlocks: false },
    true,
  )
  const elapsedMs = Date.now() - startedAt
  assert.ok(prompt.includes('CATALOG_BLOCK_X1'), 'the skill catalog still rides')
  assert.ok(!prompt.includes('Skill One'), 'no shortlist without a verdict')
  assert.ok(elapsedMs >= 600, `the race waits out its budget (${elapsedMs}ms)`)
  assert.ok(elapsedMs < 600 + 1500, `the lapsed race frees the turn inside the budget, took ${elapsedMs}ms`)
  assert.ok(
    readCoworkLog().includes('cerebellum:turnRace'),
    'the lapsed race lands in cowork.log for triage',
  )
})

test('bundle race: a fast verdict still shapes the prompt (shortlist rides)', async () => {
  const { runner, sessionId } = makeVolatileRunner({
    decisionsImpl: async () => ({
      memoryScores: null,
      knowledgeScores: null,
      skillRanking: [{ id: 'sk-1', name: 'Skill One', description: 'demo', probability: 0.9 }],
      serviceRanking: null,
      gateVerdicts: null,
    }),
  })
  const startedAt = Date.now()
  const prompt = await runner.buildVolatileContextPrompt(
    sessionId,
    'hello fast bundle',
    false,
    { includeMemoryPromptBlocks: false },
    true,
  )
  const elapsedMs = Date.now() - startedAt
  assert.ok(prompt.includes('Skill One'), 'the shortlist block rides when the verdict lands in time')
  assert.ok(elapsedMs < 600, `a fast verdict costs no race budget, took ${elapsedMs}ms`)
})

// ---------------------------------------------------------------------------
// Full turn: the effort selector race.
// ---------------------------------------------------------------------------

test('effort race: a hung selector lapses inside its budget and the turn dispatches on the default chain', async () => {
  const { CoworkRunner } = loaded.runner
  installApiConfig(loaded.claudeSettings)

  const store = new RecordingStore()
  const runner = new CoworkRunner(store, {
    cerebellumEffortSelector: async () => {
      await new Promise(() => undefined)
      return null
    },
  })
  const runTurnCalls = []
  runner.dshTurnHub = {
    runTurn: async (input) => {
      runTurnCalls.push(input)
      return { kind: 'final', text: 'done' }
    },
    cancel: async () => undefined,
    cancelAgent: async () => undefined,
    forceSettle: () => undefined,
    usageProjection: async () => null,
    compact: async () => ({ ok: true, compacted: false }),
  }

  const sessionId = 'race-effort-sess'
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
  store.sessions.set(sessionId, { id: sessionId, executionMode: 'local', metabotId: null, messages: [] })
  runner.on('error', () => undefined)
  runner.on('permissionRequest', () => undefined)
  const completed = new Promise((resolve) => runner.once('complete', resolve))

  const startedAt = Date.now()
  await runner.runDshSessionLocal(activeSession, 'what is the date tomorrow', process.cwd(), 'You are Alice.')
  const elapsedMs = Date.now() - startedAt
  await completed

  assert.equal(runTurnCalls.length, 1, 'the model turn dispatched without the verdict')
  assert.ok(elapsedMs < 400 + 2500, `the hung selector freed the turn inside its race budget, took ${elapsedMs}ms`)
  assert.ok(
    readCoworkLog().includes('effort:selectRace'),
    'the lapsed effort race lands in cowork.log for triage',
  )
})

// ---------------------------------------------------------------------------
// Signal-bounded fetch: the body read rides the same abort race.
// ---------------------------------------------------------------------------

test('signal-bounded fetch: a body-stalled read rejects at the abort edge', async () => {
  const { createSignalBoundedFetch } = loaded.jevRelay
  const controller = new AbortController()
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    // Headers arrive; the body NEVER resolves (the stall shape that used to
    // slip past every budget).
    json: () => new Promise(() => undefined),
  })
  const bounded = createSignalBoundedFetch(fetchImpl)
  const response = await bounded('http://relay.example/v1/systemone', { signal: controller.signal })
  const bodyRead = response.json()
  const startedAt = Date.now()
  setTimeout(() => controller.abort(), 60)
  await assert.rejects(bodyRead, (error) => error?.name === 'AbortError')
  assert.ok(Date.now() - startedAt < 60 + 1000, 'the body read gives up at the abort edge, not upstream recovery')
})

test('signal-bounded fetch: an undisturbed call still resolves headers and body', async () => {
  const { createSignalBoundedFetch } = loaded.jevRelay
  const controller = new AbortController()
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ answers: {} }),
  })
  const bounded = createSignalBoundedFetch(fetchImpl)
  const response = await bounded('http://relay.example/v1/systemone', { signal: controller.signal })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { answers: {} })
})

// ---------------------------------------------------------------------------
// Event-loop lag monitor: a blocked loop lands a bracketed WARN in the log.
// ---------------------------------------------------------------------------

test('event-loop lag monitor: a synchronous stall is logged with its drift', { timeout: 20000 }, async () => {
  const { startEventLoopLagMonitor } = loaded.lagMonitor
  startEventLoopLagMonitor()
  // Block the loop past the 2s WARN threshold; the 1s drift timer then fires
  // ~2.2s late and logs the stall. (This also stalls the test's own awaits —
  // that IS the tested mechanism.)
  const blockUntil = Date.now() + 3300
  while (Date.now() < blockUntil) {
    // synchronous spin
  }
  await new Promise((resolve) => setTimeout(resolve, 100))
  const log = readCoworkLog()
  assert.ok(log.includes('eventloop:lag'), 'the stall window is bracketed in cowork.log')
})
