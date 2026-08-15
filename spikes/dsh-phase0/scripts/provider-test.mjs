// IDBots DSH Phase 0 spike: third-party endpoint routing test.
//
// Starts a local OpenAI-compatible mock, boots a provider config against it,
// runs one agent turn, and checks (a) the mock received the request with the
// credential attached, and (b) the streamed reply made it back through the
// agent loop.
//
// Usage: node scripts/provider-test.mjs pi-ai|deepseek

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { startMockServer } from './mock-openai.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const which = process.argv[2] ?? 'pi-ai'
const configPath = path.resolve(here, `../cordis.provider-${which}.yml`)

process.env.MOCK_API_KEY ??= 'sk-mock-123'
if (which === 'deepseek') {
  process.env.DEEPSEEK_API_KEY ??= 'sk-mock-123'
  process.env.DEEPSEEK_BASE_URL ??= 'http://127.0.0.1:48787/v1'
}

const provider = which === 'deepseek' ? 'deepseek-official' : 'mock-gw'
const model = 'mock-1'

const main = async () => {
  const { server, seen } = await startMockServer(48787)
  console.log(`[spike] mock gateway up; booting ${configPath}`)
  const ctx = await boot(`idbots-prov-${which}`, configPath)

  const handle = await ctx.agents.create({
    sessionId: `spike-prov-${Date.now().toString(36)}`,
    meta: { cwd: process.cwd() },
    agentOptions: { provider, model },
  })
  const { agent } = handle

  const replies = []
  ctx.on('session/event', (session, event) => {
    const data = event.data ?? event
    if (event.type === 'assistant/message') {
      const text = (data.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
      if (text) replies.push(text)
    }
    if (event.type === 'request/header') {
      console.log(`[spike] request/header provider=${data.header?.config?.provider} model=${data.header?.config?.model}`)
    }
  })

  agent.followup({ id: 'u1', role: 'user', content: [{ type: 'text', text: 'HELLO_MOCK' }], source: { kind: 'user' } })
  await agent.whenIdle()

  const okRequest = seen.some((r) => r.url.endsWith('/chat/completions') && r.auth.startsWith('Bearer sk-mock'))
  const okReply = replies.some((t) => t.includes('mock says'))
  console.log(`${okRequest ? 'PASS' : 'FAIL'}  ${which}: request reached OpenAI-compatible endpoint with bearer credential (${seen.length} requests seen)`)
  console.log(`${okReply ? 'PASS' : 'FAIL'}  ${which}: streamed reply traversed the agent loop (replies=${JSON.stringify(replies)})`)

  await ctx.get('sessions')?.flush(agent.session)
  server.close()
  process.exit(okRequest && okReply ? 0 : 1)
}

main().catch((error) => {
  console.error('[spike] fatal:', error)
  process.exit(1)
})
