// Browser automation / computer use mount at composition scope (runtime-
// wide). A bot that opts in must never leak those tools to sessions whose
// bot did not: the turn hub keys runtime slots by provider + automation
// combo (dshRuntimeKeyOf), routes opted-in sessions onto their own runtime
// process, and re-pins a session onto the clean slot on the first turn
// after the toggle goes off — no app restart needed.
//
// Requires: npm run compile:electron + dsh-runtime/node_modules installed.
// The automation session launches a real headless Chromium (agent/created),
// so the integration half skips cleanly when no Chrome/Chromium is found.

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = Module.createRequire(import.meta.url)
const here = import.meta.dirname
const runtimeDir = path.resolve(here, '..', 'dsh-runtime')
const runtimeReady = fs.existsSync(path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-sdk-client'))

const CHROME_CANDIDATES = process.platform === 'darwin'
  ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
  : process.platform === 'win32'
    ? [process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe', process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
const chromePath = CHROME_CANDIDATES.find((p) => p && fs.existsSync(p))

function loadModules() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-autoslot-${name}`),
        },
      }
    }
    return originalLoad.apply(this, arguments)
  }
  try {
    return require('../dist-electron/main/libs/coworkDshTurn.js')
  } finally {
    Module._load = originalLoad
  }
}

const callbacks = () => ({
  onMessage: () => `m-${Math.random().toString(36).slice(2)}`,
  onMessageUpdate: () => undefined,
  onMessageFinalize: () => undefined,
  onUsage: () => undefined,
  onApprovalRequest: () => undefined,
  onApprovalCancelled: () => undefined,
})

test('dshRuntimeKeyOf bundles the automation combo into the slot key', () => {
  const { dshRuntimeKeyOf, dshRuntimeConfigFileName } = loadModules()
  // Legacy: no flags / both off keeps the bare provider key (existing runtime
  // ids and config files are untouched by the split).
  assert.equal(dshRuntimeKeyOf({ key: 'deepseek' }), 'deepseek')
  assert.equal(dshRuntimeKeyOf({ key: 'deepseek' }, { browser: false, computer: false }), 'deepseek')
  // Opted-in combos get their own slot — and therefore their own process.
  assert.equal(dshRuntimeKeyOf({ key: 'deepseek' }, { browser: true, computer: false }), 'deepseek.auto-b')
  assert.equal(dshRuntimeKeyOf({ key: 'deepseek' }, { browser: false, computer: true }), 'deepseek.auto-c')
  assert.equal(dshRuntimeKeyOf({ key: 'deepseek' }, { browser: true, computer: true }), 'deepseek.auto-bc')
  // Every key survives the config-file sanitizer distinctly.
  const names = ['deepseek', 'deepseek.auto-b', 'deepseek.auto-c', 'deepseek.auto-bc']
    .map((k) => dshRuntimeConfigFileName(k))
  assert.equal(new Set(names).size, 4)
  assert.ok(names[1].includes('auto-b'))
})

test('an opted-in bot gets its own runtime; the toggle re-pins on the next turn', {
  skip: !runtimeReady
    ? 'dsh-runtime/node_modules not installed'
    : (chromePath ? false : 'no Chrome/Chromium executable found'),
}, async () => {
  const { DshTurnHub, dshRuntimeConfigFileName } = loadModules()
  const { startMockServer } = await import(path.join(runtimeDir, 'test', 'fixtures', 'mock-openai.mjs'))
  const { server } = await startMockServer(48815)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-autoslot-'))
  const logs = []
  // Per-bot switch stand-in: only the 'cowork-auto' session's bot opted in.
  let autoOptedIn = true
  const hub = new DshTurnHub({
    runtimeDir,
    sessionRoot,
    browserAutomationProvider: (sessionId) => (sessionId === 'cowork-auto' && autoOptedIn
      ? { mode: 'launch', headless: true, executablePath: chromePath }
      : undefined),
    log: (level, message, detail) => logs.push({ level, message, detail: detail ?? {} }),
  })
  const route = {
    key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48815/v1',
    apiKey: 'sk-a', model: 'mock-1',
  }
  const runTurn = (coworkSessionId, dshSessionId) => hub.runTurn({
    sessionId: coworkSessionId, dshSessionId, prompt: 'hello', provider: route,
    sections: [{ name: 'idbots:base', order: 0, text: 'You are Alice.' }],
    callbacks: callbacks(),
  })
  const readConfig = (runtimeId) => JSON.parse(
    fs.readFileSync(path.join(sessionRoot, dshRuntimeConfigFileName(runtimeId)), 'utf8'),
  )
  const hasBrowserBackend = (config) =>
    config.some((entry) => String(entry?.name ?? '').includes('browser-use'))

  try {
    const outAuto = await runTurn('cowork-auto', 'auto-bot')
    assert.notEqual(outAuto.kind, 'error', `opted-in turn failed: ${JSON.stringify(outAuto).slice(0, 240)}`)
    const outClean = await runTurn('cowork-clean', 'clean-bot')
    assert.notEqual(outClean.kind, 'error', `clean turn failed: ${JSON.stringify(outClean).slice(0, 240)}`)

    assert.equal(hub.runtimeSlotCount, 2, 'opted-in and clean sessions must not share one runtime')
    assert.ok(hasBrowserBackend(readConfig('mockgw.auto-b')), 'the automation slot mounts the browser backend')
    assert.ok(!hasBrowserBackend(readConfig('mockgw')), 'the shared provider slot must stay free of browser tools')

    // Toggle off: the very next turn re-pins the session onto the clean slot.
    autoOptedIn = false
    const outOff = await runTurn('cowork-auto', 'auto-bot')
    assert.notEqual(outOff.kind, 'error', `post-toggle turn failed: ${JSON.stringify(outOff).slice(0, 240)}`)
    assert.ok(
      logs.some((l) => l.message === 'dshTurnHub.disposeSession'
        && l.detail?.dshSessionId === 'auto-bot'
        && l.detail?.runtime === 'mockgw.auto-b'),
      'leaving the automation slot must dispose the session there before re-pinning',
    )
    assert.ok(!hasBrowserBackend(readConfig('mockgw')), 'the clean slot stays free of browser tools after the re-pin')
  } finally {
    await hub.close().catch(() => undefined)
    server.close()
    fs.rmSync(sessionRoot, { recursive: true, force: true })
  }
})
