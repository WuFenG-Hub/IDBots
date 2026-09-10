// fs-search E2E (0.1.5): the workspace composition mounts dsh-tool-fs-search,
// so the model-facing `glob` and `grep` tools run the packaged ripgrep binary
// through the subprocess seam (no system rg, no shell). The mock gateway
// issues the tool calls; the assertions read the tool/result events.
//
// Run: node test/fs-search.test.mjs   (from dsh-runtime/)

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
  const { server } = await startMockServer(48827)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fsearch-'))
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fsearch-ws-'))
  fs.writeFileSync(path.join(workspace, 'alpha.marker.txt'), 'first file\nxx NEEDLE_ALPHA yy\n')
  fs.mkdirSync(path.join(workspace, 'sub'))
  fs.writeFileSync(path.join(workspace, 'sub', 'beta.marker.txt'), 'second file\n')
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48827/v1', apiKeyEnv: 'FSEARCH_KEY',
      models: [{ id: 'mock-1', contextWindow: 32000 }],
    }],
    sections: [],
    workspace: { cwd: workspace },
  })
  const configJson = JSON.stringify(config)
  assert.ok(configJson.includes('tool-fs-search'), 'generator mounts the fs-search entry for workspace compositions')
  const configPath = path.join(os.tmpdir(), `dsh-fsearch-${Date.now()}.json`)
  fs.writeFileSync(configPath, configJson)

  const client = runtimeClient({
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, FSEARCH_KEY: 'sk-fsearch', SPIKE_QUIET: '1' },
  })
  client.start()
  // Session cwd (session.header.cwd) is the tools' workdir — pin it to the
  // fixture workspace, not the runtime repo.
  await client.initialize({ cwd: workspace, provider: 'mockgw', model: 'mock-1' })
  const sessionId = `fsearch-${Date.now().toString(36)}`

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
  // fs-search calls can require approval like any workspace tool; auto-allow.
  void (async () => {
    for (;;) {
      try {
        const ask = await waitFor((n) => n.method === 'idbots/approval/request', 60000, 'approval ask')
        await client.request('idbots/approval/respond', { id: ask.params.id, outcome: 'allowed-once' })
      } catch { return }
    }
  })().catch(() => undefined)
  const waitForTurnEnd = () => waitFor((n) => n.method === 'session.event' && n.params.sessionId === sessionId
    && n.params.event.type === 'turn/end', 30000, 'turn end')
  const toolResults = []
  waiters.add((n) => {
    if (n.method === 'session.event' && n.params.sessionId === sessionId && n.params.event.type === 'tool/result') {
      toolResults.push(JSON.stringify(n.params.event))
    }
  })
  const runTurn = async (text) => {
    const ended = waitForTurnEnd()
    await client.prompt(sessionId, [{ type: 'text', text }])
    await ended
  }

  // glob: the fixed argv runs `rg --files` with the model pattern; both
  // marker files must appear (workdir-relative paths).
  await runTurn('CALL_GLOB find the marker files')
  const globResult = toolResults.find((r) => r.includes('marker.txt'))
  assert.ok(globResult, 'glob tool result returned')
  assert.ok(globResult.includes('alpha.marker.txt'), 'glob lists the top-level marker file')
  assert.ok(globResult.includes('beta.marker.txt'), 'glob lists the nested marker file')
  console.log('PASS  glob runs packaged ripgrep and lists workdir-relative matches')

  // grep: the needle match must come back with its file and line content.
  await runTurn('CALL_GREP locate the needle')
  const grepResult = toolResults.find((r) => r.includes('NEEDLE_ALPHA'))
  assert.ok(grepResult, 'grep tool result carries the needle match')
  assert.ok(grepResult.includes('alpha.marker.txt'), 'grep match names its file')
  console.log('PASS  grep runs packaged ripgrep and returns the matched line')

  await client.close()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(sessionRoot, { recursive: true, force: true })
  fs.rmSync(workspace, { recursive: true, force: true })
  fs.rmSync(configPath, { force: true })
  console.log('fs-search.test.mjs: all assertions passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
