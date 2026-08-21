// Windows stdio command rewrite for MCP + npm plugin installs.
// Requires: npm run compile:electron

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'

const require = Module.createRequire(import.meta.url)
const {
  rewriteWin32StdioCommand,
  rewriteWin32McpStdioServer,
} = require('../dist-electron/main/libs/win32StdioCommand.js')

test('rewriteWin32StdioCommand is identity off Windows', () => {
  assert.equal(rewriteWin32StdioCommand('npx', 'darwin'), 'npx')
  assert.equal(rewriteWin32StdioCommand('npm', 'linux'), 'npm')
})

test('rewriteWin32StdioCommand maps bare names on win32', () => {
  assert.equal(rewriteWin32StdioCommand('npx', 'win32'), 'npx.cmd')
  assert.equal(rewriteWin32StdioCommand('npm', 'win32'), 'npm.cmd')
  assert.equal(rewriteWin32StdioCommand('node', 'win32'), 'node.exe')
  assert.equal(rewriteWin32StdioCommand('python3', 'win32'), 'python.exe')
  assert.equal(rewriteWin32StdioCommand('npx.cmd', 'win32'), 'npx.cmd')
  assert.equal(rewriteWin32StdioCommand('C:\\Program Files\\nodejs\\npx', 'win32'), 'C:\\Program Files\\nodejs\\npx.cmd')
  assert.equal(rewriteWin32StdioCommand('bash', 'win32'), 'bash')
})

test('rewriteWin32McpStdioServer only rewrites stdio commands', () => {
  assert.deepEqual(
    rewriteWin32McpStdioServer({ name: 'a', transportType: 'stdio', command: 'npx' }, 'win32'),
    { name: 'a', transportType: 'stdio', command: 'npx.cmd' },
  )
  assert.deepEqual(
    rewriteWin32McpStdioServer({ name: 'b', transportType: 'http', url: 'https://x', command: 'npx' }, 'win32'),
    { name: 'b', transportType: 'http', url: 'https://x', command: 'npx' },
  )
})
