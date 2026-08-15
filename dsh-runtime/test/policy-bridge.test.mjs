// Policy bridge wire test: runtime-native tool decisions round-trip to the
// host (deny surfaces as an error tool result; ask flows through user-approval
// into the approval bridge, and an allowed answer executes the command).
//
// Run: node test/policy-bridge.test.mjs   (from dsh-runtime/)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
import { generateRuntimeConfig } from '../lib/generate-runtime-config.mjs'
import { startMockServer } from './fixtures/mock-openai.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const runtimeDir = path.resolve(here, '..')

const main = async () => {
  const { server } = await startMockServer(48796)
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-policy-ws-'))
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-policy-sess-'))
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48796/v1', apiKeyEnv: 'POLICY_KEY',
      models: [{ id: 'mock-1', contextWindow: 32768 }],
    }],
    sections: [],
    workspace: { cwd: workspaceDir },
  })
  const configPath = path.join(os.tmpdir(), `dsh-policy-${Date.now()}.json`)
  fs.writeFileSync(configPath, JSON.stringify(config))

  const client = new HarnessClient({
    command: process.execPath,
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, POLICY_KEY: 'sk-policy', SPIKE_QUIET: '1' },
  })
  client.start()
  await client.initialize({ cwd: workspaceDir, provider: 'mockgw', model: 'mock-1' })
  const sessionId = `policy-${Date.now().toString(36)}`

  const waiters = new Set()
  const events = []
  const subscription = client.subscribe()
  const pumping = (async () => {
    for (;;) {
      const notification = await subscription.next()
      for (const wait of waiters) wait(notification)
    }
  })()
  pumping.catch(() => {})
  const waitFor = (predicate, timeoutMs = 25000, what = 'notification') => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), timeoutMs)
    const wait = (payload) => {
      if (predicate(payload)) { clearTimeout(timer); waiters.delete(wait); resolve(payload) }
    }
    waiters.add(wait)
  })
  const sessionEvent = (predicate) => (n) => n.method === 'session.event' && n.params.sessionId === sessionId && predicate(n.params.event)

  // Permanent collector (waiters have NO replay buffer — register before use).
  const toolResults = []
  waiters.add((n) => {
    if (n.method === 'session.event' && n.params.sessionId === sessionId && n.params.event.type === 'tool/result') {
      toolResults.push(JSON.stringify(n.params.event))
    }
  })

  // Host policy: deny everything for turn 1.
  const policyMode = { decision: 'deny', reason: 'plan mode (test)' }
  void (async () => {
    for (;;) {
      try {
        const request = await waitFor((n) => n.method === 'idbots/policy/request', 60000)
        await client.request('idbots/policy/respond', { id: request.params.id, decision: policyMode.decision, reason: policyMode.reason })
      } catch { return }
    }
  })().catch(() => undefined)

  // Turn 1: deny path.
  let ended = waitFor(sessionEvent((e) => e.type === 'turn/end'), 30000)
  await client.prompt(sessionId, [{ type: 'text', text: 'RUN_BASH please' }])
  await ended
  assert.ok(toolResults.some((r) => r.includes('plan mode (test)')), 'deny reason surfaces in the tool result')

  // Turn 2: ask path — policy asks, approval bridge delivers, allow executes.
  policyMode.decision = 'ask'
  policyMode.reason = '删除必须人工确认 (test)'
  ended = waitFor(sessionEvent((e) => e.type === 'turn/end'), 30000)
  const askPromise = waitFor((n) => n.method === 'idbots/approval/request', 20000, 'approval ask')
  await client.prompt(sessionId, [{ type: 'text', text: 'RUN_BASH again' }])
  const ask = await askPromise
  assert.match(String(ask.params.reason ?? ''), /人工确认/, 'ask reason carries the confirmation question')
  await client.request('idbots/approval/respond', { id: ask.params.id, outcome: 'allowed-once' })
  await ended
  assert.ok(toolResults.some((r) => r.includes('BASH_WORKS')), 'allowed ask executes the command')

  subscription.close()
  await client.close()
  server.close()
  fs.rmSync(sessionRoot, { recursive: true, force: true })
  fs.rmSync(configPath, { force: true })
  console.log('PASS  policy bridge: deny surfaces reason; ask flows through approval and executes on allow')
  process.exit(0)
}

main().catch((error) => {
  console.error('[policy-test] fatal:', error)
  process.exit(1)
})
