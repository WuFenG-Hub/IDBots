// GT-02 provider-outage fallback for DSH session turns (2026-09 field
// incident): when the configured provider route (e.g. z.ai) is DOWN, every
// retry layer re-hit the same dead route until the turn failed — the runtime
// step-level ladder (~3min), then the host transient-resume budget (3x) — while
// the bot's configured fallback brain (fallback_llm_*) was never consulted for
// session turns. The runner now resolves that fallback brain and, when it maps
// to a DIFFERENT route, resumes the turn on it (the hub re-pins the live dsh
// session, JSONL history carries over).
//
// Host-side coverage only: the DSH turn hub is faked (no dsh-runtime spawn),
// so this file does NOT need dsh-runtime/node_modules.
//
// Requires: npm run compile:electron

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = Module.createRequire(import.meta.url)

// coworkLog writes <userData>/logs/cowork.log; the electron mock below maps
// userData here, so degradation events can be asserted on the real log file.
const coworkLogPath = () =>
  path.join(process.cwd(), '.cowork-temp', 'dsh-fallback-userData', 'logs', 'cowork.log')

function loadModules() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-fallback-${name}`),
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
      assistantReply: require('../dist-electron/main/libs/coworkAssistantReply.js'),
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
  getSessionWithoutMessages(id) { return this.getSession(id) }
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

// Two enabled providers: gw-a serves the primary brain (mock-a1), gw-b serves
// the fallback brain (mock-b1) with its own limits — the fallback turn must
// carry the FALLBACK model's maxOutputTokens, not the primary's.
function installApiConfig(claudeSettings, overrides = {}) {
  const fakeConfigStore = {
    get: (key) => {
      if (key !== 'app_config') return undefined
      return {
        api: { key: 'sk-a', baseUrl: 'http://primary.example/v1' },
        model: {
          availableModels: [{ id: 'mock-a1', name: 'mock-a1' }, { id: 'mock-b1', name: 'mock-b1' }],
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
          'gw-b': {
            enabled: true,
            apiKey: 'sk-b',
            baseUrl: 'http://fallback.example/v1',
            apiFormat: 'openai',
            models: [{ id: 'mock-b1', name: 'mock-b1', contextWindow: 64000, maxOutputTokens: 8192 }],
          },
          ...overrides.providers,
        },
        dshKernelEnabled: true,
      }
    },
  }
  claudeSettings.setStoreGetter(() => fakeConfigStore)
}

// Drive one runDshSessionLocal turn with a scripted fake hub. `script(input,
// callNo)` returns the DshTurnOutcome for each hub.runTurn call (callNo is
// 1-based). Returns the recorded calls plus the post-turn session row.
async function driveTurn({ sessionId, metabot, script, sessionRow = {}, configOverrides = {} }) {
  const { runner: runnerModule, claudeSettings, assistantReply } = loadModules()
  const { CoworkRunner } = runnerModule
  installApiConfig(claudeSettings, configOverrides)

  const store = new RecordingStore()
  const runner = new CoworkRunner(store, {
    getMetabotById: (id) => (metabot && id === metabot.id ? metabot : null),
  })

  const runTurnCalls = []
  runner.dshTurnHub = {
    runTurn: async (input) => {
      runTurnCalls.push(input)
      return script(input, runTurnCalls.length)
    },
    cancel: async () => undefined,
    cancelAgent: async () => undefined,
    forceSettle: () => undefined,
    usageProjection: async () => null,
    compact: async () => ({ ok: true, compacted: false }),
  }

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
  store.sessions.set(sessionId, { id: sessionId, executionMode: 'local', metabotId: metabot?.id ?? null, ...sessionRow, messages: [] })
  const errors = []
  runner.on('error', (sid, error) => errors.push({ sid, error }))
  runner.on('permissionRequest', () => undefined)
  const completed = new Promise((resolve) => runner.once('complete', resolve))

  await runner.runDshSessionLocal(activeSession, 'GT02_PROBE do the task', process.cwd(), 'You are Alice.')

  return {
    runner,
    store,
    runTurnCalls,
    errors,
    completed,
    sessionRow: store.sessions.get(sessionId),
    TRANSIENT_TURN_RESUME_PROMPT: assistantReply.TRANSIENT_TURN_RESUME_PROMPT,
  }
}

const BOT_WITH_FALLBACK = {
  id: 1,
  name: 'GT02 Bot',
  llm_id: 'mock-a1',
  llm_provider: 'gw-a',
  fallback_llm_id: 'mock-b1',
  fallback_llm_provider: 'gw-b',
}

const transientError = () => ({ kind: 'error', error: { code: 'SERVER', message: '503 upstream unavailable' } })

test('primary route exhausting transient resumes switches to the bot fallback brain route and completes', async () => {
  const result = await driveTurn({
    sessionId: 'gt02-fallback-success',
    metabot: BOT_WITH_FALLBACK,
    // Initial turn + 3 primary resumes all die transiently (provider outage);
    // the first FALLBACK attempt succeeds.
    script: (_input, callNo) => (callNo <= 4 ? transientError() : { kind: 'completed' }),
  })

  assert.equal(result.runTurnCalls.length, 5, '1 initial + 3 primary resumes + 1 fallback resume')
  const [initial, ...resumes] = result.runTurnCalls
  assert.match(initial.prompt, /GT02_PROBE/, 'the first attempt carries the user prompt')
  for (const call of resumes) {
    assert.equal(call.prompt, result.TRANSIENT_TURN_RESUME_PROMPT, 'resume attempts reuse the shared resume cue')
  }
  for (const call of result.runTurnCalls.slice(0, 4)) {
    assert.equal(call.provider.key, 'gw-a', 'initial + primary resumes stay on the primary route')
    assert.equal(call.provider.model, 'mock-a1')
  }
  const fallbackCall = result.runTurnCalls[4]
  assert.equal(fallbackCall.provider.key, 'gw-b', 'the exhausted turn switches to the fallback provider route')
  assert.equal(fallbackCall.provider.model, 'mock-b1')
  assert.equal(fallbackCall.provider.baseUrl, 'http://fallback.example/v1')
  assert.equal(fallbackCall.provider.apiKey, 'sk-b')
  assert.equal(fallbackCall.provider.maxOutputTokens, 8192, 'fallback model limits ride the fallback route')
  // Same live dsh session id: the hub re-pin keeps the JSONL history.
  assert.equal(fallbackCall.dshSessionId, initial.dshSessionId)
  assert.equal(result.sessionRow?.status, 'completed', 'the turn completes on the fallback route')
  assert.equal(result.errors.length, 0, 'no session error is surfaced')
  await result.completed
})

test('without a fallback brain the turn fails after the primary resume budget (behavior unchanged)', async () => {
  const result = await driveTurn({
    sessionId: 'gt02-no-fallback',
    metabot: { id: 2, name: 'NoFallback Bot', llm_id: 'mock-a1', llm_provider: 'gw-a' },
    script: () => ({ kind: 'error', error: { code: 'TIMEOUT', message: 'request timed out' } }),
  })

  assert.equal(result.runTurnCalls.length, 4, '1 initial + 3 primary resumes, then the turn fails')
  for (const call of result.runTurnCalls) {
    assert.equal(call.provider.key, 'gw-a', 'every attempt stays on the primary route')
  }
  assert.equal(result.sessionRow?.status, 'error')
  assert.ok(
    result.errors.some((entry) => String(entry.error).includes('DSH turn failed')),
    'the transient failure settles as a session error',
  )
})

test('a non-transient error never triggers the fallback chain', async () => {
  const result = await driveTurn({
    sessionId: 'gt02-auth-failed',
    metabot: BOT_WITH_FALLBACK,
    script: () => ({ kind: 'error', error: { code: 'AUTH_FAILED', message: '401 invalid api key' } }),
  })

  assert.equal(result.runTurnCalls.length, 1, 'auth failure: no resume, no fallback attempt')
  assert.equal(result.runTurnCalls[0].provider.key, 'gw-a')
  assert.equal(result.sessionRow?.status, 'error')
  assert.ok(result.errors.some((entry) => String(entry.error).includes('401 invalid api key')))
})

test('a fallback brain resolving to the SAME route as the failed primary is not retried', async () => {
  const result = await driveTurn({
    sessionId: 'gt02-same-route-fallback',
    // Fallback brain points at the same provider+model as the primary —
    // switching would just re-hit the dead path.
    metabot: {
      id: 3,
      name: 'SameRoute Bot',
      llm_id: 'mock-a1',
      llm_provider: 'gw-a',
      fallback_llm_id: 'mock-a1',
      fallback_llm_provider: 'gw-a',
    },
    script: () => transientError(),
  })

  assert.equal(result.runTurnCalls.length, 4, 'same-route fallback: primary budget only, no extra attempts')
  for (const call of result.runTurnCalls) {
    assert.equal(call.provider.key, 'gw-a')
  }
  assert.equal(result.sessionRow?.status, 'error')
})

// §9 (GROUP-TASK-FIX-REQ-v2): the identity-layer fallback must sink into the
// session runtime layer for EVERY bot that configured one — including a bot
// whose PRIMARY brain is the app-global default (no llm_id on its metabot
// row). Before the fix, getSessionAutomationBrain gated on llm_id and such a
// bot's fallback_llm_* was never consulted: an outage on the default route
// failed the turn outright instead of degrading.
test('a bot without a primary llm_id still inherits its configured fallback brain on outage', async () => {
  const result = await driveTurn({
    sessionId: 'gt02-fallback-only-bot',
    metabot: { id: 4, name: 'FallbackOnly Bot', fallback_llm_id: 'mock-b1', fallback_llm_provider: 'gw-b' },
    // Global default route (mock-a1 via gw-a) dies transiently; the first
    // FALLBACK attempt succeeds.
    script: (_input, callNo) => (callNo <= 4 ? transientError() : { kind: 'completed' }),
  })

  assert.equal(result.runTurnCalls.length, 5, '1 initial + 3 default-route resumes + 1 fallback resume')
  for (const call of result.runTurnCalls.slice(0, 4)) {
    assert.equal(call.provider.key, 'gw-a', 'primary attempts ride the app-global default route')
    assert.equal(call.provider.model, 'mock-a1')
  }
  const fallbackCall = result.runTurnCalls[4]
  assert.equal(fallbackCall.provider.key, 'gw-b', 'the exhausted turn degrades to the configured fallback brain')
  assert.equal(fallbackCall.provider.model, 'mock-b1')
  assert.equal(result.sessionRow?.status, 'completed')
  assert.equal(result.errors.length, 0)
  await result.completed
})

// Config-level facet of the same gap: with no llm_id AND no enabled default
// provider, route resolution used to skip the bot's fallback brain entirely
// (the branch required a primary override). The turn must START on the
// fallback route instead of failing with "provider not enabled".
test('a fallback-only bot starts on its fallback brain when the default provider is disabled', async () => {
  const result = await driveTurn({
    sessionId: 'gt02-fallback-only-disabled-default',
    metabot: { id: 5, name: 'FallbackOnly Bot', fallback_llm_id: 'mock-b1', fallback_llm_provider: 'gw-b' },
    configOverrides: {
      providers: {
        'gw-a': {
          enabled: false,
          apiKey: 'sk-a',
          baseUrl: 'http://primary.example/v1',
          apiFormat: 'openai',
          models: [{ id: 'mock-a1', name: 'mock-a1', contextWindow: 32768, maxOutputTokens: 4096 }],
        },
      },
    },
    script: () => ({ kind: 'completed' }),
  })

  assert.equal(result.runTurnCalls.length, 1, 'no dead primary attempt — the turn starts on the fallback route')
  assert.equal(result.runTurnCalls[0].provider.key, 'gw-b')
  assert.equal(result.runTurnCalls[0].provider.model, 'mock-b1')
  assert.equal(result.sessionRow?.status, 'completed')
  assert.equal(result.errors.length, 0)
  await result.completed
})

// §9 acceptance, end to end at the runner layer: a GROUP-TASK worker session
// (sessionType 'group_task', metabotId set — exactly what ensureGroupTaskSession
// creates) hits a primary-route outage, degrades to the bot's fallback brain,
// completes the turn (the task is not interrupted), and the degradation event
// is visible both in the session transcript and in cowork.log.
test('a group-task worker session degrades to the bot fallback brain and logs the event', async () => {
  const sessionId = 'gt02-group-task-worker'
  const result = await driveTurn({
    sessionId,
    metabot: BOT_WITH_FALLBACK,
    sessionRow: { sessionType: 'group_task' },
    script: (_input, callNo) => (callNo <= 4 ? transientError() : { kind: 'completed' }),
  })

  assert.equal(result.runTurnCalls.length, 5)
  assert.equal(result.runTurnCalls[4].provider.key, 'gw-b', 'the worker turn completes on the fallback model')
  assert.equal(result.runTurnCalls[4].provider.model, 'mock-b1')
  assert.equal(result.sessionRow?.status, 'completed', 'the turn completes — the group task is not interrupted')
  assert.equal(result.errors.length, 0)

  const notice = result.store.messages.find(
    (m) => m.sessionId === sessionId && m.type === 'system' && m.metadata?.dshRouteFallback === true,
  )
  assert.ok(notice, 'a dshRouteFallback system message lands in the worker session transcript')
  assert.match(notice.content, /mock-b1/)
  assert.match(notice.content, /gw-b/)

  const logText = fs.readFileSync(coworkLogPath(), 'utf-8')
  assert.ok(
    logText.includes('switching to the bot fallback brain route'),
    'the degradation WARN event is written to cowork.log',
  )
  assert.ok(logText.includes(sessionId), 'the degradation log line names the worker session')
  await result.completed
})
