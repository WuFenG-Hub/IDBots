// IDBots DSH Phase 0 spike: minimal OpenAI-compatible SSE endpoint.
//
// Stands in for a third-party gateway so provider routing can be validated
// without real keys: serves POST /v1/chat/completions (SSE) and GET /v1/models.
// Every received request is recorded and echoed on stdout.

import http from 'node:http'

export function startMockServer(port = 48787) {
  const seen = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const auth = req.headers.authorization ?? '(none)'
      seen.push({ method: req.method, url: req.url, auth, body })
      console.log(`[mock-openai] ${req.method} ${req.url} auth=${auth.slice(0, 14)}… body=${body.slice(0, 160)}`)

      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-1', object: 'model' }] }))
        return
      }
      if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
        let promptEcho = ''
        try {
          const parsed = JSON.parse(body)
          promptEcho = (parsed.messages ?? []).at(-1)?.content?.toString().slice(0, 40) ?? ''
        } catch { /* ignore */ }
        const reply = `mock says: ${promptEcho}`
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        const frame = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
        const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Date.now() / 1000 | 0, model: 'mock-1' }
        frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
        const mid = Math.ceil(reply.length / 2)
        for (const part of [reply.slice(0, mid), reply.slice(mid)]) {
          frame({ ...base, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })
        }
        frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        frame({ ...base, choices: [], usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 } })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `mock: no route ${req.method} ${req.url}` } }))
    })
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, seen })))
}

// CLI mode: run standalone.
if (process.argv[1]?.endsWith('mock-openai.mjs')) {
  startMockServer(Number(process.env.MOCK_PORT ?? 48787)).then(({ server }) => {
    console.log(`[mock-openai] listening on 127.0.0.1:${server.address().port}`)
  })
}
