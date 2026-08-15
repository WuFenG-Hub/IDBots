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
//   session/ensure         { sessionId, provider?, model?, maxTokens? } → live agent for the
//                           session: create fresh, or RESUME when a persisted log exists
//                           (the stock server only lazily creates and would fail on an
//                           existing log after a runtime restart). Also the per-session
//                           provider/model override the stock wire lacks.
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
export const inject = ['agents', 'tools']

class IdbotsSdkServer extends HarnessSdkJsonRpcServer {
  constructor(ctx, transport, options) {
    super(ctx, transport, options)
    this.idbotsTransport = transport
    this.idbotsAgents = new Map()
    this.idbotsApprovals = new Map() // id → { resolve, sessionId }
    this.idbotsApprovalSeq = 0
    this.idbotsToolPending = new Map() // id → { resolve, reject }
    this.idbotsToolSeq = 0
    this.idbotsPolicyPending = new Map() // id → { resolve }
    this.idbotsPolicySeq = 0
    // Subagent lineage for the panel: parent dsh id → [{agentId, status, startedAt}]
    this.idbotsSubagentChildren = new Map()
    // Ring buffers of child session events for transcript viewing.
    this.idbotsChildEvents = new Map()

    ctx.on('agent/created', ({ agent }) => {
      this.idbotsAgents.set(String(agent.id), agent)
      // Subagent lineage lives FLATTENED on the session header (not under a
      // meta subobject): header.origin === 'subagent' + header.parentSession.
      const header = agent?.session?.header
      if (header?.origin === 'subagent' && header?.parentSession !== undefined) {
        const parent = String(header.parentSession)
        const children = this.idbotsSubagentChildren.get(parent) ?? []
        children.push({ agentId: String(agent.id), status: 'running', startedAt: Date.now() })
        this.idbotsSubagentChildren.set(parent, children)
        this.idbotsChildEvents.set(String(agent.id), [])
      }
    }, { global: true })
    ctx.on('agent/disposed', ({ agent }) => {
      for (const children of this.idbotsSubagentChildren.values()) {
        const entry = children.find((c) => c.agentId === String(agent.id))
        if (entry) entry.status = 'done'
      }
    }, { global: true })
    // Buffer child session events for the panel transcript view.
    ctx.on('session/event', (session, event) => {
      const sid = typeof session === 'string' ? session : String(session?.id ?? '')
      if (!sid || !this.idbotsChildEvents.has(sid)) return
      const buffer = this.idbotsChildEvents.get(sid)
      buffer.push(event)
      if (buffer.length > 500) buffer.splice(0, buffer.length - 500)
    })
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
      case 'session/ensure': return this.idbotsEnsureSession(params)
      case 'idbots/approval/respond': return this.idbotsApprovalRespond(params)
      case 'idbots/tool/respond': return this.idbotsToolRespond(params)
      case 'idbots/policy/respond': return this.idbotsPolicyRespond(params)
      case 'idbots/subagents/list': return this.idbotsSubagentsList(params)
      case 'idbots/subagents/messages': return this.idbotsSubagentsMessages(params)
      case 'idbots/ping': {
        return {
          pong: true,
          extensions: ['session/steer', 'session/cancel', 'session/ensure', 'idbots/approval/respond', 'idbots/tool/respond'],
        }
      }
      default: return super.handleRequest(method, params)
    }
  }

  async idbotsEnsureSession(hostParams) {
    const { sessionId, provider, model, maxTokens } = hostParams ?? {}
    const id = String(sessionId ?? '')
    if (id.length === 0) throw new Error('idbots-sdk-server: session/ensure requires sessionId')
    if (this.idbotsAgents.has(id)) return { ensured: true, resumed: false }

    const agentOptions = {
      provider: provider ?? this.provider,
      model: model ?? this.model,
      ...Number.isFinite(maxTokens) ? { maxTokens } : {},
    }
    // Resume-first: agents.create does NOT consult the persisted log (it mints
    // a fresh in-memory session), so a restart would silently overwrite
    // history instead of resuming. resume throws `session "<id>" not found`
    // when no log exists — that is the fresh-create signal.
    let handle
    let resumed = true
    try {
      handle = await this.ctx.agents.resume({ resumeSessionId: id, agentOptions })
    } catch (error) {
      if (!/not found/.test(String(error?.message ?? error))) throw error
      handle = await this.ctx.agents.create({ sessionId: id, meta: { cwd: this.cwd }, agentOptions })
      resumed = false
    }
    // Per-session surface: prompt sections and host tools registered on the
    // agent's scoped context (shadowing globals, unwound on disposal).
    this.idbotsRegisterSections(hostParams.sections, handle.agent?.ctx)
    this.idbotsRegisterHostTools(hostParams.hostTools, handle.agent?.ctx)
    // Register with the stock server's bookkeeping (private at the type level,
    // present at runtime) so its lazy session/prompt create reuses this agent
    // instead of colliding on the registry id.
    this.sessions.set(id, { handle })
    return { ensured: true, resumed }
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

  // ---- host tool bridge -----------------------------------------------------
  //
  // Model-visible tools whose handlers live in the Electron main process:
  // the schemas ride the plugin config (generated by the host), execution
  // round-trips over the wire — idbots/tool/request notification out,
  // idbots/tool/respond back, idbots/tool/cancelled when the turn aborts
  // mid-call (the tool MUST settle on abort; that contract is enforced here).

  /** Build one host-bridged tool proxy (shared by global and agent-scoped registration). */
  idbotsMakeHostTool(definition) {
    const server = this
    return {
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }],
        },
      execute: async (args, exec) => {
        const id = `tool-${Date.now().toString(36)}-${++server.idbotsToolSeq}`
        const pending = new Promise((resolve, reject) => {
          server.idbotsToolPending.set(id, { resolve, reject })
        })
        server.idbotsTransport.notify('idbots/tool/request', {
          id,
          sessionId: String(exec.agent?.id ?? ''),
          name: definition.name,
          arguments: args,
        })
        exec.signal?.addEventListener('abort', () => {
          const entry = server.idbotsToolPending.get(id)
          if (entry === undefined) return
          server.idbotsToolPending.delete(id)
          entry.reject(new Error('host tool call aborted'))
          server.idbotsTransport.notify('idbots/tool/cancelled', { id })
        }, { once: true })
        return pending // { text } on success; throws on host error/abort
      },
    }
  }

  idbotsRegisterHostTools(tools, scopeCtx) {
    for (const definition of tools ?? []) {
      (scopeCtx ?? this.ctx).tools.register(this.idbotsMakeHostTool(definition))
    }
  }

  /**
   * Agent-scoped prompt sections: DSH systemPrompt sections registered on the
   * agent's own context SHADOW same-named global sections for that agent
   * alone — per-session prompts ride here instead of the runtime config, so
   * differing system prompts never restart the runtime.
   */
  idbotsRegisterSections(sections, scopeCtx) {
    const systemPrompt = (scopeCtx ?? this.ctx).get('systemPrompt')
    if (!systemPrompt) return
    for (const section of sections ?? []) {
      systemPrompt.section({
        name: section.name,
        order: Number.isFinite(section.order) ? section.order : 0,
        text: section.text,
      })
    }
  }

  async idbotsToolRespond({ id, ok, text, error }) {
    const entry = this.idbotsToolPending.get(String(id))
    if (entry === undefined) {
      throw new Error(`idbots-sdk-server: no pending host tool ${JSON.stringify(id)}`)
    }
    this.idbotsToolPending.delete(String(id))
    if (ok === false) {
      entry.reject(new Error(typeof error === 'string' && error ? error : 'host tool failed'))
    } else {
      entry.resolve({ text: typeof text === 'string' ? text : JSON.stringify(text ?? null) })
    }
    return { answered: true, id }
  }

  // ---- host policy bridge ----------------------------------------------------
  //
  // Runtime-native tools (bash/write/edit…) route their pre-execute decision
  // through the host's permission chain: idbots/policy/request notification
  // out, idbots/policy/respond back with allow | deny | ask. 'ask' returns to
  // the tools pipeline as a normal ask, flowing through user-approval and the
  // M2 approval bridge into the renderer permission dialog.

  idbotsRegisterPolicyGate(policyTools) {
    const gated = new Set(policyTools ?? ['bash', 'write', 'edit'])
    const server = this
    this.ctx.on('tools/pre-execute', async (exec, next) => {
      if (!gated.has(exec?.name)) return next()
      const id = `policy-${Date.now().toString(36)}-${++server.idbotsPolicySeq}`
      const pending = new Promise((resolve) => {
        server.idbotsPolicyPending.set(id, { resolve })
      })
      server.idbotsTransport.notify('idbots/policy/request', {
        id,
        sessionId: String(exec.agent?.id ?? ''),
        name: exec.name,
        arguments: exec.arguments,
      })
      exec.signal?.addEventListener('abort', () => {
        const entry = server.idbotsPolicyPending.get(id)
        if (entry === undefined) return
        server.idbotsPolicyPending.delete(id)
        entry.resolve({ decision: 'deny', reason: 'session aborted' })
      }, { once: true })
      const decision = await pending
      if (decision.decision === 'allow') return next()
      if (decision.decision === 'ask') return { kind: 'ask', reason: decision.reason }
      return { kind: 'deny', reason: decision.reason ?? 'denied by host policy' }
    }, { global: true })
  }

  idbotsSubagentsList({ sessionId }) {
    const children = this.idbotsSubagentChildren.get(String(sessionId ?? '')) ?? []
    return { agents: children.map((c) => ({ ...c })) }
  }

  idbotsSubagentsMessages({ sessionId, agentId, limit }) {
    void sessionId
    const buffer = this.idbotsChildEvents.get(String(agentId ?? '')) ?? []
    const messages = []
    for (const event of buffer) {
      const data = event.data ?? {}
      if (event.type === 'user/message' && (data.source ?? data.message?.source)?.kind === 'user') {
        const text = (data.content ?? data.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
        messages.push({ id: `${agentId}-u-${messages.length}`, type: 'user', content: text, timestamp: event.time })
      } else if (event.type === 'assistant/message') {
        const text = (data.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
        if (text) messages.push({ id: `${agentId}-a-${messages.length}`, type: 'assistant', content: text, timestamp: event.time })
      }
    }
    const capped = Number.isFinite(limit) && limit > 0 ? messages.slice(-limit) : messages
    return { messages: capped }
  }

  async idbotsPolicyRespond({ id, decision, reason }) {
    const entry = this.idbotsPolicyPending.get(String(id))
    if (entry === undefined) {
      throw new Error(`idbots-sdk-server: no pending policy decision ${JSON.stringify(id)}`)
    }
    this.idbotsPolicyPending.delete(String(id))
    entry.resolve({ decision: decision === 'allow' || decision === 'ask' ? decision : 'deny', reason })
    return { answered: true, id }
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
  server.idbotsRegisterHostTools(config.tools)
  server.idbotsRegisterPolicyGate(config.policyTools)

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
