// Test fixture: OpenAI-compatible SSE gateway for M3 E2E tests.
//
// Records every request (method, url, auth, parsed body). A user message
// containing CALL_BIG_TOOL gets a tool_calls response (so the real pi-ai path
// executes the fixture tool and exercises commit-time shaping); anything else
// gets a plain text reply echoing the last user message.

import http from 'node:http'

export function startMockServer(port = 48787) {
  const seen = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      let parsed = {}
      try { parsed = JSON.parse(body) } catch { /* ignore */ }
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? '(none)', body: parsed })
      const lastUser = [...(parsed.messages ?? [])].reverse().find((m) => m.role === 'user')
      const lastUserText = typeof lastUser?.content === 'string' ? lastUser.content : ''
      // A tool result rides as role 'tool'; only the FIRST request of a
      // CALL_BIG_TOOL turn asks for the tool — afterwards answer in plain text
      // so the turn terminates.
      const alreadyHasToolResult = (parsed.messages ?? []).some((m) => m.role === 'tool')

      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-1', object: 'model' }] }))
        return
      }
      if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `mock: no route ${req.method} ${req.url}` } }))
        return
      }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const frame = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
      const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Date.now() / 1000 | 0, model: 'mock-1' }

      if (lastUserText.includes('CALL_BIG_TOOL') && !alreadyHasToolResult) {
        const args = JSON.stringify({ note: 'please dump the big blob' })
        frame({
          ...base,
          choices: [{
            index: 0,
            delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_big_1', type: 'function', function: { name: 'big_output_tool', arguments: args } }] },
            finish_reason: null,
          }],
        })
        frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      } else {
        const reply = alreadyHasToolResult ? 'mock says: tool finished, result was huge but bounded' : `mock says: ${lastUserText.slice(0, 40)}`
        frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
        for (const part of [reply.slice(0, Math.ceil(reply.length / 2)), reply.slice(Math.ceil(reply.length / 2))]) {
          frame({ ...base, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })
        }
        frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      }
      frame({ ...base, choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, seen })))
}
