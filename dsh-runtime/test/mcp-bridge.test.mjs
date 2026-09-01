// User MCP servers E2E: a generator-declared MCP server (stdio transport)
// connects through dsh-mcp-client, its tools register as mcp__<name>__<tool>,
// and a model-issued call round-trips to the real MCP server. Also checks the
// generator's entry shape (transport mapping, sanitization, skipping).
//
// Run: node test/mcp-bridge.test.mjs   (from dsh-runtime/)

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

// ---- generator shape checks ------------------------------------------------

const genConfig = generateRuntimeConfig({
  sessionRoot: '/tmp/x',
  providers: [{ key: 'p', apiFormat: 'openai', baseUrl: 'http://x/v1', apiKeyEnv: 'K', models: [{ id: 'm', contextWindow: 8 }] }],
  mcpServers: [
    { name: 'echo', transportType: 'stdio', command: 'node', args: ['s.js'], env: { T: '1' } },
    { name: 'web rocks!', transportType: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer t' } },
    { name: 'broken', transportType: 'stdio' },
    { name: 'broken-http', transportType: 'sse' },
    { name: '', transportType: 'stdio', command: 'node' },
  ],
})
const mcp = genConfig.filter((e) => e.name === '@deepseek-ai/dsh-mcp-client')
record('stdio server maps to a dsh-mcp-client entry',
  mcp.length === 2 && mcp[0].id === 'mcp-echo'
  && mcp[0].config.transport === 'stdio' && mcp[0].config.serverName === 'echo'
  && mcp[0].config.command === 'node' && JSON.stringify(mcp[0].config.args) === '["s.js"]'
  && mcp[0].config.env?.T === '1')
record('http/sse server maps to streamable-http with a sanitized unique name',
  mcp[1].config.transport === 'streamable-http' && mcp[1].config.serverName === 'web-rocks-'
  && mcp[1].config.url === 'http://127.0.0.1:9/mcp' && mcp[1].config.headers?.Authorization === 'Bearer t')
record('invalid servers are skipped, not fatal',
  !JSON.stringify(mcp).includes('broken'))

// ---- wire E2E: real stdio MCP server through the runtime -------------------

const main = async () => {
  const { server, seen } = await startMockServer(48795)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mcp-'))
  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48795/v1', apiKeyEnv: 'MCP_KEY',
      models: [{ id: 'mock-1', contextWindow: 32768 }],
    }],
    sections: [],
    mcpServers: [{
      name: 'echo',
      transportType: 'stdio',
      command: process.execPath,
      args: [path.join(runtimeDir, 'test/fixtures/mcp-echo-server.mjs')],
    }],
  })
  const configPath = path.join(os.tmpdir(), `dsh-mcp-${Date.now()}.json`)
  fs.writeFileSync(configPath, JSON.stringify(config))

  const client = runtimeClient({
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, MCP_KEY: 'sk-mcp', SPIKE_QUIET: '1' },
  })
  client.start()
  await client.initialize({ cwd: runtimeDir, provider: 'mockgw', model: 'mock-1' })
  const sessionId = `mcp-${Date.now().toString(36)}`

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

  // Give the stdio MCP server a moment to connect and register its tools at
  // composition boot (activation awaits listTools before the first turn).
  await new Promise((resolve) => setTimeout(resolve, 1500))

  const turnEnd = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for turn/end')), 30000)
    const pumpLocal = setInterval(() => {
      if (events.some((e) => e.type === 'turn/end' && e.data?.turn === 1)) {
        clearInterval(pumpLocal)
        clearTimeout(timer)
        resolve()
      }
    }, 100)
  })
  await client.prompt(sessionId, [{ type: 'text', text: 'CALL_MCP_TOOL please' }])
  await turnEnd

  const mcpResult = events.find((e) => e.type === 'tool/result' && JSON.stringify(e).includes('MCP-ECHO'))
  record('model call to mcp__echo__echo reaches the real MCP server', Boolean(mcpResult))
  const followUp = seen.filter((r) => JSON.stringify(r.body?.messages ?? []).includes('MCP-ECHO')).at(-1)
  record('MCP result returns to the model in the next request', Boolean(followUp))

  subscription.close()
  await client.close()
  server.close()
  fs.rmSync(sessionRoot, { recursive: true, force: true })
  fs.rmSync(configPath, { force: true })
  record('clean close', true)

  const failed = results.filter((r) => !r.pass).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('[mcp-test] fatal:', error)
  for (const r of results.filter((x) => !x.pass)) console.log(`FAIL  ${r.name}`)
  process.exit(1)
})
