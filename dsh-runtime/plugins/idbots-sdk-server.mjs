// idbots-sdk-server: IDBots' JSON-RPC SDK server for the DSH runtime.
//
// The stock @deepseek-ai/dsh-sdk-jsonrpc-server wires initialize/session/prompt/
// shutdown over stdio and its handleRequest is a closed switch (no extension hook).
// We keep the stock server class — subclassing it, not forking — and take over the
// apply() wiring ourselves so the single stdio transport also dispatches the
// control-plane methods IDBots needs on the wire (Phase 0 verified they are absent
// upstream, report §2 F10/F11):
//
//   session/steer   { sessionId, contentBlocks } → step-boundary steering mid-turn
//   session/cancel  { sessionId, cause?, keepInbox? } → abort active turn with cause
//   idbots/ping     → extension presence canary
//
// Agent lookup rides the public agent/created / agent/disposed registry events
// (registered global: both events are dispatched through the agent's scope carrier,
// which filters ordinary fiber-context listeners out — same lesson as Phase 0 F5).

import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server'

export const name = 'idbots-sdk-server'
export const inject = ['agents']

class IdbotsSdkServer extends HarnessSdkJsonRpcServer {
  constructor(ctx, transport, options) {
    super(ctx, transport, options)
    this.idbotsAgents = new Map()
    ctx.on('agent/created', ({ agent }) => {
      this.idbotsAgents.set(String(agent.id), agent)
    }, { global: true })
    ctx.on('agent/disposed', ({ agent }) => {
      this.idbotsAgents.delete(String(agent.id))
    }, { global: true })
  }

  liveAgent(sessionId) {
    const agent = this.idbotsAgents.get(String(sessionId))
    if (agent === undefined) {
      throw new Error(`idbots-sdk-server: no live agent for session ${sessionId}`)
    }
    return agent
  }

  async handleRequest(method, params) {
    switch (method) {
      case 'session/steer': return this.idbotsSteer(params)
      case 'session/cancel': return this.idbotsCancel(params)
      case 'idbots/ping': return { pong: true, extensions: ['session/steer', 'session/cancel'] }
      default: return super.handleRequest(method, params)
    }
  }

  async idbotsSteer({ sessionId, contentBlocks }) {
    const agent = this.liveAgent(sessionId)
    const message = {
      id: `steer-${Date.now().toString(36)}`,
      role: 'user',
      content: contentBlocks,
      source: { kind: 'user' },
    }
    agent.steer(message)
    return { steered: true, messageId: message.id }
  }

  async idbotsCancel({ sessionId, cause, keepInbox }) {
    const agent = this.liveAgent(sessionId)
    agent.cancel(cause ?? 'idbots client cancel', { keepInbox: keepInbox === true })
    return { cancelled: true }
  }
}

export function apply(ctx, config = {}) {
  const rootFiber = ctx.root.fiber
  const input = config.input ?? process.stdin
  const output = config.output ?? process.stdout
  const exit = config.exit ?? ((code) => { process.exit(code) })

  const transport = new JsonRpcLineTransport(input, output)
  const server = new IdbotsSdkServer(ctx, transport, {
    maxTokensAsSuccess: config.maxTokensAsSuccess !== false,
  })

  let exitTask
  const disposeAndExit = () => {
    exitTask ??= (async () => {
      await Promise.allSettled([Promise.resolve().then(() => transport.flush())])
      await Promise.allSettled([Promise.resolve().then(() => rootFiber.dispose())])
      exit(0)
    })()
    return exitTask
  }

  transport.onRequest(async (method, params) => {
    const result = await server.handleRequest(method, params)
    if (method === 'shutdown') {
      setImmediate(() => { void disposeAndExit() })
    }
    return result
  })

  ctx.effect(() => {
    transport.start()
    return async () => {
      await server.shutdown()
      transport.close()
    }
  }, 'idbots-sdk-server.serve')
}
