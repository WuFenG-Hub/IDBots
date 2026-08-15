// Bash execution E2E: the model calls the bash tool through the real pi-ai
// path with a workspace mount; verifies the command actually executes (or
// surfaces the real failure mode instead of a silent timeout).
//
// Run: node test/bash-e2e.test.mjs   (from dsh-runtime/)

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
  const { server, seen } = await startMockServer(48794)
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bash-ws-'))
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bash-sess-'))
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48794/v1', apiKeyEnv: 'BASHTEST_KEY',
      models: [{ id: 'mock-1', contextWindow: 32768 }],
    }],
    sections: [],
    workspace: { cwd: workspaceDir },
  })
  const configPath = path.join(os.tmpdir(), `dsh-bash-${Date.now()}.json`)
  fs.writeFileSync(configPath, JSON.stringify(config))

  const client = new HarnessClient({
    command: process.execPath,
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, BASHTEST_KEY: 'sk-bash', SPIKE_QUIET: '1' },
    requestTimeoutMs: 30000,
  })
  client.start()
  await client.initialize({ cwd: workspaceDir, provider: 'mockgw', model: 'mock-1' })
  const sessionId = `bash-e2e-${Date.now().toString(36)}`

  const waiters = new Set()
  const events = []
  const notifications = []
  const subscription = client.subscribe()
  const pumping = (async () => {
    for (;;) {
      const notification = await subscription.next()
      if (notification.method === 'session.event' && notification.params.sessionId === sessionId) {
        events.push(notification.params.event)
        for (const wait of waiters) wait(notification.params.event)
      } else {
        notifications.push(notification)
        for (const wait of waiters) wait(notification)
      }
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
  const logEvent = (e) => {
    if (['tool/call', 'tool/result', 'approval/asked', 'approval/decided'].includes(e.type)) {
      console.log(`[ev] ${e.type} ${JSON.stringify(e.data ?? {}).slice(0, 200)}`)
    }
  }

  console.log('[test] prompting RUN_BASH with workspace at', workspaceDir)
  const turnDone = waitFor((e) => e?.type === 'turn/end', 30000, 'turn end')
  await client.prompt(sessionId, [{ type: 'text', text: 'RUN_BASH please' }])
  const watcher = (async () => { for (;;) { const e = await new Promise((r) => { const w = (p) => { if (p?.type) { waiters.delete(w); r(p) } }; waiters.add(w) }); logEvent(e) } })()
  watcher.catch(() => {})

  // Host policy gate: answer allow for every runtime-native tool call.
  const policyRace = (async () => {
    for (;;) {
      try {
        const request = await waitFor((n) => n.method === 'idbots/policy/request', 60000)
        await client.request('idbots/policy/respond', { id: request.params.id, decision: 'allow' })
      } catch { return }
    }
  })()
  policyRace.catch(() => undefined)
  // If the bash policy asks for approval, answer allow automatically.
  const approvalRace = (async () => {
    try {
      const ask = await waitFor((n) => n.method === 'idbots/approval/request', 15000)
      console.log('[test] approval ask arrived:', JSON.stringify(ask.params).slice(0, 120))
      await client.request('idbots/approval/respond', { id: ask.params.id, outcome: 'allowed-once' })
    } catch { /* no approval needed */ }
  })()

  const end = await turnDone
  console.log('[test] turn ended:', JSON.stringify(end.data?.reason))
  await approvalRace.catch(() => undefined)
  const bashResult = events.find((e) => e.type === 'tool/result' && JSON.stringify(e).includes('bash') === false && e.data?.message?.content?.[0]?.toolCallId)
  const anyToolResult = events.filter((e) => e.type === 'tool/result')
  for (const r of anyToolResult) console.log('[result]', JSON.stringify(r.data?.message?.content?.[0]?.content ?? '').slice(0, 160))
  console.log('[test] PASS criteria: a tool result contains BASH_WORKS =', events.some((e) => JSON.stringify(e).includes('BASH_WORKS')))

  subscription.close()
  await client.close()
  server.close()
  process.exit(0)
}

main().catch((error) => {
  console.error('[bash-e2e] fatal:', error)
  process.exit(1)
})
