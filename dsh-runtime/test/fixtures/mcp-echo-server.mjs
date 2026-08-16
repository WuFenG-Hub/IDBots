// Test fixture: a minimal stdio MCP server speaking newline-delimited JSON-RPC
// 2.0 (initialize → tools/list → tools/call). One tool: `echo` returns its
// arguments as text. Used by mcp-bridge.test.mjs to prove the generator's
// dsh-mcp-client entries surface real user MCP tools to the model.

import readline from 'node:readline'

const PROTOCOL_VERSION = '2025-06-18'

const rl = readline.createInterface({ input: process.stdin })
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

rl.on('line', (line) => {
  if (!line.trim()) return
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'echo-fixture', version: '1.0.0' },
      },
    })
  } else if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [{
          name: 'echo',
          description: 'Echo back the given note.',
          inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
        }],
      },
    })
  } else if (message.method === 'tools/call') {
    const note = message.params?.arguments?.note ?? '(nothing)'
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: `MCP-ECHO: ${note}` }] },
    })
  }
  // notifications (initialized, cancelled) need no response.
})
