// Workspace instruction injection (AGENTS.md / CLAUDE.md) E2E.
//
// Verifies the mounted @deepseek-ai/dsh-agent-instructions plugin behaves like
// the DeepSeek Harness web UI: files discovered from the session cwd are
// rendered into a durable user-role baseline before the first model request,
// and sessions whose workspace has no instruction files stay uninjected.
//
// Scenarios:
//   A. cwd is a git repo root with AGENTS.md + CLAUDE.md → both injected,
//      AGENTS.md before CLAUDE.md, visible to the LLM request.
//   B. cwd is a git repo root with NO instruction files → no
//      agent-instructions message at all. (An own `.git` marker pins the
//      project root to the empty dir; without it the ancestor walk could
//      legitimately discover a parent repo's files — the host's TMPDIR sits
//      inside a git checkout.)
//   C. cwd is a subdirectory under a git root whose AGENTS.md lives at the
//      root → the root file is still discovered (root-to-cwd ancestor chain).
//
// dshHome is pinned to an empty temp dir so the user-global AGENTS.md of the
// host machine never leaks into the assertions.
//
// Run: node test/workspace-instructions.test.mjs   (from dsh-runtime/)

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

const AGENTS_CONTENT = 'Current AGENTS rule.\n'
const CLAUDE_CONTENT = 'Current CLAUDE rule.\n'
const ROOT_AGENTS_CONTENT = 'Root AGENTS rule for the ancestor chain.\n'

/** Collect every user/message event of one session from its JSONL log.
 *  Each session owns one `session.jsonl` whose header line carries the id;
 *  files for other sessions are skipped. */
const readSessionUserMessages = (sessionRoot, sessionId) => {
  const messages = []
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) scan(full)
      else if (entry.name.endsWith('.jsonl')) {
        const lines = fs.readFileSync(full, 'utf8').trimEnd().split('\n').filter((line) => line.length > 0)
        if (lines.length === 0) continue
        let header
        try { header = JSON.parse(lines[0]) } catch { continue }
        if (header?.id !== sessionId) continue
        for (const line of lines.slice(1)) {
          const event = JSON.parse(line)
          if (event.type !== 'user/message') continue
          messages.push(event.data ?? {})
        }
      }
    }
  }
  scan(sessionRoot)
  return messages
}

const instructionsTextOf = (messages) => {
  const blocks = []
  for (const message of messages) {
    if (message?.source?.kind !== 'agent-instructions') continue
    for (const block of message.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') blocks.push(block.text)
    }
  }
  return blocks.join('\n')
}

