// Browser-use E2E (0.1.7): the experimental Playwright MCP provider mounts
// through the generator's browserUse option, connects one MCP server +
// headless Chromium per session inside agent/created, and the model's
// browser_navigate call round-trips to a real page snapshot.
//
// Requires a Chrome/Chromium executable — skipped cleanly when none is found
// (CI-less machines). Run: node test/browser-use.test.mjs   (from dsh-runtime/)

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

const CHROME_CANDIDATES = process.platform === 'darwin'
  ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
  : process.platform === 'win32'
    ? [process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe', process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
const chromePath = CHROME_CANDIDATES.find((p) => p && fs.existsSync(p))

const main = async () => {
  if (chromePath === undefined) {
    console.log('SKIP  no Chrome/Chromium executable found — browser-use E2E not applicable on this machine')
    return
  }
  const { server } = await startMockServer(48796)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-browser-'))
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48796/v1', apiKeyEnv: 'BROWSER_KEY',
      models: [{ id: 'mock-1', contextWindow: 32768 }],
    }],
    sections: [],
    browserUse: { mode: 'launch', headless: true, executablePath: chromePath },
  })
  assert.ok(config.some((e) => e.name === '@deepseek-ai/dsh-browser-use'), 'service mounted')
  assert.ok(config.some((e) => e.name === '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'), 'provider mounted')
  const configPath = path.join(os.tmpdir(), `dsh-browser-${Date.now()}.json`)
  fs.writeFileSync(configPath, JSON.stringify(config))

  const client = runtimeClient({
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, BROWSER_KEY: 'sk-browser', SPIKE_QUIET: '1' },
    // Heaviest composition in the suite (browser provider + MCP discovery);
    // under a loaded gate run the 10s default boot budget can time out.
    initializeTimeoutMs: 60000,
  })
  client.start()
  await client.initialize({ cwd: runtimeDir, provider: 'mockgw', model: 'mock-1' })
  const sessionId = `browser-${Date.now().toString(36)}`

  const events = []
  const waiters = new Set()
  const subscription = client.subscribe()
  const pumping = (async () => {
    for (;;) {
      const notification = await subscription.next()
      if (notification.method === 'session.event' && notification.params.sessionId === sessionId) {
        events.push(notification.params.event)
        for (const wait of waiters) wait(notification.params.event)
      }
    }
  })()
  pumping.catch(() => {})
  // The provider connects the MCP server + launches Chromium inside
  // agent/created, and the navigate call itself waits on a real page load —
  // both far slower than any other test's first call.
  const waitForEvent = (pred, ms = 120000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for event (${events.map((e) => e.type).join(',')})`)), ms)
    const wait = (event) => { if (pred(event)) { clearTimeout(timer); waiters.delete(wait); resolve(event) } }
    waiters.add(wait)
  })

  try {
    await client.prompt(sessionId, [{ type: 'text', text: 'CALL_BROWSER_NAV please' }])
    const navCall = await waitForEvent((e) => e.type === 'tool/call' && e.data?.name === 'mcp__playwright-mcp__browser_navigate')
    assert.ok(navCall, 'model issued the browser_navigate call')
    console.log('PASS  browser_navigate dispatched as mcp__playwright-mcp__*')
    const result = await waitForEvent((e) => e.type === 'tool/result' && e.data?.message?.toolCallId === navCall.data.callId)
    const resultText = JSON.stringify(result.data?.message ?? {})
    assert.ok(resultText.includes('BROWSER_SMOKE_OK'), 'page snapshot carries the marker text')
    console.log('PASS  browser_navigate returned the data: URL page snapshot')
    const end = await waitForEvent((e) => e.type === 'turn/end')
    assert.equal(end.data?.reason?.kind, 'completed', 'turn completed')
    console.log('PASS  turn completed after the browser call')
  } finally {
    subscription.close()
    // Bounded teardown: an initialize timeout can leave the runtime child
    // mid-boot holding its keep-alive socket, and a bare server.close(cb)
    // would then wait forever. Close live connections and cap the wait.
    await Promise.race([client.close(), new Promise((resolve) => setTimeout(resolve, 10000))]).catch(() => {})
    server.closeAllConnections?.()
    await Promise.race([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ])
    fs.rmSync(sessionRoot, { recursive: true, force: true })
    fs.rmSync(configPath, { force: true })
  }
  console.log('browser-use.test.mjs: all assertions passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
