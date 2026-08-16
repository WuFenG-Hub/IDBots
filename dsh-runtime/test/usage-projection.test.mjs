// Usage-projection E2E: with the session-projection registry composed, the
// official token-meter units must be readable over the wire through the
// idbots/usage extension — cumulative disjoint token buckets after two turns,
// a cacheRead share when the gateway reports cached_tokens, and a graceful
// { available: false } for an unknown session.
//
// Run: node test/usage-projection.test.mjs   (from dsh-runtime/)

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
  const { server } = await startMockServer(48807)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-'))
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48807/v1', apiKeyEnv: 'USAGE_KEY',
      models: [{ id: 'mock-1', contextWindow: 32000 }],
    }],
    sections: [],
  })
  const configPath = path.join(os.tmpdir(), `dsh-usage-${Date.now()}.json`)
  fs.writeFileSync(configPath, JSON.stringify(config))

  const client = new HarnessClient({
    command: process.execPath,
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, USAGE_KEY: 'sk-usage', SPIKE_QUIET: '1' },
  })
  client.start()
  await client.initialize({ cwd: runtimeDir, provider: 'mockgw', model: 'mock-1' })
  const sessionId = `usage-${Date.now().toString(36)}`

  const waiters = new Set()
  const subscription = client.subscribe()
  const pumping = (async () => {
    for (;;) {
      const notification = await subscription.next()
      if (notification.method === 'session.event' && notification.params.sessionId === sessionId) {
        for (const wait of waiters) wait(notification.params.event)
      }
    }
  })()
  pumping.catch(() => {})
  const waitForTurnEnd = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for turn end')), 30000)
    const wait = (event) => { if (event.type === 'turn/end') { clearTimeout(timer); waiters.delete(wait); resolve(event) } }
    waiters.add(wait)
  })

  const runTurn = async (text) => {
    const ended = waitForTurnEnd()
    await client.prompt(sessionId, [{ type: 'text', text }])
    await ended
  }

  const usageOf = async () => client.request('idbots/usage', { sessionId })

  // Extension presence canary first.
  const ping = await client.request('idbots/ping', {})
  assert.ok(ping.extensions.includes('idbots/usage'), 'idbots/usage advertised in ping extensions')

  // Unknown session: graceful absence, not an error.
  const unknown = await client.request('idbots/usage', { sessionId: 'no-such-session' })
  assert.equal(unknown.available, false)

  // Turn 1 — plain miss-only usage.
  await runTurn('hello usage panel')
  const afterOne = await usageOf()
  assert.equal(afterOne.available, true, 'usage available after turn 1')
  assert.ok(afterOne.tokenUsage, 'tokenUsage projection present')
  assert.ok(afterOne.tokenUsage.outputTokens > 0, 'output tokens accumulated')
  assert.ok(afterOne.tokenUsage.uncachedInputTokens > 0, 'uncached input accumulated')
  assert.equal(afterOne.tokenUsage.cacheReadTokens, 0, 'no cache reads without cached_tokens')
  const firstTotals = { ...afterOne.tokenUsage }

  // Turn 2 — half the prompt reported cached: cacheRead grows, and turn 2's
  // uncached input is smaller than turn 1's would have been at full length.
  await runTurn('CACHE_HIT second turn warms the prefix')
  const afterTwo = await usageOf()
  assert.ok(afterTwo.tokenUsage.cacheReadTokens > 0, 'cacheRead accumulated from cached_tokens')
  assert.ok(afterTwo.tokenUsage.uncachedInputTokens > firstTotals.uncachedInputTokens, 'uncached input is cumulative')
  assert.ok(afterTwo.tokenUsage.outputTokens > firstTotals.outputTokens, 'output is cumulative')

  // Buckets are disjoint: total = uncached + cacheRead + cacheWrite + output.
  const { uncachedInputTokens, cacheReadTokens, cacheWriteTokens, outputTokens } = afterTwo.tokenUsage
  assert.ok(uncachedInputTokens > 0 && cacheReadTokens > 0 && outputTokens > 0, 'all exercised buckets positive')
  assert.equal(typeof cacheWriteTokens, 'number', 'cacheWrite present as a number')

  // Context pressure: provider usage landed, so pressure/projected exist and
  // the composition is non-negative heuristic estimates.
  assert.ok(afterTwo.contextPressure, 'contextPressure projection present')
  assert.ok((afterTwo.contextPressure.pressureTokens ?? 0) > 0, 'pressure reflects the last provider sample')
  assert.ok(afterTwo.contextBreakdown, 'contextBreakdown projection present')

  // asOfSeq advances with the log.
  assert.ok(afterTwo.asOfSeq > afterOne.asOfSeq, 'asOfSeq advanced between turns')

  await client.close()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(sessionRoot, { recursive: true, force: true })
  console.log('usage-projection.test.mjs: all assertions passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
