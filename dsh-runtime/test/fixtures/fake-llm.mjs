// IDBots DSH Phase 0 spike: scripted fake LLM adapter.
//
// Registers the provider route `fake` on ctx.llm so the whole agent loop
// (turn/step driving, tool execution, steer, cancel, resume) can be exercised
// end-to-end without any API key. Behavior is keyed by markers in the last
// user message:
//   PING          -> plain text reply (stop)
//   TOOL:WALLET   -> tool-call wallet_balance
//   TOOL:PING     -> tool-call spike_ping
//   TOOL:GATED    -> tool-call wallet_transfer_gated (expect pre-execute deny)
//   STEER_TEST    -> tool-call slow_tool (gives the driver a window to steer)
//   CANCEL_TEST   -> slow text stream (gives the driver a window to cancel)
// After any tool result comes back, the next request summarizes it as text.

import { LlmAdapter } from '@deepseek-ai/dsh-llm'

// stdout belongs to the JSON-RPC wire in sdk runtime mode; gate debug logs.
const spikeLog = (...args) => { if (!process.env.SPIKE_QUIET) console.log(...args) }


const PROVIDER = 'fake'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function textOf(message) {
  return (message?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function lastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i]
  }
  return undefined
}

function lastToolResult(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const block = (m.content ?? []).find((b) => b.type === 'tool-result')
    if (block) return block
  }
  return undefined
}

class FakeAdapter extends LlmAdapter {
  constructor() {
    super()
    // sessionId -> request counter; survives within one process run.
    this.requests = new Map()
  }

  async *textStream(options, reply) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    // Emit in two deltas so chunk-level streaming is observable in the log.
    const mid = Math.max(1, Math.ceil(reply.length / 2))
    for (const part of [reply.slice(0, mid), reply.slice(mid)]) {
      if (options.signal?.aborted) return
      yield { type: 'text-delta', index: 0, text: part }
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 17, outputTokens: Math.ceil(reply.length / 4) } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  async *toolCallStream(options, name, args) {
    const id = `call_${name}_${Date.now()}`
    const argsJson = JSON.stringify(args)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argsJson }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argsJson } }
    yield { type: 'usage', usage: { inputTokens: 21, outputTokens: 8 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }

  async *stream(options) {
    const key = String(options.sessionId ?? 'anonymous')
    const n = (this.requests.get(key) ?? 0) + 1
    this.requests.set(key, n)

    const user = lastUserMessage(options.messages)
    const userText = user ? textOf(user) : ''
    const result = lastToolResult(options.messages)
    const history = options.messages.map((m) => {
      const kinds = (m.content ?? []).map((b) => b.type).join('+')
      const preview = textOf(m).slice(0, 36) || (m.content ?? []).map((b) => b.type === 'tool-result' ? `tool-result:${b.toolCallId}` : b.type).join(',')
      return `${m.role}[${kinds}]${preview ? ` "${preview}"` : ''}`
    }).join(' | ')
    spikeLog(`[fake-llm] req#${n} session=${key} history=${options.messages.length}msg tools=[${(options.tools ?? []).map((t) => t.name).join(',')}] system=${options.system?.length ?? 0}ch`)
    spikeLog(`[fake-llm]   history> ${history}`)
    globalThis.__fakeLlmRequests ??= []
    globalThis.__fakeLlmRequests.push({ n, key, messages: structuredClone(options.messages), system: options.system })

    if (userText.includes('CANCEL_TEST')) {
      // Slow stream so the driver can cancel mid-turn.
      const words = 'this reply streams slowly word by word so the spike driver can cancel the turn mid stream'.split(' ')
      yield { type: 'block-start', index: 0, blockType: 'text' }
      for (const w of words) {
        if (options.signal?.aborted) return // runtime normalizes this into an aborted finish
        yield { type: 'text-delta', index: 0, text: w + ' ' }
        await delay(120)
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: words.join(' ') + ' ' } }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 12 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (result && !userText) {
      // The step after a tool result: summarize what the tool said.
      const summary = (result.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ')
      const reply = result.isError
        ? `TOOL_DENIED: ${summary.slice(0, 200)}`
        : `TOOL_RESULT_SEEN: ${summary.slice(0, 200)}`
      yield* this.textStream(options, reply)
      return
    }

    if (userText.includes('STEER_TEST')) {
      yield* this.toolCallStream(options, 'slow_tool', { note: 'sleep so the driver can steer' })
      return
    }
    if (userText.includes('TOOL:WALLET')) {
      yield* this.toolCallStream(options, 'wallet_balance', { metaid: 'alice' })
      return
    }
    if (userText.includes('TOOL:GATED')) {
      yield* this.toolCallStream(options, 'wallet_transfer_gated', { to: 'bob', amount: 5000 })
      return
    }
    if (userText.includes('TOOL:PING')) {
      yield* this.toolCallStream(options, 'spike_ping', { echo: 'hello-from-fake-llm' })
      return
    }
    if (userText.includes('PING')) {
      yield* this.textStream(options, 'PONG from fake adapter')
      return
    }
    yield* this.textStream(options, `fake reply to: ${userText.slice(0, 100)}`)
  }
}

export function apply(ctx) {
  ctx.llm.registerAdapter([PROVIDER], new FakeAdapter())
}

export default {
  name: 'fake-llm',
  inject: ['llm'],
  apply,
}
