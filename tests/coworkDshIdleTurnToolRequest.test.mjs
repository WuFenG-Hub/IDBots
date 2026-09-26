// Host tool bridge on kernel-initiated turns (2026-09-25 session 8665a5fd
// wedge). The incident: a subagent-finished wake started a kernel-side turn
// AFTER the last host turn's runTurn finally block deleted the live
// coworkByDsh mapping (and the runner deleted the session's host-tool
// registry). The model's longterm_subtask_wait + longterm_event_note calls
// crossed idbots/tool/request into onToolRequest, which looked up ONLY the
// live mapping, found nothing, and silently returned — stranding the
// runtime-side bridge promise forever. The turn wedged with no host
// controller (so no stall watchdog either); the owner's later "继续" queued
// behind the wedged turn and burned the full 10-minute watchdog window
// before "Error: tool call aborted before dispatch".
//
// Fix under test:
//  1. onToolRequest resolves through coworkOfDsh (pinned fallback, the same
//     path onMessage uses for idle-session turns) and, when nothing resolves,
//     answers with an explicit error respondTool instead of dropping — the
//     settle-don't-strand contract onAskRequest already enforces.
//  2. executeDshHostTool rebuilds the session's host-tool registry on demand
//     (covered implicitly: the hub-level executeTool stub stands in for the
//     runner executor here; the rebuild itself lives in coworkRunner).
// Requires: pnpm run compile:electron + dsh-runtime/node_modules installed.

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
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-idle-tool-${name}`),
        },
      }
    }
    return originalLoad.apply(this, arguments)
  }
  try {
    return require('../dist-electron/main/libs/coworkDshTurn.js')
  } finally {
    Module._load = originalLoad
  }
}

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

const hostEchoTool = {
  name: 'host_echo_tool',
  description: 'Echo a message through the host bridge (test).',
  parameters: {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
  },
}

test('kernel-initiated turn still executes host tools after the host turn tore down its mapping', {
  skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed',
}, async () => {
  const { DshTurnHub } = loadModules()
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server, seen } = await startMockServer(48831)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-idle-tool-'))
  const logs = []
  const executed = []
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot,
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
    executeTool: async (_coworkId, name, args) => {
      executed.push({ name, args })
      return { ok: true, text: `HOST_TOOL_OK:${name}` }
    },
  })
  const provider = {
    key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48831/v1',
    apiKey: 'sk-a', model: 'mock-1',
  }
  const dshSessionId = 'idle-wake-target'
  const callbacks = () => ({
    onMessage: () => `m-${Math.random().toString(36).slice(2)}`,
    onMessageUpdate: () => undefined,
    onMessageFinalize: () => undefined,
    onUsage: () => undefined,
    onApprovalRequest: () => undefined,
    onApprovalCancelled: () => undefined,
  })

  try {
    // Host turn: registers the kernel agent + host tools, executes one host
    // tool call, completes — then runTurn's finally deletes the live mapping.
    const out = await hub.runTurn({
      sessionId: 'cowork-idle-wake', dshSessionId, prompt: 'CALL_HOST_TOOL host turn', provider,
      sections: [{ name: 'idbots:base', order: 0, text: 'You are Alice.' }],
      hostTools: [hostEchoTool],
      callbacks: callbacks(),
    })
    assert.notEqual(out.kind, 'error', `host turn: ${JSON.stringify(out).slice(0, 240)}`)
    assert.equal(executed.length, 1, 'host turn executed the host tool exactly once')

    // Incident shape: the kernel agent stays live and starts its OWN turn (a
    // subagent-finished wake in production) with no host turn controller and
    // no live coworkByDsh entry — only the pinned mapping remains.
    const slot = hub.slots.get('mockgw')
    assert.ok(slot?.kernel?.running, 'the runtime (and its live agent) survived the host turn')
    await slot.kernel.prompt(dshSessionId, 'CALL_HOST_TOOL wake turn')

    // Old behavior: the wake turn's tool request hit the silent drop and this
    // wait never resolved — the turn wedged invisible to every watchdog.
    await waitFor(() => executed.length >= 2, 25000, 'wake-turn host tool execution')

    // The respond round-tripped: the provider saw the tool result in the wake
    // turn's window, answered in plain text, and the kernel turn finished.
    await waitFor(
      () => seen.some((r) => JSON.stringify(r.body?.messages ?? []).includes('HOST_TOOL_OK:host_echo_tool')),
      25000,
      'host tool result reaching the provider',
    )
    assert.ok(
      !logs.some((l) => l.message.includes('dshTurnHub.onToolRequest')),
      'the mapped wake-turn tool request must not be rejected',
    )
  } finally {
    await hub.close().catch(() => undefined)
    server.close()
    fs.rmSync(sessionRoot, { recursive: true, force: true })
  }
})

test('a host tool request with NO resolvable mapping is rejected, never silently dropped', async () => {
  const { DshTurnHub } = loadModules()
  const logs = []
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-idle-tool-unit-')),
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
    executeTool: async () => ({ ok: true, text: 'unreachable' }),
  })
  try {
    // White-box: create the provider slot without booting a runtime and reach
    // the kernel's handler set directly (TypeScript-private members are
    // runtime-accessible from JS tests).
    const slot = hub.getOrCreateSlot('mockgw')
    const kernel = slot.kernel
    const responses = []
    kernel.respondTool = async (id, result) => {
      responses.push({ id, result })
      return { answered: true }
    }
    const handlers = kernel.opts.handlers

    handlers.onToolRequest({
      sessionId: 'cw-never-mapped',
      id: 'tool-unmapped-1',
      name: 'host_echo_tool',
      arguments: { message: 'anyone?' },
    })

    // The bridge promise MUST settle: an explicit error respond beats the old
    // silent return that stranded the kernel's pending tool call forever.
    await waitFor(() => responses.length === 1, 5000, 'reject respondTool')
    assert.equal(responses[0].id, 'tool-unmapped-1')
    assert.equal(responses[0].result.ok, false)
    assert.match(
      responses[0].result.error,
      /no session mapping/,
      'the reject error tells the model why the tool never ran',
    )
    assert.ok(
      logs.some((l) => l.message.includes('dshTurnHub.onToolRequest')
        && String(l.detail.message ?? '').includes('no cowork session mapping')),
      'the dropped-request rejection is visible in the hub log',
    )
  } finally {
    await hub.close().catch(() => undefined)
  }
})

test('an approval request with no live turn controller auto-rejects instead of stranding the kernel', async () => {
  const { DshTurnHub } = loadModules()
  const logs = []
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-idle-tool-approval-')),
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
  })
  try {
    const slot = hub.getOrCreateSlot('mockgw')
    const kernel = slot.kernel
    const approvals = []
    kernel.respondApproval = async (id, outcome) => {
      approvals.push({ id, outcome })
      return { answered: true }
    }
    kernel.opts.handlers.onApprovalRequest('cw-never-mapped', {
      id: 'appr-1',
      sessionId: 'cw-never-mapped',
      toolName: 'bash',
    })
    await waitFor(() => approvals.length === 1, 5000, 'auto-reject respondApproval')
    assert.equal(approvals[0].id, 'appr-1')
    assert.equal(approvals[0].outcome, 'rejected')
    assert.ok(
      logs.some((l) => l.message.includes('dshTurnHub.onApprovalRequest')
        && String(l.detail.message ?? '').includes('auto-rejecting')),
      'the auto-reject is visible in the hub log',
    )
  } finally {
    await hub.close().catch(() => undefined)
  }
})

// ---- Policy bridge on kernel-initiated turns (reviewer follow-up) ---------
// onPolicyRequest used the live-only mapping: an idle-session turn (no live
// mapping) with a host policy CONFIGURED still settled to the permissive
// default 'allow' — plan-mode gating, read-image guards, and delete
// confirmations all lapsed on exactly the turns the tool-bridge fix made
// functional. The policy line must resolve through the pinned fallback like
// the tool line, and fail CLOSED (deny) when a configured policy cannot be
// consulted at all.

const makePolicyHub = (logs, evaluatePolicy) => new (loadModules().DshTurnHub)({
  runtimeDir,
  sessionRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-idle-policy-')),
  log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
  ...(evaluatePolicy ? { evaluatePolicy } : {}),
})

const spyPolicyKernel = (hub) => {
  const slot = hub.getOrCreateSlot('mockgw')
  const kernel = slot.kernel
  const responses = []
  kernel.respondPolicy = async (id, decision, reason) => {
    responses.push({ id, decision, reason })
    return { answered: true }
  }
  return { kernel, responses }
}

test('policy request with no mapping and a configured host policy denies (fail closed)', async () => {
  const logs = []
  const hub = makePolicyHub(logs, async () => ({ decision: 'allow' }))
  try {
    const { kernel, responses } = spyPolicyKernel(hub)
    kernel.opts.handlers.onPolicyRequest({
      sessionId: 'cw-never-mapped',
      id: 'pol-1',
      name: 'bash',
      arguments: { command: 'rm -rf /tmp/x' },
    })
    await waitFor(() => responses.length === 1, 5000, 'deny respondPolicy')
    assert.equal(responses[0].id, 'pol-1')
    assert.equal(responses[0].decision, 'deny')
    assert.match(responses[0].reason ?? '', /no cowork session mapping/)
    assert.ok(
      logs.some((l) => l.message.includes('dshTurnHub.onPolicyRequest')
        && String(l.detail.message ?? '').includes('denying')),
      'the fail-closed denial is visible in the hub log',
    )
  } finally {
    await hub.close().catch(() => undefined)
  }
})

test('policy request with no mapping and NO host policy keeps the ungated default-allow', async () => {
  const logs = []
  const hub = makePolicyHub(logs, null)
  try {
    const { kernel, responses } = spyPolicyKernel(hub)
    kernel.opts.handlers.onPolicyRequest({
      sessionId: 'cw-never-mapped',
      id: 'pol-2',
      name: 'bash',
      arguments: { command: 'ls' },
    })
    await waitFor(() => responses.length === 1, 5000, 'allow respondPolicy')
    assert.equal(responses[0].decision, 'allow')
  } finally {
    await hub.close().catch(() => undefined)
  }
})

test('policy request on an idle turn resolves the pinned mapping and consults the host policy', async () => {
  const logs = []
  const consulted = []
  const hub = makePolicyHub(logs, async (coworkId, name, args) => {
    consulted.push({ coworkId, name, args })
    return { decision: 'deny', reason: 'plan mode (test)' }
  })
  try {
    const { kernel, responses } = spyPolicyKernel(hub)
    // The pinned mapping is exactly what a kernel-initiated turn has left
    // after runTurn's finally deleted the live entry.
    hub.pinnedDshIds.set('cowork-idle-policy', 'cw-pinned-policy')
    kernel.opts.handlers.onPolicyRequest({
      sessionId: 'cw-pinned-policy',
      id: 'pol-3',
      name: 'bash',
      arguments: { command: 'echo hi' },
    })
    await waitFor(() => responses.length === 1, 5000, 'evaluated respondPolicy')
    assert.deepEqual(
      consulted.map((c) => c.coworkId),
      ['cowork-idle-policy'],
      'the pinned fallback routed the check to the host policy',
    )
    assert.equal(responses[0].decision, 'deny')
    assert.equal(responses[0].reason, 'plan mode (test)')
  } finally {
    await hub.close().catch(() => undefined)
  }
})

test('a transport death during the reject respondTool never becomes an unhandled rejection', async () => {
  const logs = []
  const hub = new (loadModules().DshTurnHub)({
    runtimeDir,
    sessionRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-idle-tool-reject-')),
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
    executeTool: async () => ({ ok: true, text: 'unreachable' }),
  })
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(String(reason))
  process.on('unhandledRejection', onUnhandled)
  try {
    const slot = hub.getOrCreateSlot('mockgw')
    const kernel = slot.kernel
    // The wire request rejects asynchronously — the exact shape of a runtime
    // dying between the reject decision and the respond delivery.
    kernel.respondTool = async () => {
      throw new Error('mock transport dead')
    }
    kernel.opts.handlers.onToolRequest({
      sessionId: 'cw-never-mapped',
      id: 'tool-reject-1',
      name: 'host_echo_tool',
      arguments: {},
    })
    // Give the rejection a chance to surface unhandled.
    await sleep(200)
    assert.deepEqual(unhandled, [], 'the reject respond must be catch-guarded')
  } finally {
    process.off('unhandledRejection', onUnhandled)
    await hub.close().catch(() => undefined)
  }
})
