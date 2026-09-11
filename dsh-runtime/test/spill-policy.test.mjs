// Spill-policy + tool-result-pruner E2E (0.1.5).
//
// Workspace compositions mount the spill trio under idbots-tool-result-shaping's
// hard cap: mid-size all-text tool results (8–20KB) spill to a session-scoped
// file with the ORIGINAL text recoverable (shaping never engages), while
// oversized results (>20KB) still take the shaping trim first and spill the
// trimmed text — history stays bounded either way, and the durable entry
// carries a "Full formatted result stored at:" notice with the spill path.
//
// Run: node test/spill-policy.test.mjs   (from dsh-runtime/)

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

const SPILL_NOTICE = 'Full formatted result stored at:'

const main = async () => {
  const { server, seen } = await startMockServer(48813)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spill-'))
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spill-work-'))
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48813/v1', apiKeyEnv: 'SPILL_KEY',
      models: [{ id: 'mock-1', contextWindow: 64000 }],
    }],
    sections: [],
    workspace: { cwd: workdir },
    extraEntries: [
      { id: 'idbots-mid-tool', name: path.join(runtimeDir, 'test/fixtures/mid-tool.mjs') },
      { id: 'idbots-big-tool', name: path.join(runtimeDir, 'test/fixtures/big-tool.mjs') },
    ],
  })
  // Composition shape: spill trio mounted, pruner present, policy cap under
  // the shaping budget (default 8192 < 20000).
  assert.ok(config.find((e) => e.id === 'spill-local'), 'spill-local mounted')
  assert.ok(config.find((e) => e.id === 'spill-policy'), 'spill-policy mounted')
  assert.equal(config.find((e) => e.id === 'spill-policy')?.config?.maxInlineBytes, 8192, 'default spill cap')
  assert.ok(config.find((e) => e.id === 'tool-result-pruner'), 'tool-result pruner mounted')
  const configPath = path.join(os.tmpdir(), `dsh-spill-${Date.now()}.json`)
  fs.writeFileSync(configPath, JSON.stringify(config))

  const client = runtimeClient({
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, SPILL_KEY: 'sk-spill', SPIKE_QUIET: '1' },
  })
  client.start()
  await client.initialize({ cwd: workdir, provider: 'mockgw', model: 'mock-1' })
  const sessionId = `spill-${Date.now().toString(36)}`

  const events = []
  const waiters = new Set()
  const subscription = client.subscribe()
  const pumping = (async () => {
    for (;;) {
      const notification = await subscription.next()
      if (notification.method === 'session.event' && notification.params.sessionId === sessionId) {
        const event = notification.params.event
        events.push(event)
        for (const wait of waiters) wait(event)
      }
    }
  })()
  pumping.catch(() => {})
  const waitForEvent = (pred, ms = 30000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for event')), ms)
    const wait = (event) => { if (pred(event)) { clearTimeout(timer); waiters.delete(wait); resolve(event) } }
    waiters.add(wait)
  })

  const runTurn = async (text) => {
    const ended = waitForEvent((e) => e.type === 'turn/end')
    await client.prompt(sessionId, [{ type: 'text', text }])
    await ended
  }
  const toolResultFor = (toolName) => {
    const call = events.find((e) => e.type === 'tool/call' && e.data?.name === toolName)
    return call ? events.find((e) => e.type === 'tool/result' && JSON.stringify(e.data?.message ?? {}).includes(call.data.callId)) : undefined
  }
  const resultText = (result) => {
    // tool-result content nests the payload one level down (content[0] carries
    // the toolCallId wrapper) — collect text blocks at any depth.
    const texts = []
    const walk = (node) => {
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (node && typeof node === 'object') {
        if (node.type === 'text' && typeof node.text === 'string') texts.push(node.text)
        else Object.values(node).forEach(walk)
      }
    }
    walk(result?.data?.message?.content ?? [])
    return texts.join('')
  }
  const spillFiles = () => {
    const root = path.join(sessionRoot, 'spill')
    const found = []
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else found.push(full)
      }
    }
    if (fs.existsSync(root)) walk(root)
    return found
  }

  // ---- Case 1: 15KB all-text result — spill fires on the ORIGINAL ---------
  await runTurn('CALL_MID_TOOL please')
  const midResult = toolResultFor('mid_output_tool')
  assert.ok(midResult, 'mid tool executed through the real path')
  const midText = resultText(midResult)
  assert.ok(midText.includes(SPILL_NOTICE), `mid result carries the spill notice (got ${midText.length} chars)`)
  assert.ok(midText.length < 10000, `mid result bounded in history (${midText.length} chars)`)
  assert.ok(!midText.includes('tool result trimmed'), 'shaping did not engage under the 20K cap')
  const midSpill = spillFiles().map((f) => ({ f, text: fs.readFileSync(f, 'utf8') }))
    .find((s) => s.text.includes('MID-BLOB-START'))
  assert.ok(midSpill, 'mid spill file exists under the session spill root')
  assert.ok(midSpill.text.includes('MID-BLOB-END'), 'spill file retains the FULL original text')
  assert.ok(midSpill.text.includes('y'.repeat(1000)), 'spill file retains the untrimmed blob')
  assert.ok(!midSpill.text.includes('tool result trimmed'), 'original text spilled without shaping loss')

  // ---- Case 2: 60KB result — shaping trims first, spill keeps the ladder --
  await runTurn('CALL_BIG_TOOL please')
  const bigResult = toolResultFor('big_output_tool')
  assert.ok(bigResult, 'big tool executed through the real path')
  const bigText = resultText(bigResult)
  assert.ok(bigText.includes(SPILL_NOTICE), `big result carries the spill notice (got ${bigText.length} chars)`)
  assert.ok(bigText.length < 10000, `big result bounded in history (${bigText.length} chars)`)
  const bigSpill = spillFiles().map((f) => ({ f, text: fs.readFileSync(f, 'utf8') }))
    .find((s) => s.text.includes('BIG-BLOB-START'))
  assert.ok(bigSpill, 'big spill file exists under the session spill root')
  assert.ok(bigSpill.text.includes('tool result trimmed'), 'oversize spill retains the shaped 20K text (ladder)')
  assert.ok(bigSpill.text.length < 25000, 'oversize spill is the shaped text, not the 60K original')

  // ---- Provider requests stay bounded: the 60K blob never goes upstream ---
  const toolMessages = seen
    .flatMap((r) => r.body?.messages ?? [])
    .filter((m) => m?.role === 'tool')
  assert.ok(toolMessages.length >= 2, 'tool results reached follow-up requests')
  const biggest = Math.max(...toolMessages.map((m) => JSON.stringify(m).length))
  assert.ok(biggest < 30000, `no oversized tool message upstream (largest ${biggest} chars)`)

  await client.close()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(sessionRoot, { recursive: true, force: true })
  fs.rmSync(workdir, { recursive: true, force: true })
  fs.rmSync(configPath, { force: true })
  console.log('spill-policy.test.mjs: all assertions passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
