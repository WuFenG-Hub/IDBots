// bin.mjs parent-death self-clean (2026-09-21 A2A incident).
//
// The runtime's JSON-RPC stdin EOFs when the spawning Electron main process
// dies without closing the runtime (crash, SIGKILL, force-quit). bin.mjs used
// to keep the process alive on its keepalive interval regardless, so the
// orphaned runtime held every session write lock (flock) forever — the next
// app instance then wedged on `session "<id>" is already owned by an active
// write handle` for each of those sessions.
//
// Fix under test: bin.mjs disposes the root context and exits on stdin EOF.
//
// Run: node test/bin-orphan-exit.test.mjs   (from dsh-runtime/)

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateRuntimeConfig } from '../lib/generate-runtime-config.mjs'
import { startMockServer } from './fixtures/mock-openai.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const runtimeDir = path.resolve(here, '..')
const PORT = 48797

const main = async () => {
  const { server } = await startMockServer(PORT)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-orphan-'))
  let child = null
  try {
    const config = generateRuntimeConfig({
      sessionRoot,
      providers: [
        {
          key: 'mockgw', apiFormat: 'openai', baseUrl: `http://127.0.0.1:${PORT}/v1`, apiKeyEnv: 'ORPHAN_KEY',
          models: [{ id: 'mock-1', contextWindow: 32768 }],
        },
      ],
      sections: [],
    })
    const configPath = path.join(sessionRoot, 'cordis.orphan.json')
    fs.writeFileSync(configPath, JSON.stringify(config))

    child = spawn(process.execPath, [path.join(runtimeDir, 'bin.mjs'), configPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ORPHAN_KEY: 'sk-orphan', SPIKE_QUIET: '1' },
    })
    let stderrBuf = ''
    child.stderr.on('data', (chunk) => { stderrBuf += chunk })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`runtime did not boot; stderr: ${stderrBuf.slice(-500)}`)), 30_000)
      child.stderr.on('data', function onData(chunk) {
        if (stderrBuf.includes('[idbots-dsh-runtime] booted')) {
          clearTimeout(timer)
          resolve()
        }
      })
      child.on('exit', (code) => reject(new Error(`runtime exited before boot (code ${code}); stderr: ${stderrBuf.slice(-500)}`)))
    })

    // Parent death delivers stdin EOF; the runtime must dispose and exit.
    const exited = new Promise((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }))
    })
    child.stdin.end()
    const result = await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('runtime survived stdin EOF (orphan leak)')), 25_000)),
    ])
    assert.equal(result.signal, null, `expected a clean exit, got signal ${result.signal}`)
    assert.equal(result.code, 0, `expected exit code 0, got ${result.code}`)
    child = null
    console.log('PASS  stdin EOF (parent death) disposes the runtime and exits 0')
  } finally {
    if (child) child.kill('SIGKILL')
    server.close()
    fs.rmSync(sessionRoot, { recursive: true, force: true })
  }
}

main().then(
  () => { console.log('\n1/1 passed') },
  (error) => { console.error(`FAIL  ${error?.message ?? error}`); process.exit(1) },
)
