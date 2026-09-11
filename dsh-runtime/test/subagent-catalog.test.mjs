// Subagent durable catalog E2E (0.1.5): dsh-subagent logs one
// `subagent/catalog` event per established child on the PARENT session, so
// the panel lineage (idbots/subagents/list) and child transcripts
// (idbots/subagents/messages) must survive a full runtime restart — the
// in-memory rows that used to back those RPCs are per-process and went empty
// on every runtime reap or app restart.
//
// Act 1 drives a real delegation on runtime A; act 2 boots a FRESH runtime
// over the same session root and asserts the lineage and transcript still
// read back (status 'done', startedAt from the catalog fact).
//
// Run: node test/subagent-catalog.test.mjs   (from dsh-runtime/)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeClient } from './helpers/runtime-client.mjs'
import { generateRuntimeConfig } from '../lib/generate-runtime-config.mjs'
import { startMockServer } from './fixtures/mock-openai.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const runtimeDir = path.resolve(here, '..')

const bootRuntime = async (configPath, label) => {
  const client = runtimeClient({
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, CATALOG_KEY: 'sk-catalog', SPIKE_QUIET: '1' },
  })
  client.start()
  await client.initialize({ cwd: runtimeDir, provider: 'mockgw', model: 'mock-1' })
  return client
}

const main = async () => {
  const { server } = await startMockServer(48821)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-catalog-'))
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48821/v1', apiKeyEnv: 'CATALOG_KEY',
      models: [{ id: 'mock-1', contextWindow: 32768 }],
    }],
    sections: [],
  })
  const configPath = path.join(os.tmpdir(), `dsh-catalog-${Date.now()}.json`)
  fs.writeFileSync(configPath, JSON.stringify(config))
  const sessionId = `catalog-${Date.now().toString(36)}`

  // ---- Act 1: live delegation on runtime A -------------------------------
  const clientA = await bootRuntime(configPath, 'A')
  const waiters = new Set()
  const subscription = clientA.subscribe()
  const pumping = (async () => {
    for (;;) {
      const notification = await subscription.next()
      for (const wait of waiters) wait(notification)
    }
  })()
  pumping.catch(() => {})
  const waitFor = (predicate, timeoutMs, what) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), timeoutMs)
    const wait = (payload) => { if (predicate(payload)) { clearTimeout(timer); waiters.delete(wait); resolve(payload) } }
    waiters.add(wait)
  })
  // Policy gate auto-allow (delegation prompts no bash, but keep the loop harmless).
  void (async () => { for (;;) { try { const r = await waitFor((n) => n.method === 'idbots/policy/request', 60000); await clientA.request('idbots/policy/respond', { id: r.params.id, decision: 'allow' }) } catch { return } } })().catch(() => undefined)

  const catalogSeen = waitFor((n) => n.method === 'session.event' && n.params.sessionId === sessionId
    && n.params.event.type === 'subagent/catalog', 40000, 'durable subagent/catalog event')
  const parentEnded = waitFor((n) => n.method === 'session.event' && n.params.sessionId === sessionId
    && n.params.event.type === 'turn/end', 40000, 'parent turn end')
  await clientA.prompt(sessionId, [{ type: 'text', text: 'DELEGATE the task please' }])
  await parentEnded
  const catalogEvent = await catalogSeen
  const catalogData = catalogEvent.params.event.data
  assert.equal(catalogData.version, 0, 'catalog fact is version 0')
  assert.equal(typeof catalogData.childId, 'string', 'catalog fact names the child session id')
  assert.equal(typeof catalogData.childCreatedAt, 'number', 'catalog fact carries the child creation time')
  assert.ok(catalogData.mode === 'one-shot' || catalogData.mode === 'continuable', 'catalog fact carries the mode')
  const childId = catalogData.childId
  console.log('PASS  durable subagent/catalog event logged on the parent session')

  // Wait for the child's report round-trip (notice turn) so the child
  // transcript is complete on disk before runtime A dies.
  await waitFor((n) => n.method === 'session.event' && n.params.sessionId === sessionId
    && n.params.event.type === 'turn/end' && n.params.event.data?.turn === 2, 40000, 'parent notice turn end')

  // Live list still answers (in-memory rows present on runtime A).
  const liveList = await clientA.request('idbots/subagents/list', { sessionId })
  assert.ok(liveList.agents.some((a) => a.agentId === childId), 'live list names the child')
  const liveRow = liveList.agents.find((a) => a.agentId === childId)
  assert.equal(liveRow.mode, catalogData.mode, 'live row carries the catalog mode')

  subscription.close()
  await clientA.close()

  // ---- Act 2: fresh runtime over the same root ---------------------------
  const clientB = await bootRuntime(configPath, 'B')
  try {
    // Lineage survives with zero in-memory rows: the durable fold reports the
    // child as 'done' with its creation facts.
    const restored = await clientB.request('idbots/subagents/list', { sessionId })
    const restoredRow = restored.agents.find((a) => a.agentId === childId)
    assert.ok(restoredRow, 'post-restart list restores the child from the durable catalog')
    assert.equal(restoredRow.status, 'done', 'restored child reads as done (no live process state)')
    assert.equal(restoredRow.startedAt, catalogData.childCreatedAt, 'restored startedAt comes from the catalog fact')
    assert.equal(restoredRow.mode, catalogData.mode, 'restored mode comes from the catalog fact')
    console.log('PASS  post-restart lineage restored from the durable catalog')

    // Transcript survives too: the child session log reads back user +
    // assistant text without any in-memory ring buffer.
    const transcript = await clientB.request('idbots/subagents/messages', { sessionId, agentId: childId })
    assert.ok(transcript.messages.some((m) => m.type === 'user'), 'restored transcript carries the delegation prompt')
    assert.ok(transcript.messages.some((m) => m.type === 'assistant'), 'restored transcript carries the child reply')
    console.log('PASS  post-restart child transcript restored from persistence')

    // Unknown parent: graceful empty list, not an error.
    const empty = await clientB.request('idbots/subagents/list', { sessionId: 'no-such-parent' })
    assert.deepEqual(empty.agents, [], 'unknown parent lists no children')
  } finally {
    await clientB.close()
  }

  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(sessionRoot, { recursive: true, force: true })
  fs.rmSync(configPath, { force: true })
  console.log('subagent-catalog.test.mjs: all assertions passed')
  process.exit(0)
}

main().catch((error) => {
  console.error('[subagent-catalog-test] fatal:', error)
  process.exit(1)
})
