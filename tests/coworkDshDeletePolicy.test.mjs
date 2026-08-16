// DSH host tool policy — delete-class confirmation matrix (Task 2 of the DSH
// integration fix list): the delete ask must fire ONLY under 'default'
// permission mode, matching the Claude path's canUseTool (acceptEdits and
// bypassPermissions skip the delete-safety question). Unconditional asking
// hung unattended worker sessions (acceptEdits) forever on `rm -rf` cleanup
// steps, because no human watches a background session to answer the dialog.
//
// Requires: npm run compile:electron.

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
          getPath: (name) => `/tmp/idbots-delete-policy-${name}`,
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

const DELETE_COMMANDS = [
  'rm -rf /tmp/some-dir',
  'find . -name "*.log" -delete',
  'git clean -fd',
]
const SAFE_COMMAND = 'ls -la'

test('evaluateDshToolPolicy asks for deletes only under default permission mode', async () => {
  const { CoworkRunner } = loadRunner()
  const runner = new CoworkRunner(new MinimalStore(), { localTurnStallTimeoutMs: 0 })
  const policy = async (toolName, toolInput, permissionMode) => {
    if (permissionMode !== null) {
      runner.activeSessions.set('s1', { sessionId: 's1', permissionMode })
    } else {
      runner.activeSessions.delete('s1')
    }
    return runner.evaluateDshToolPolicy('s1', toolName, toolInput)
  }

  for (const command of DELETE_COMMANDS) {
    // 'default' keeps the human confirmation (foreground interactive use).
    assert.equal((await policy('bash', { command }, 'default')).decision, 'ask', `default asks for: ${command}`)
    // Worker/unattended modes skip it, exactly like the Claude path — this
    // was the permanent-hang regression after the DSH kernel switch.
    assert.equal((await policy('bash', { command }, 'acceptEdits')).decision, 'allow', `acceptEdits allows: ${command}`)
    assert.equal((await policy('bash', { command }, 'bypassPermissions')).decision, 'allow', `bypassPermissions allows: ${command}`)
    // No active session (orphan policy request): fail closed to ask.
    assert.equal((await policy('bash', { command }, null)).decision, 'ask', `no-session asks for: ${command}`)
  }

  // Non-delete commands stay allowed in every mode (bash policy gate).
  for (const mode of ['default', 'acceptEdits', 'bypassPermissions']) {
    assert.equal((await policy('bash', { command: SAFE_COMMAND }, mode)).decision, 'allow', `${mode} allows non-delete bash`)
  }

  // Plan mode still denies mutating tools ahead of the delete check.
  assert.equal((await policy('bash', { command: SAFE_COMMAND }, 'plan')).decision, 'deny', 'plan denies non-read-only bash')
  // Direct delete-named tools ask under default too.
  assert.equal((await policy('delete', { path: '/tmp/x' }, 'default')).decision, 'ask', 'delete tool asks under default')
  assert.equal((await policy('delete', { path: '/tmp/x' }, 'acceptEdits')).decision, 'allow', 'delete tool allowed under acceptEdits')
})
