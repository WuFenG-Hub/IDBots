// idbots-sdk-server: IDBots' JSON-RPC SDK server for the DSH runtime.
//
// The stock @deepseek-ai/dsh-sdk-jsonrpc-server wires initialize/session/prompt/
// shutdown over stdio and its handleRequest is a closed switch (no extension hook).
// We keep the stock server class — subclassing it, not forking — and take over the
// apply() wiring ourselves so the single stdio transport also dispatches the
// control-plane methods IDBots needs on the wire (Phase 0 verified they are absent
// upstream, report §2 F10/F11):
//
//   session/steer          { sessionId, contentBlocks } → step-boundary steering mid-turn
//   session/cancel         { sessionId, cause?, keepInbox? } → abort active turn with cause
//   idbots/approval/respond { id, outcome } → answer a pending approval ask (M2)
//   idbots/ping            → extension presence canary
//
// Notifications we emit (beyond the stock session.event / session.status /
// subagent.* set):
//
//   idbots/approval/request   { id, sessionId, toolName, callId?, reason? }
//   idbots/approval/cancelled { id }
//
// Approval bridging: the dsh-user-approval service owns the `approval` seam,
// audit events (approval/asked + approval/decided ride the session feed), and
// the scope-filtered `approval/request` answerer waterfall (default answer
// 'unavailable' = fail-closed). We register the answerer here with { global:
// true } — the waterfall dispatches through the agent's scope carrier, which
// filters ordinary fiber-context listeners out (Phase 0 F5 lesson) — and
// forward each ask to the Electron host over the wire. The service itself
// races the turn's AbortSignal against our answer and discards late replies.

import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server'

const RESPOND_OUTCOMES = new Set(['allowed-once', 'rejected'])

export const name = 'idbots-sdk-server'
export const inject = ['agents']

class IdbotsSdkServer extends HarnessSdkJsonRpcServer {
  constructor(ctx, transport, options) {
    super(ctx, transport, options)
    this.idbotsTransport = transport
    this.idbotsAgents = new Map()
    this.idbotsApprovals = new Map() // id → { resolve, sessionId }
    this.idbotsApprovalSeq = 0

    ctx.on('agent/created', ({ agent }) => {
      this.idbotsAgents.set(String(agent.id), agent)
    }, { global: true })
    ctx.on('agent/disposed', ({ agent }) => {
      this.idbotsAgents.delete(String(agent.id))
    }, { global: true })

    ctx.on('approval/request', (req, next) => this.idbotsBridgeApproval(req, next), { global: true })
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
      case 'idbots/approval/respond': return this.idbotsApprovalRespond(params)
      case 'idbots/ping': {
        return {
          pong: true,
          extensions: ['session/steer', 'session/cancel', 'idbots/approval/respond'],
        }
      }
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

  // ---- approval bridge -----------------------------------------------------

  idbotsBridgeApproval(req) {
    const id = `appr-${Date.now().toString(36)}-${++this.idbotsApprovalSeq}`
    const sessionId = String(req.agent?.id ?? '')
    const settle = new Promise((resolve) => {
      this.idbotsApprovals.set(id, { resolve, sessionId })
    })
    this.idbotsTransport.notify('idbots/approval/request', {
      id,
      sessionId,
      toolName: req.toolName,
      ...req.callId !== undefined ? { callId: String(req.callId) } : {},
      ...req.reason !== undefined ? { reason: req.reason } : {},
    })
    // The service races the turn signal itself and discards our late answer on
    // abort; we only clean up and tell the host to dismiss the dialog.
    req.signal?.addEventListener('abort', () => {
      const pending = this.idbotsApprovals.get(id)
      if (pending === undefined) return
      this.idbotsApprovals.delete(id)
      pending.resolve('cancelled')
      this.idbotsTransport.notify('idbots/approval/cancelled', { id })
    }, { once: true })
    return settle
  }

  async idbotsApprovalRespond({ id, outcome }) {
    if (!RESPOND_OUTCOMES.has(outcome)) {
      throw new Error(`idbots-sdk-server: approval outcome must be one of ${[...RESPOND_OUTCOMES].join('|')}, got ${JSON.stringify(outcome)}`)
    }
    const pending = this.idbotsApprovals.get(String(id))
    if (pending === undefined) {
      throw new Error(`idbots-sdk-server: no pending approval ${JSON.stringify(id)}`)
    }
    this.idbotsApprovals.delete(String(id))
    pending.resolve(outcome)
    return { answered: true, id, outcome }
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
