// plan-mode E2E (0.1.5): the composition mounts dsh-plan-mode, so the host can
// flip session mode through idbots/plan-mode/set, the plan:policy section
// reaches the provider request, and exit_plan_mode review rides the
// user-questions bridge with the full plan markdown on question.detail.
// Approving the review exits plan mode (plan projection flips back).
//
// Run: node test/plan-mode.test.mjs   (from dsh-runtime/)

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

const main = async () => {
  const { server, seen } = await startMockServer(48831)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-planmode-'))
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48831/v1', apiKeyEnv: 'PLANMODE_KEY',
      models: [{ id: 'mock-1', contextWindow: 32000 }],
    }],
    sections: [],
  })
  const configJson = JSON.stringify(config)
  assert.ok(configJson.includes('dsh-plan-mode'), 'generator mounts the plan-mode entry')
  const configPath = path.join(os.tmpdir(), `dsh-planmode-${Date.now()}.json`)
  fs.writeFileSync(configPath, configJson)

  const client = runtimeClient({
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, PLANMODE_KEY: 'sk-planmode', SPIKE_QUIET: '1' },
  })
  client.start()
  await client.initialize({ cwd: runtimeDir, provider: 'mockgw', model: 'mock-1' })
  const sessionId = `planmode-${Date.now().toString(36)}`

  const waiters = new Set()
  const subscription = client.subscribe()
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
  const toolResults = []
  waiters.add((n) => {
    if (n.method === 'session.event' && n.params.sessionId === sessionId && n.params.event.type === 'tool/result') {
      toolResults.push(JSON.stringify(n.params.event))
    }
  })

  // Host-driven mode switch: between turns the selection commits immediately.
  // The RPC needs the live agent, so ensure the session first (prompt would
  // auto-ensure, but the switch must land before the first turn here).
  await client.request('session/ensure', { sessionId, provider: 'mockgw', model: 'mock-1', cwd: runtimeDir })
  const setResult = await client.request('idbots/plan-mode/set', { sessionId, active: true })
  assert.equal(setResult.ok, true, 'plan-mode/set accepted')
  assert.equal(setResult.result, 'committed', 'idle selection commits immediately')
  console.log('PASS  idbots/plan-mode/set commits plan mode between turns')

  const usageActive = await client.request('idbots/usage', { sessionId })
  assert.equal(usageActive.plan?.active, true, 'plan projection reports active')
  console.log('PASS  idbots/usage exposes the plan wire view (active: true)')

  // The exit tool only exists inside plan mode; the mock issues the call.
  const ended = waitFor((n) => n.method === 'session.event' && n.params.sessionId === sessionId
    && n.params.event.type === 'turn/end', 30000, 'turn end')
  const reviewAsk = waitFor((n) => n.method === 'idbots/ask/request', 30000, 'plan review ask')
  await client.prompt(sessionId, [{ type: 'text', text: 'CALL_EXIT_PLAN present the plan' }])
  const ask = await reviewAsk
  const reviewQuestion = (ask.params.questions ?? [])[0]
  assert.ok(reviewQuestion, 'review question present')
  assert.equal(reviewQuestion.header, 'Plan review', 'review question header')
  assert.ok(String(reviewQuestion.detail ?? '').includes('# Test Plan'), 'question.detail carries the full plan markdown')
  assert.ok((reviewQuestion.options ?? []).some((o) => o.label === 'Approve'), 'Approve option present')
  console.log('PASS  exit_plan_mode review bridges with detail + Approve option')

  await client.request('idbots/ask/respond', {
    id: ask.params.id,
    answers: [{ id: reviewQuestion.id, selected: ['Approve'] }],
  })
  await ended
  const approved = toolResults.find((r) => r.includes('Plan approved'))
  assert.ok(approved, 'tool result narrates the approved exit')
  console.log('PASS  approving the review exits plan mode (tool result narrates)')

  // The request that carried CALL_EXIT_PLAN ran under plan mode, so the
  // plan:policy section text must appear in the provider payload.
  const planRequest = seen.find((record) => JSON.stringify(record.body).includes('CALL_EXIT_PLAN'))
  assert.ok(planRequest, 'mock gateway saw the CALL_EXIT_PLAN request')
  assert.ok(JSON.stringify(planRequest.body).includes('plan mode'), 'plan:policy section reached the provider request')
  console.log('PASS  plan:policy section text reaches the provider while active')

  const usageAfter = await client.request('idbots/usage', { sessionId })
  assert.equal(usageAfter.plan?.active, false, 'approved exit flips the projection back')
  console.log('PASS  plan projection reports inactive after the approved exit')

  await client.close()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(sessionRoot, { recursive: true, force: true })
  fs.rmSync(configPath, { force: true })
  console.log('plan-mode.test.mjs: all assertions passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
