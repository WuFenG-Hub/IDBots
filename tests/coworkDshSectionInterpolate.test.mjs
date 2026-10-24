// DSH turn sections must register authored content as non-interpolating
// (2026-10-22, A2A session 33c61c77). The incident: an A2A private-chat peer
// message quoted the literal placeholders {{METABOT_SKILL_PIN}} /
// {{SKILL_ZIP_METAFILE}}; that history rides the session's stored system
// prompt, which runDshSessionLocal registers as the `idbots:base` section —
// and the DSH kernel's strict prompt-variable interpolator killed every turn
// of the session with "malformed prompt variable reference". The fix marks
// `idbots:base` (bot persona + A2A peer history) and `idbots:goal` (user goal
// text) with `interpolate: false` at BOTH registration sites — the
// turn-agent prewarm and the turn itself — so the kernel renders them
// literally. The end-to-end kernel replay lives in
// dsh-runtime/test/prompt-sections-interpolate.test.mjs; this file pins the
// app side: the sections coworkRunner actually hands the hub carry the flag.
//
// Host-side coverage only: the DSH turn hub is faked (no dsh-runtime spawn),
// so this file does NOT need dsh-runtime/node_modules.
//
// Requires: pnpm run compile:electron

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import path from 'node:path'

const require = Module.createRequire(import.meta.url)

function loadModules() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-section-interpolate-${name}`),
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
      resolveMetabotIdForMemory: () => 1,
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

// The incident payload: brace groups a peer bot quoted while discussing
// unrendered placeholders in an on-chain tutorial — text that must reach the
// model verbatim, not die in the kernel interpolator.
const INCIDENT_SYSTEM_PROMPT = [
  'You are AI_Sunny.',
  '## Active private-chat context',
  'Bot-007: 「链上直装」段两个占位符在链上原文未渲染（{{METABOT_SKILL_PIN}} / {{SKILL_ZIP_METAFILE}}），读者按此装不了。',
].join('\n')

async function driveTurn({ sessionId, sessionRow = {} }) {
  const loaded = loadModules()
  const { CoworkRunner } = loaded.runner
  installApiConfig(loaded.claudeSettings)

  const store = new RecordingStore()
  const runner = new CoworkRunner(store, {})

  const runTurnCalls = []
  const prewarmCalls = []
  runner.dshTurnHub = {
    runTurn: async (input) => {
      runTurnCalls.push(input)
      return { kind: 'completed' }
    },
    prewarmTurnAgent: async (input) => {
      prewarmCalls.push(input)
    },
    prewarmTurnSlot: async () => undefined,
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
  store.sessions.set(sessionId, {
    id: sessionId,
    executionMode: 'local',
    metabotId: null,
    messages: [],
    ...sessionRow,
  })
  runner.on('error', () => undefined)
  runner.on('permissionRequest', () => undefined)
  const completed = new Promise((resolve) => runner.once('complete', resolve))

  await runner.runDshSessionLocal(activeSession, 'ping the peer', process.cwd(), INCIDENT_SYSTEM_PROMPT)

  return { runner, store, runTurnCalls, prewarmCalls, completed }
}

const sectionNamed = (sections, name) => sections.find((s) => s.name === name)

test('idbots:base carrying A2A history registers with interpolate:false on every DSH path', async () => {
  const result = await driveTurn({ sessionId: 'a2a-section-interpolate' })

  assert.ok(result.runTurnCalls.length >= 1, 'the turn reached the hub')
  const turnBase = sectionNamed(result.runTurnCalls[0].sections, 'idbots:base')
  assert.ok(turnBase, 'idbots:base section present on the turn')
  assert.equal(turnBase.interpolate, false, 'turn idbots:base is non-interpolating')
  assert.match(turnBase.text, /\{\{METABOT_SKILL_PIN\}\}/, 'the incident payload rides the section text')

  const prewarmBase = prewarmSections(result)?.find((s) => s.name === 'idbots:base')
  if (prewarmBase) {
    assert.equal(prewarmBase.interpolate, false, 'prewarm idbots:base is non-interpolating')
  }
  assert.equal(result.store.sessions.get('a2a-section-interpolate').status, 'completed', 'the turn completes')
  await result.completed
})

test('idbots:goal carrying user goal text registers with interpolate:false too', async () => {
  const result = await driveTurn({
    sessionId: 'a2a-section-interpolate-goal',
    sessionRow: { goal: { status: 'active', text: 'Ship the {{RELEASE_CHECKLIST}} update' } },
  })

  assert.ok(result.runTurnCalls.length >= 1, 'the turn reached the hub')
  const turnGoal = sectionNamed(result.runTurnCalls[0].sections, 'idbots:goal')
  assert.ok(turnGoal, 'idbots:goal section present on the turn')
  assert.equal(turnGoal.interpolate, false, 'turn idbots:goal is non-interpolating')
  assert.match(turnGoal.text, /\{\{RELEASE_CHECKLIST\}\}/, 'the goal text rides the section verbatim')
  await result.completed
})

/** Sections captured from the prewarm call, if the prewarm fired before the turn. */
function prewarmSections(result) {
  return result.prewarmCalls[0]?.sections
}
