// M4 E2E test: the compiled DshKernel adapter drives the real dsh-runtime
// subprocess (generated pi-ai config against a local mock OpenAI gateway) and
// produces the CoworkMessage contract through the wire:
//
//  1. ensureRuntime + ensureSession + prompt → user/assistant stream/finalize,
//     tool round trip, usage, turnEnd
//  2. steer mid-turn accepted and consumed as a durable user message
//  3. approval ask → respond → tool executes
//  4. cancel mid-turn closes the turn aborted
//  5. kernel.restart + ensureSession resumes the SAME session over the wire
//
// Requires: npm run compile:electron and dsh-runtime/node_modules installed.
// Skips (rather than fails) when the runtime deps are absent.

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

test('DshKernel E2E', { skip: runtimeReady ? false : 'dsh-runtime/node_modules not installed' }, async () => {
  const { DshKernel } = require('../dist-electron/main/libs/dshKernel/dshKernel.js')
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server, seen } = await startMockServer(48790)

  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kernel-e2e-'))
  const messages = []
  const updates = []
  const finals = []
  const turnEnds = []
  const usages = []
  const asks = []
  const cancelledAsks = []
  let idSeq = 0

  const kernel = new DshKernel({
    runtimeDir,
    handlers: {
      onMessage: (sessionId, message) => {
        idSeq += 1
        const id = `m-${idSeq}`
        messages.push({ id, sessionId, ...message })
        return id
      },
      onMessageUpdate: (sessionId, messageId, content) => updates.push({ sessionId, messageId, content }),
      onMessageFinalize: (sessionId, messageId, content) => finals.push({ sessionId, messageId, content }),
      onTurnEnd: (sessionId, reason) => turnEnds.push({ sessionId, reason }),
      onUsage: (sessionId, usage) => usages.push({ sessionId, usage }),
      onApprovalRequest: (sessionId, ask) => asks.push({ sessionId, ask }),
      onApprovalCancelled: (id) => cancelledAsks.push(id),
      onError: (error) => console.log('[dbg] pump error:', error?.message ?? error, error?.stack?.split('\n').slice(0, 4).join(' | ')),
    },
  })

  const config = {
    sessionRoot,
    providers: [{
      key: 'mockgw',
      apiFormat: 'openai',
      baseUrl: 'http://127.0.0.1:48790/v1',
      apiKeyEnv: 'DSH_KERNEL_TEST_KEY',
      models: [{ id: 'mock-1', contextWindow: 32768 }],
    }],
    sections: [{ name: 'persona:metabot', order: 0, text: 'You are Alice, an on-chain assistant.' }],
    shaping: { maxChars: 8000, tailChars: 1000 },
    extraEntries: [{ id: 'idbots-test-tools', name: path.join(runtimeDir, 'test', 'fixtures', 'test-tools.mjs') }],
    env: { DSH_KERNEL_TEST_KEY: 'sk-kernel-test', SPIKE_QUIET: '1' },
  }

  const sessionId = `kernel-e2e-${Date.now().toString(36)}`
  try {
    await kernel.ensureRuntime(config)
    const ensured = await kernel.ensureSession({ sessionId, provider: 'mockgw', model: 'mock-1' })
    assert.equal(ensured.resumed, false)

    // ---- 1. plain turn ---------------------------------------------------
    await kernel.prompt(sessionId, 'HELLO_MOCK')
    await waitFor(() => turnEnds.some((t) => t.sessionId === sessionId && t.reason.kind === 'completed'), 25000, 'turn 1 completion')
    // User bubbles come from the host's submission path — the kernel/mapper
    // must not echo them (that duplicated messages in the live app).
    assert.ok(!messages.some((m) => m.type === 'user'), 'no user echo from the kernel')
    const assistant = messages.find((m) => m.type === 'assistant' && !m.metadata?.isThinking)
    assert.ok(assistant, 'assistant message emitted')
    assert.equal(assistant.metadata.isStreaming, true, 'assistant opened as streaming')
    const finalText = finals.find((f) => f.messageId === assistant.id)
    assert.ok(finalText && finalText.content.includes('mock says'), 'streaming message finalized with full text')
    assert.ok(usages.some((u) => u.sessionId === sessionId), 'usage reported')

    // ---- 2. steer mid-turn ------------------------------------------------
    await kernel.prompt(sessionId, 'STEER_TEST')
    await waitFor(() => messages.some((m) => m.type === 'tool_use' && m.metadata.toolName === 'slow_tool'), 25000, 'slow_tool call')
    const steerReceipt = await kernel.steer(sessionId, 'STEERED_NOW drop it')
    assert.equal(steerReceipt.steered, true)
    // Consumption is proven by the steer text reaching the next model request.
    await waitFor(() => seen.some((r) => r.body?.messages?.some((m) => String(m.content).includes('STEERED_NOW'))), 25000, 'steer reached the model')
    await waitFor(() => turnEnds.filter((t) => t.sessionId === sessionId).length >= 2, 25000, 'steer turn completion')

    // ---- 3. approval round trip -------------------------------------------
    await kernel.prompt(sessionId, 'CALL_DANGEROUS')
    const ask = await waitFor(() => asks.find((a) => a.sessionId === sessionId), 25000, 'approval ask')
    assert.equal(ask.ask.toolName, 'dangerous_tool')
    await kernel.respondApproval(ask.ask.id, 'allowed-once')
    await waitFor(() => messages.some((m) => m.type === 'tool_result' && m.content.includes('"executed":true')), 25000, 'approved tool executed')

    // ---- 4. cancel mid-turn ------------------------------------------------
    await kernel.prompt(sessionId, 'STEER_TEST')
    await waitFor(() => {
      const calls = messages.filter((m) => m.type === 'tool_use' && m.metadata.toolName === 'slow_tool')
      return calls.length >= 2 ? calls : null
    }, 25000, 'second slow_tool call')
    await kernel.cancel(sessionId, 'kernel e2e cancel')
    const aborted = await waitFor(
      () => turnEnds.find((t) => t.sessionId === sessionId && t.reason.kind === 'aborted'),
      25000,
      'aborted turn end',
    )
    assert.match(aborted.reason.reason, /kernel e2e cancel/)

    // ---- 5. restart + resume over the wire --------------------------------
    console.log('[dbg] session root before restart:', JSON.stringify(fs.readdirSync(sessionRoot)))
    await sleep(500) // let the 200ms write batch land
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).map((e) => e.isDirectory() ? `${e.name}/` : e.name)
    const inner = fs.readdirSync(sessionRoot).find((n) => n.startsWith('--'))
    console.log('[dbg] inner dir:', inner ? JSON.stringify(walk(path.join(sessionRoot, inner))) : '(none)')
    const sessionDir = path.join(sessionRoot, inner)
    const sidDir = path.join(sessionDir, fs.readdirSync(sessionDir)[0])
    console.log('[dbg] session id dir files:', JSON.stringify(walk(sidDir)))
    const logFile = path.join(sidDir, 'session.jsonl')
    console.log('[dbg] log size:', fs.existsSync(logFile) ? fs.statSync(logFile).size : 'MISSING')
    console.log('[dbg] log head:', fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(0, 200) : 'MISSING')
    await kernel.restart(config)
    console.log('[dbg] root AFTER restart:', JSON.stringify(fs.readdirSync(sessionRoot)))
    const resumed = await kernel.ensureSession({ sessionId, provider: 'mockgw', model: 'mock-1' })
    assert.equal(resumed.resumed, true, 'session resumed from persisted log after restart')
    await kernel.prompt(sessionId, 'AFTER_RESTART')
    await waitFor(() => turnEnds.filter((t) => t.sessionId === sessionId && t.reason.kind === 'completed').length >= 4, 25000, 'post-restart turn completion')
    await waitFor(
      () => turnEnds.filter((t) => t.sessionId === sessionId && t.reason.kind === 'completed').length >= 4,
      25000,
      'post-restart turn completion',
    )
    // The resumed conversation still carries earlier history to the gateway.
    const lastRequest = seen.at(-1)
    assert.ok(lastRequest.body.messages.some((m) => m.role === 'user' && String(m.content).includes('HELLO_MOCK')), 'history survived the restart')

    assert.ok(cancelledAsks.length === 0, 'no stray approval cancellations')
  } finally {
    await kernel.close()
    server.close()
    fs.rmSync(sessionRoot, { recursive: true, force: true })
  }
})
