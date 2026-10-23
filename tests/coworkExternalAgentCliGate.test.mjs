// External agent CLI policy gate (2026-10-23 cursor-agent TCC incident):
// agent CLIs (cursor-agent, claude, codex, …) self-drive filesystem walks
// whose TCC prompts macOS attributes to THIS app, producing unanswerable
// "wants to access other apps' data" dialogs. The gate asks once per
// invocation in attended default sessions, auto-denies in unattended
// (autoApprove) sessions, and skips acceptEdits/bypassPermissions exactly
// like the delete policy.
//
// Requires: pnpm run compile:electron.

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'

const require = Module.createRequire(import.meta.url)

function loadRunner() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => `/tmp/idbots-agent-cli-gate-${name}`,
        },
      }
    }
    return originalLoad.apply(this, arguments)
  }
  try {
    return require('../dist-electron/main/libs/coworkRunner.js')
  } finally {
    Module._load = originalLoad
  }
}

class MinimalStore {
  getSession() { return null }
  getConfig() { return {} }
}

const AGENT_COMMANDS = [
  ['cursor-agent chat -p "summarize"', 'cursor-agent'],
  ['~/.local/bin/cursor-agent chat', 'cursor-agent'],
  ['claude -p "hello"', 'claude'],
  ['codex exec "task"', 'codex'],
  ['gemini -p "q"', 'gemini'],
  ['aider --message "x"', 'aider'],
  ['opencode run "x"', 'opencode'],
  ['npx cursor-agent@latest chat', 'cursor-agent'],
  ['bunx codex', 'codex'],
  ['pnpm dlx cursor-agent chat', 'cursor-agent'],
  ['bash -c "cursor-agent chat"', 'cursor-agent'],
  ['FOO=1 sudo cursor-agent chat', 'cursor-agent'],
  ['env FOO=1 cursor-agent chat', 'cursor-agent'],
  ['ls -la && cursor-agent chat', 'cursor-agent'],
  ['cursor-agent.exe chat', 'cursor-agent'],
]

const SAFE_COMMANDS = [
  'ls -la',
  'echo "use cursor-agent for that"',
  'ls cursor-agent',
  'git commit -m "fix cursor-agent runtime discovery"',
  'cat cursor-agent.log',
  'ssh-agent bash',
  'goose up',
]

test('detectExternalAgentCli matches only executable positions', () => {
  const { detectExternalAgentCli } = require('../dist-electron/main/libs/externalAgentCli.js')
  for (const [command, expected] of AGENT_COMMANDS) {
    assert.equal(detectExternalAgentCli(command), expected, `detects: ${command}`)
  }
  for (const command of SAFE_COMMANDS) {
    assert.equal(detectExternalAgentCli(command), null, `ignores: ${command}`)
  }
  assert.equal(detectExternalAgentCli(''), null, 'empty command')
})

test('evaluateDshToolPolicy gates external agent CLIs like deletes', async () => {
  const { CoworkRunner } = loadRunner()
  const runner = new CoworkRunner(new MinimalStore(), { localTurnStallTimeoutMs: 0 })
  const policy = async (toolName, toolInput, session) => {
    if (session !== null) {
      runner.activeSessions.set('s1', { sessionId: 's1', ...session })
    } else {
      runner.activeSessions.delete('s1')
    }
    return runner.evaluateDshToolPolicy('s1', toolName, toolInput)
  }

  const command = 'cursor-agent chat -p "hi"'
  // Attended default session asks, with the CLI named in the reason.
  const ask = await policy('bash', { command }, { permissionMode: 'default' })
  assert.equal(ask.decision, 'ask', 'default asks for cursor-agent')
  assert.match(ask.reason, /cursor-agent/, 'ask reason names the CLI')
  // Orphan policy request (no session): fail closed to ask.
  assert.equal((await policy('bash', { command }, null)).decision, 'ask', 'no-session asks')
  // Unattended (autoApprove) sessions auto-deny with an instructive reason —
  // nobody watches their dialogs, and an unanswered ask would stall the turn.
  const denied = await policy('bash', { command }, { permissionMode: 'default', autoApprove: true })
  assert.equal(denied.decision, 'deny', 'autoApprove denies cursor-agent')
  assert.match(denied.reason, /unattended/, 'deny reason explains unattended')
  // Full-trust modes skip the gate exactly like the delete policy.
  assert.equal((await policy('bash', { command }, { permissionMode: 'acceptEdits' })).decision, 'allow')
  assert.equal((await policy('bash', { command }, { permissionMode: 'bypassPermissions' })).decision, 'allow')
  // Plan mode still denies non-read-only bash ahead of the gate.
  assert.equal((await policy('bash', { command }, { permissionMode: 'plan' })).decision, 'deny')

  // Ordinary bash stays allowed in every mode; non-bash tools are untouched.
  for (const session of [{ permissionMode: 'default' }, { permissionMode: 'default', autoApprove: true }, null]) {
    assert.equal((await policy('bash', { command: 'ls -la' }, session)).decision, 'allow', 'plain bash allowed')
  }
  assert.equal((await policy('write', { file_path: 'cursor-agent', content: 'x' }, { permissionMode: 'default' })).decision, 'allow')
})
