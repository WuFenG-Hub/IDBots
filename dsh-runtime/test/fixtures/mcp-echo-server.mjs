// Test fixture: a minimal stdio MCP server speaking newline-delimited JSON-RPC
// 2.0 (initialize → tools/list → tools/call). One tool: `echo` returns its
// arguments as text. Used by mcp-bridge.test.mjs to prove the generator's
// dsh-mcp-client entries surface real user MCP tools to the model.
//
// MCP SDK v2 note: unknown REQUESTS (anything with an `id` we do not handle,
// e.g. the `server/discover` era-negotiation probe the v2 client sends in
// `versionNegotiation: {mode:'auto'}`) must be answered with -32601 Method
// not found. Silently dropping them leaves the client waiting for a reply
// until its (60s default) probe timeout classifies us as a legacy server.

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
  } else if (message.id !== undefined) {
    // Unknown request (e.g. server/discover): standard Method-not-found reply
    // so SDK v2 era negotiation classifies this fixture as legacy at once.
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `Method not found: ${String(message.method)}` },
    })
  }
  // notifications (initialized, cancelled) need no response.
})
