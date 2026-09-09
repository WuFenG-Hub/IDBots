// Runtime config generator: OpenCode Go gateway routes carry the
// x-opencode-session session header.
//
// The gateway refuses header-less requests ("Request is missing
// x-opencode-session and cannot be routed efficiently", 400
// MissingSessionID — see https://opencode.ai/docs/go/#where-can-i-use-it).
// The app's own request builders inject the header at the main/renderer
// layer (opencodeGatewayHeaders.ts), but CoWork turns ride the embedded
// dsh-runtime, whose pi-ai routes only send headers configured ON the
// provider profile — so gateway-bound routes must carry a `headers` entry
// in the generated composition.
//
// The value must be STABLE per route, not random: the serialized config
// feeds dshConfigChangedKeys() restart comparisons, and a fresh uuid on
// every generation would flap the shared runtime. The id is therefore an
// RFC 4122 v5 uuid derived from the route key (same trade the DSH CLI's
// settings-layer fix made with its fixed session uuid).
//
// Plus a REAL boot smoke (same harness as dshRuntimeGlmResponsesBoot):
// unit assertions cannot see dsh-llm-pi-ai's profile validation
// (assertValidHeaders rejects shapes fetch cannot send) — only an actual
// plugin load can prove the headers field survives it.

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtimeBin = path.join(worktreeRoot, 'dsh-runtime', 'bin.mjs')
const generatorUrl = pathToFileURL(path.join(worktreeRoot, 'dsh-runtime', 'lib', 'generate-runtime-config.mjs')).href
const hasRuntime = existsSync(runtimeBin)
  && existsSync(path.join(worktreeRoot, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai'))

const { generateRuntimeConfig } = await import(generatorUrl)

const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const opencodeRoute = (over = {}) => ({
  key: 'opencode',
  apiFormat: 'openai',
  baseUrl: 'https://opencode.ai/zen/go/v1',
  apiKeyEnv: 'IDBOTS_DSH_KEY_OPENCODE',
  models: [{ id: 'deepseek-v4-flash', contextWindow: 1_000_000 }],
  ...over,
})

const entryById = (config, id) => config.find((e) => e.id === id)
const piAiProviders = (config) => entryById(config, 'llm-pi-ai').config.providers

test('gateway-bound route carries a stable v5 x-opencode-session header', () => {
  const providers = piAiProviders(generateRuntimeConfig({
    sessionRoot: '/tmp/dsh-opencode-header-test',
    providers: [opencodeRoute()],
  }))
  const header = providers.opencode?.headers?.['x-opencode-session']
  assert.match(header, UUID_V5, 'header must be a valid RFC 4122 v5 uuid')

  // Deterministic per route: regenerating the config must yield the same id
  // (and byte-identical JSON), or dshConfigChangedKeys() would see a change
  // on every ensureRuntime() and restart the shared runtime pointlessly.
  const again = generateRuntimeConfig({
    sessionRoot: '/tmp/dsh-opencode-header-test',
    providers: [opencodeRoute()],
  })
  assert.equal(piAiProviders(again).opencode.headers['x-opencode-session'], header)
  assert.equal(JSON.stringify(again), JSON.stringify(generateRuntimeConfig({
    sessionRoot: '/tmp/dsh-opencode-header-test',
    providers: [opencodeRoute()],
  })))
})

test('different route keys derive different session ids', () => {
  const providers = piAiProviders(generateRuntimeConfig({
    sessionRoot: '/tmp/dsh-opencode-header-test',
    providers: [opencodeRoute(), opencodeRoute({ key: 'opencode-second' })],
  }))
  assert.match(providers.opencode.headers['x-opencode-session'], UUID_V5)
  assert.match(providers['opencode-second'].headers['x-opencode-session'], UUID_V5)
  assert.notEqual(
    providers.opencode.headers['x-opencode-session'],
    providers['opencode-second'].headers['x-opencode-session'],
  )
})

test('non-gateway bases get no session header; gateway subdomains still do', () => {
  const providers = piAiProviders(generateRuntimeConfig({
    sessionRoot: '/tmp/dsh-opencode-header-test',
    providers: [
      opencodeRoute({ key: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }),
      // Subdomain of the gateway host: still the gateway (mirrors the
      // app-side isOpenCodeGoBaseUrl predicate).
      opencodeRoute({ key: 'oc-sub', baseUrl: 'https://api.opencode.ai/zen/go/v1' }),
      // Suffix-spoofed host is NOT the gateway.
      opencodeRoute({ key: 'lookalike', baseUrl: 'https://opencode.ai.evil.example/v1' }),
    ],
  }))
  assert.equal(providers.zhipu.headers, undefined, 'unrelated provider must stay header-free')
  assert.match(providers['oc-sub'].headers['x-opencode-session'], UUID_V5)
  assert.equal(providers.lookalike.headers, undefined, 'host suffix spoof must not match')
})

test('native deepseek route is untouched (never a pi-ai route, no headers)', () => {
  const config = generateRuntimeConfig({
    sessionRoot: '/tmp/dsh-opencode-header-test',
    providers: [
      opencodeRoute(),
      {
        key: 'deepseek-official',
        apiFormat: 'responses',
        baseUrl: 'https://api.deepseek.com',
        apiKeyEnv: 'IDBOTS_DSH_API_KEY',
        native: true,
        models: [{ id: 'deepseek-v4-pro', contextWindow: 1_000_000 }],
      },
    ],
  })
  const providers = piAiProviders(config)
  assert.equal(providers.deepseek, undefined)
  assert.match(providers.opencode.headers['x-opencode-session'], UUID_V5)
})

test('generated headers field survives REAL dsh-llm-pi-ai plugin load', { skip: !hasRuntime && 'dsh-runtime not installed' }, async () => {
  const config = generateRuntimeConfig({
    sessionRoot: '/tmp/dsh-opencode-header-test',
    providers: [opencodeRoute()],
  })
  const sessionRoot = mkdtempSync(path.join(tmpdir(), 'dsh-opencode-boot-smoke-'))
  const configPath = path.join(sessionRoot, 'runtime-config.json')
  writeFileSync(configPath, JSON.stringify(config, null, 2))

  const child = execFile(process.execPath, [runtimeBin, configPath], {
    env: { ...process.env, IDBOTS_DSH_KEY_OPENCODE: 'smoke-credential' },
    timeout: 0,
  })
  let stderr = ''
  child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
  let exited = null
  child.on('exit', (code) => { exited = code })

  // Plugin load happens at boot, before the JSON-RPC loop: a rejected config
  // (assertValidHeaders on the headers field, wrong shape, …) exits within
  // seconds. Stay-alive past the window means the plugin tree — including
  // the gateway route's headers profile — loaded cleanly.
  await new Promise((resolve) => setTimeout(resolve, 12_000))
  if (exited !== null) {
    assert.fail(`runtime exited with code ${exited} during boot — plugin load rejected the opencode session headers profile:\n${stderr.slice(-1200)}`)
  }
  child.kill('SIGKILL')
})