const main = async () => {
  const { server, seen } = await startMockServer(48830)
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-inst-sess-'))
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-inst-home-'))

  const workspaceA = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-inst-a-'))
  fs.mkdirSync(path.join(workspaceA, '.git'), { recursive: true })
  fs.writeFileSync(path.join(workspaceA, 'AGENTS.md'), AGENTS_CONTENT)
  fs.writeFileSync(path.join(workspaceA, 'CLAUDE.md'), CLAUDE_CONTENT)

  const workspaceB = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-inst-b-'))
  // Own root marker: the project root pins here, so the absence of
  // instruction files is what the assertions measure, not ancestor discovery.
  fs.mkdirSync(path.join(workspaceB, '.git'), { recursive: true })

  const workspaceC = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-inst-c-'))
  fs.mkdirSync(path.join(workspaceC, 'repo', '.git'), { recursive: true })
  fs.writeFileSync(path.join(workspaceC, 'repo', 'AGENTS.md'), ROOT_AGENTS_CONTENT)
  fs.mkdirSync(path.join(workspaceC, 'repo', 'sub'), { recursive: true })

  const config = generateRuntimeConfig({
    sessionRoot,
    providers: [{
      key: 'mockgw', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:48830/v1', apiKeyEnv: 'WSINST_KEY',
      models: [{ id: 'mock-1', contextWindow: 32768 }],
    }],
    sections: [],
    workspace: { cwd: workspaceA },
    workspaceInstructions: { dshHome },
  })
  const configPath = path.join(os.tmpdir(), `dsh-wsinst-${Date.now()}.json`)
  fs.writeFileSync(configPath, JSON.stringify(config))

  const client = runtimeClient({
    args: [path.join(runtimeDir, 'bin.mjs'), configPath],
    env: { ...process.env, WSINST_KEY: 'sk-wsinst', SPIKE_QUIET: '1' },
    requestTimeoutMs: 30000,
  })
  client.start()
  await client.initialize({ cwd: sessionRoot, provider: 'mockgw', model: 'mock-1' })

  const waiters = new Set()
  const subscription = client.subscribe()
  const pumping = (async () => {
    for (;;) {
      const notification = await subscription.next()
      for (const wait of waiters) wait(notification)
    }
  })()
  pumping.catch(() => {})

  const waitFor = (predicate, timeoutMs = 25000, what = 'notification') => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), timeoutMs)
    const wait = (payload) => {
      if (predicate(payload)) { clearTimeout(timer); waiters.delete(wait); resolve(payload) }
    }
    waiters.add(wait)
  })

  // Answer any policy/approval asks so tool-less text turns never stall.
  const autoAnswer = (method, respond) => {
    const race = (async () => {
      for (;;) {
        try {
          const request = await waitFor((n) => n.method === method, 60000)
          await client.request(respond.method, { id: request.params.id, ...respond.params })
        } catch { return }
      }
    })()
    race.catch(() => undefined)
  }
  autoAnswer('idbots/policy/request', { method: 'idbots/policy/respond', params: { decision: 'allow' } })
  autoAnswer('idbots/approval/request', { method: 'idbots/approval/respond', params: { outcome: 'allowed-once' } })

  const runTurn = async (sessionId, cwd) => {
    await client.request('session/ensure', { sessionId, provider: 'mockgw', model: 'mock-1', cwd })
    const turnDone = waitFor(
      (n) => n.method === 'session.event' && n.params?.sessionId === sessionId && n.params?.event?.type === 'turn/end',
      30000,
      `turn end ${sessionId}`,
    )
    await client.prompt(sessionId, [{ type: 'text', text: `PROBE:${sessionId}` }])
    const end = await turnDone
    return end?.params?.event?.data?.reason?.kind === 'completed'
  }

  const sessionA = `ws-inst-a-${Date.now().toString(36)}`
  const sessionB = `ws-inst-b-${Date.now().toString(36)}`
  const sessionC = `ws-inst-c-${Date.now().toString(36)}`
  record('session A turn completed', await runTurn(sessionA, workspaceA))
  record('session B turn completed', await runTurn(sessionB, workspaceB))
  record('session C turn completed', await runTurn(sessionC, path.join(workspaceC, 'repo', 'sub')))

  // Scenario A: both files injected, AGENTS.md before CLAUDE.md, content intact.
  const messagesA = readSessionUserMessages(sessionRoot, sessionA)
  const instructionsA = instructionsTextOf(messagesA)
  record('A: agent-instructions baseline present', /"kind":"agent-instructions"/.test(JSON.stringify(messagesA)))
  record('A: AGENTS.md injected', instructionsA.includes('Instructions from: AGENTS.md'))
  record('A: CLAUDE.md injected', instructionsA.includes('Instructions from: CLAUDE.md'))
  record('A: AGENTS.md content intact', instructionsA.includes(AGENTS_CONTENT.trim()))
  record('A: CLAUDE.md content intact', instructionsA.includes(CLAUDE_CONTENT.trim()))
  record('A: AGENTS.md precedes CLAUDE.md',
    instructionsA.indexOf('Instructions from: AGENTS.md') < instructionsA.indexOf('Instructions from: CLAUDE.md'))

  // Scenario B: empty workspace → nothing injected.
  const messagesB = readSessionUserMessages(sessionRoot, sessionB)
  record('B: no agent-instructions without instruction files',
    !instructionsTextOf(messagesB).includes('Instructions from:'))

  // Scenario C: ancestor chain — root AGENTS.md discovered from the sub-cwd.
  const messagesC = readSessionUserMessages(sessionRoot, sessionC)
  const instructionsC = instructionsTextOf(messagesC)
  record('C: root AGENTS.md discovered from sub-cwd', instructionsC.includes('Instructions from: AGENTS.md'))
  record('C: root AGENTS.md content intact', instructionsC.includes(ROOT_AGENTS_CONTENT.trim()))

  // The LLM actually saw the baseline: the mock gateway records every request.
  const probeRequests = seen.filter((r) => (r.body?.messages ?? []).some((m) =>
    typeof m.content === 'string' && m.content.includes('PROBE:')))
  const llmSawA = probeRequests.some((r) => JSON.stringify(r.body.messages).includes('Current AGENTS rule.'))
  record('LLM request carried the injected baseline', llmSawA)

  subscription.close()
  await client.close()
  server.close()
  fs.rmSync(configPath, { force: true })
  fs.rmSync(sessionRoot, { recursive: true, force: true })
  fs.rmSync(dshHome, { recursive: true, force: true })
  fs.rmSync(workspaceA, { recursive: true, force: true })
  fs.rmSync(workspaceB, { recursive: true, force: true })
  fs.rmSync(workspaceC, { recursive: true, force: true })

  const failed = results.filter((r) => !r.pass).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('[workspace-instructions] fatal:', error)
  process.exit(1)
})
