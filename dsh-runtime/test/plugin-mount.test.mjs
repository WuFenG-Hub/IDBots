// External plugin mount E2E: a plugin package outside dsh-runtime/ (the
// plugin-install flow's absolute-path entry shape — entry FILE, not the
// package dir) loads inside the composed runtime and takes effect. The
// fixture registers a prompt section; the marker must reach the provider.
//
// Run: node test/plugin-mount.test.mjs   (from dsh-runtime/)

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

const results = []
const record = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const main = async () => {
  const { server, seen } = await startMockServer(48792)

  // Simulate the plugin directory shape: a package with package.json + entry
  // file lives OUTSIDE the runtime tree (like userData/dsh-plugins).
  const pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mount-'))
  const pkgDir = path.join(pluginsDir, 'node_modules', '@deepseek-ai', 'dsh-sample-section')
  fs.mkdirSync(pkgDir, { recursive: true })
  fs.copyFileSync(path.join(runtimeDir, 'test/fixtures/sample-plugin/index.mjs'), path.join(pkgDir, 'index.mjs'))
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-sample-section',
    version: '1.0.0',
    main: 'index.mjs',
  }, null, 2))
  // The entry a resolver would produce: the package's ENTRY FILE.
  const entryFile = path.join(pkgDir, 'index.mjs')
  record('fixture plugin package staged outside the runtime tree', fs.existsSync(entryFile))

  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mount-sess-'))
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48792/v1', apiKeyEnv: 'MOUNT_KEY',
      models: [{ id: 'mock-1', contextWindow: 32768 }],
    }],
    sections: [],
    extraEntries: [{ id: 'plugin-dsh-sample-section', name: entryFile, config: {} }],
  })
  const configPath = path.join(os.tmpdir(), `dsh-mount-${Date.now()}.json`)
  fs.writeFileSync(configPath, JSON.stringify(config))

  const client = runtimeClient({
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, MOUNT_KEY: 'sk-mount', SPIKE_QUIET: '1' },
  })
  client.start()
  await client.initialize({ cwd: runtimeDir, provider: 'mockgw', model: 'mock-1' })
  const sessionId = `mount-${Date.now().toString(36)}`

  const events = []
  const subscription = client.subscribe()
  const pumping = (async () => {
    for (;;) {
      const notification = await subscription.next()
      if (notification.method === 'session.event' && notification.params.sessionId === sessionId) {
        events.push(notification.params.event)
      }
    }
  })()
  pumping.catch(() => {})

  const ended = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('turn never ended')), 30000)
    const interval = setInterval(() => {
      if (events.some((e) => e.type === 'turn/end')) {
        clearInterval(interval)
        clearTimeout(timer)
        resolve()
      }
    }, 100)
  })
  await client.prompt(sessionId, [{ type: 'text', text: 'mount test' }])
  await ended

  record('runtime boots and completes a turn with the external plugin', true)
  const markerRequest = seen.filter((r) => JSON.stringify(r.body?.messages ?? []).includes('SAMPLE_PLUGIN_MARKER')).at(-1)
  record('external plugin took effect (prompt section reached the provider)', Boolean(markerRequest))

  subscription.close()
  await client.close()
  server.close()
  fs.rmSync(sessionRoot, { recursive: true, force: true })
  fs.rmSync(pluginsDir, { recursive: true, force: true })
  fs.rmSync(configPath, { force: true })
  record('clean close', true)

  const failed = results.filter((r) => !r.pass).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('[mount-test] fatal:', error)
  process.exit(1)
})
