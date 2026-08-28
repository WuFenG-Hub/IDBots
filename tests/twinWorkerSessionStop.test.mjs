// Twin-only worker_session_stop tool (Task 4 of the DSH integration fix
// list): the Twin can autonomously terminate a stuck Worker session — the
// stop aborts the in-flight turn, auto-denies pending approvals, and settles
// the session to the deliberate 'stopped' terminal state. Authorization
// matrix: Twin callers only, and only sessions owned by worker-type bots.
//
// Requires: npm run compile:electron.

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'

const require = Module.createRequire(import.meta.url)

function loadRunner() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => `/tmp/idbots-worker-stop-${name}`,
        },
      }
    }
    return originalLoad.apply(this, arguments)
  }
  try {
    return require('../dist-electron/main/libs/coworkRunner.js')
  } finally {
    Module._load = originalLoad
  }
}

const BOTS = new Map([
  [1, { id: 1, name: 'Twin', enabled: true, metabot_type: 'twin' }],
  [2, { id: 2, name: 'Builder', enabled: true, metabot_type: 'worker' }],
])

function makeHarness() {
  const { CoworkRunner } = loadRunner()
  const sessions = new Map([
    ['twin-session', { id: 'twin-session', metabotId: 1, status: 'idle' }],
    ['worker-session', { id: 'worker-session', metabotId: 2, status: 'running' }],
    ['plain-session', { id: 'plain-session', metabotId: null, status: 'running' }],
  ])
  const stopped = []
  const store = {
    getSession: (id) => sessions.get(id) ?? null,
    getConfig: () => ({}),
    updateSession: (id, updates) => {
      const existing = sessions.get(id) ?? { id }
      sessions.set(id, { ...existing, ...updates })
    },
  }
  const runner = new CoworkRunner(store, {
    localTurnStallTimeoutMs: 0,
    getMetabotById: (id) => BOTS.get(id) ?? null,
  })
  const realStop = runner.stopSession.bind(runner)
  runner.stopSession = (sessionId, options) => {
    stopped.push({ sessionId, options })
    return realStop(sessionId, options)
  }
  const call = (toolName, toolInput, asSession = 'twin-session') =>
    runner.handleHostToolExecution({ toolName, toolInput }, asSession)
  return { runner, stopped, sessions, call }
}

test('worker_session_stop: Twin stops a worker session to the stopped terminal state', async () => {
  const { stopped, sessions, call } = makeHarness()
  const result = await call('worker_session_stop', { sessionId: 'worker-session' })
  assert.deepEqual(JSON.parse(result.text), { ok: true, sessionId: 'worker-session', status: 'stopped' })
  // P1-3: the stop carries the Twin-request reason on the audit trail.
  assert.deepEqual(stopped, [{
    sessionId: 'worker-session',
    options: { finalStatus: 'stopped', reason: 'Twin requested stop via worker_session_stop' },
  }])
  assert.equal(sessions.get('worker-session').status, 'stopped')
})

test('worker_session_stop: non-Twin callers are forbidden', async () => {
  const { stopped, call } = makeHarness()
  const result = await call('worker_session_stop', { sessionId: 'worker-session' }, 'worker-session')
  assert.equal(result.success, false)
  assert.equal(JSON.parse(result.text).code, 'TWIN_TOOL_FORBIDDEN')
  assert.equal(stopped.length, 0, 'nothing stopped')
})

test('worker_session_stop: only worker-type sessions are valid targets', async () => {
  const { stopped, call } = makeHarness()
  // Twin's own session is not a worker session.
  const selfStop = await call('worker_session_stop', { sessionId: 'twin-session' })
  assert.equal(JSON.parse(selfStop.text).code, 'NOT_A_WORKER_SESSION')
  // Plain user session (no metabot) is not a worker session.
  const plainStop = await call('worker_session_stop', { sessionId: 'plain-session' })
  assert.equal(JSON.parse(plainStop.text).code, 'NOT_A_WORKER_SESSION')
  // Unknown session id.
  const missing = await call('worker_session_stop', { sessionId: 'nope' })
  assert.equal(JSON.parse(missing.text).code, 'SESSION_NOT_FOUND')
  // Missing parameter.
  const noArg = await call('worker_session_stop', {})
  assert.equal(JSON.parse(noArg.text).code, 'SESSION_ID_REQUIRED')
  assert.equal(stopped.length, 0, 'nothing stopped')
})

// P1-2 (task #36 incident): a DSH tool call whose result never arrives used
// to re-arm the stall watchdog forever. collectExpiredToolCalls is the pure
// age check behind the hard cap that now cancels + force-settles such turns.
test('collectExpiredToolCalls: counts only calls older than the cap; cap <= 0 disables', () => {
  const { collectExpiredToolCalls } = loadRunner()
  const nowMs = 1_700_000_000_000
  const capMs = 60 * 60_000
  assert.equal(collectExpiredToolCalls([], nowMs, capMs), 0)
  assert.equal(
    collectExpiredToolCalls([nowMs - 5 * 60_000, nowMs - 30 * 60_000], nowMs, capMs),
    0,
    'fresh in-flight calls never expire',
  )
  assert.equal(
    collectExpiredToolCalls([nowMs - 5 * 60_000, nowMs - 61 * 60_000, nowMs - 120 * 60_000], nowMs, capMs),
    2,
    'only over-cap calls count',
  )
  assert.equal(collectExpiredToolCalls([nowMs - 999 * 60_000], nowMs, 0), 0, 'cap disabled')
  // Map values (the named-tool ledger shape) are accepted as-is.
  assert.equal(
    collectExpiredToolCalls(new Map([['tool-1', nowMs - 90 * 60_000]]).values(), nowMs, capMs),
    1,
  )
})
