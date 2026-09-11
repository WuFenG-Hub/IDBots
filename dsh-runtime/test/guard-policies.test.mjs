// guard-policies E2E (0.1.5): the composition mounts the two stock guard
// rails — dsh-repeat-tool-reminder and dsh-tool-call-timeout-policy. The mock
// gateway re-issues the identical grep call (LOOP_GREP); after the third
// consecutive repeat the reminder must appear in the next provider payload.
// The timeout policy has no model-facing surface (it only arms a deadline on
// tools that declare timeoutMs), so its coverage is composition presence plus
// a healthy turn end to end.
//
// Run: node test/guard-policies.test.mjs   (from dsh-runtime/)

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
  const { server, seen } = await startMockServer(48833)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-guard-'))
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-guard-ws-'))
  fs.writeFileSync(path.join(workspace, 'alpha.marker.txt'), 'xx NEEDLE_ALPHA yy\n')
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48833/v1', apiKeyEnv: 'GUARD_KEY',
      models: [{ id: 'mock-1', contextWindow: 32000 }],
    }],
    sections: [],
    workspace: { cwd: workspace },
  })
  const configJson = JSON.stringify(config)
  assert.ok(configJson.includes('dsh-repeat-tool-reminder'), 'generator mounts the repeat-tool reminder')
  assert.ok(configJson.includes('dsh-tool-call-timeout-policy'), 'generator mounts the tool-call timeout policy')
  const configPath = path.join(os.tmpdir(), `dsh-guard-${Date.now()}.json`)
  fs.writeFileSync(configPath, configJson)

  const client = runtimeClient({
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, GUARD_KEY: 'sk-guard', SPIKE_QUIET: '1' },
  })
  client.start()
  await client.initialize({ cwd: workspace, provider: 'mockgw', model: 'mock-1' })
  const sessionId = `guard-${Date.now().toString(36)}`

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
  // grep can require approval like any workspace tool; auto-allow.
  void (async () => {
    for (;;) {
      try {
        const ask = await waitFor((n) => n.method === 'idbots/approval/request', 60000, 'approval ask')
        await client.request('idbots/approval/respond', { id: ask.params.id, outcome: 'allowed-once' })
      } catch { return }
    }
  })().catch(() => undefined)

  const ended = waitFor((n) => n.method === 'session.event' && n.params.sessionId === sessionId
    && n.params.event.type === 'turn/end', 60000, 'turn end')
  await client.prompt(sessionId, [{ type: 'text', text: 'LOOP_GREP keep checking the needle' }])
  await ended

  // The mock re-issues grep with identical args; the guard's gentle reminder
  // (threshold 3) must ride into the provider payload after the third repeat.
  const reminded = seen.some((record) => JSON.stringify(record.body).includes('repeating the exact same tool call'))
  assert.ok(reminded, 'repeat-tool reminder reached the provider payload after the third identical call')
  const grepCalls = seen.filter((record) => JSON.stringify(record.body).includes('LOOP_GREP')).length
  assert.ok(grepCalls >= 4, `loop actually repeated (saw ${grepCalls} requests)`)
  console.log('PASS  repeat-tool-reminder fires on the third identical consecutive call')
  console.log('PASS  timeout-policy composed; turn completes end to end')

  await client.close()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(sessionRoot, { recursive: true, force: true })
  fs.rmSync(workspace, { recursive: true, force: true })
  fs.rmSync(configPath, { force: true })
  console.log('guard-policies.test.mjs: all assertions passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
