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
//   session/ensure         { sessionId, provider?, model?, maxTokens?,
//                           reasoningEffort? } → live agent for the
//                           session: create fresh, or RESUME when a persisted log exists
//                           (the stock server only lazily creates and would fail on an
//                           existing log after a runtime restart). Also the per-session
//                           provider/model/effort override the stock wire lacks — a live
//                           ensure reapplies the route through the agent/request
//                           waterfall so a mid-conversation model switch actually
//                           reaches the next LLM call (the loop otherwise keeps
//                           seeding from the first-turn session header).
//   idbots/approval/respond { id, outcome } → answer a pending approval ask (M2)
//   idbots/ask/respond       { id, answers } → answer a pending user question
//   idbots/usage             { sessionId } → token-meter session projections
//                           (tokenUsage / contextPressure / contextBreakdown)
//   idbots/ping            → extension presence canary
//
// Notifications we emit (beyond the stock session.event / session.status /
// subagent.* set):
//
//   idbots/approval/request   { id, sessionId, toolName, callId?, reason? }
//   idbots/approval/cancelled { id }
//   idbots/ask/request        { id, sessionId, questions } (ask_user_question)
//   idbots/ask/cancelled      { id }
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
    this.idbotsAsks = new Map() // id → { resolve, reject }
    this.idbotsAskSeq = 0
    // Per-agent route for the agent/request waterfall (UI model+effort selector).
    // Mid-session model switches MUST override provider/model here — after the
    // first turn the loop seeds every request from the persisted session
    // header, so ensure() updating only effort left the live agent on the
    // original model (qwen + DeepSeek's "max" → UNSUPPORTED_REASONING_EFFORT).
    this.idbotsRoute = new Map()
    this.idbotsRouteBound = new WeakSet()
    // Subagent lineage for the panel: parent dsh id → [{agentId, status, startedAt}]
    this.idbotsSubagentChildren = new Map()
    // Ring buffers of child session events for transcript viewing.
    this.idbotsChildEvents = new Map()
    // child agent id → parent dsh session id (for live row notifications).
    this.idbotsChildParents = new Map()

    ctx.on('agent/created', ({ agent }) => {
      this.idbotsAgents.set(String(agent.id), agent)
      // Subagent lineage lives FLATTENED on the session header (not under a
      // meta subobject): header.origin === 'subagent' + header.parentSession.
      const header = agent?.session?.header
      if (header?.origin === 'subagent' && header?.parentSession !== undefined) {
        const parent = String(header.parentSession)
        const agentId = String(agent.id)
        const children = this.idbotsSubagentChildren.get(parent) ?? []
        children.push({ agentId, status: 'running', startedAt: Date.now() })
        this.idbotsSubagentChildren.set(parent, children)
        this.idbotsChildEvents.set(agentId, [])
        this.idbotsChildParents.set(agentId, parent)
        // Live task rows: the host renders these through the same
        // task_started/task_notification channel the Claude path emits.
        this.idbotsTransport.notify('idbots/subagent/started', { sessionId: parent, agentId })
      }
    }, { global: true })
    ctx.on('agent/disposed', ({ agent }) => {
      for (const children of this.idbotsSubagentChildren.values()) {
        const entry = children.find((c) => c.agentId === String(agent.id))
        if (entry) entry.status = 'done'
      }
      const agentId = String(agent.id)
      const parent = this.idbotsChildParents.get(agentId)
      if (parent !== undefined) {
        this.idbotsChildParents.delete(agentId)
        this.idbotsTransport.notify('idbots/subagent/finished', { sessionId: parent, agentId, status: 'completed' })
      }
    }, { global: true })
    // Buffer child session events for the panel transcript view; the first
    // user message (the delegation prompt) also rides a progress
    // notification so the live row gets a meaningful summary.
    ctx.on('session/event', (session, event) => {
      const sid = typeof session === 'string' ? session : String(session?.id ?? '')
      if (!sid || !this.idbotsChildEvents.has(sid)) return
      const buffer = this.idbotsChildEvents.get(sid)
      const hadUserMessage = buffer.some((e) => e.type === 'user/message')
      buffer.push(event)
      if (buffer.length > 500) buffer.splice(0, buffer.length - 500)
      const parent = this.idbotsChildParents.get(sid)
      if (!hadUserMessage && event.type === 'user/message' && parent !== undefined) {
        const text = (event.data?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text ?? '').join(' ').trim()
        if (text.length > 0) {
          this.idbotsTransport.notify('idbots/subagent/progress', {
            sessionId: parent,
            agentId: sid,
            summary: text.length > 160 ? `${text.slice(0, 157)}...` : text,
          })
        }
      }
    })
    ctx.on('agent/disposed', ({ agent }) => {
      this.idbotsAgents.delete(String(agent.id))
      this.idbotsRoute.delete(String(agent.id))
    }, { global: true })

    ctx.on('approval/request', (req, next) => this.idbotsBridgeApproval(req, next), { global: true })
    // inject (not effect): the service may mount after this plugin; the
    // fiber activates whenever `userQuestions` becomes available.
    ctx.inject(['userQuestions'], () => this.idbotsRegisterAskProvider())
    // Same reactive pattern for the projection registry: reading
    // ctx.sessionProjections without declaring inject throws in cordis, and a
    // hard inject would keep this plugin from ever mounting in compositions
    // without idbots-session-projections. The fiber delivers the registry
    // when present; idbots/usage answers available:false otherwise.
    this.idbotsProjections = null
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      this.idbotsProjections = projectionCtx.sessionProjections
      return () => { this.idbotsProjections = null }
    })
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
      case 'idbots/prompt': return this.idbotsPrompt(params)
      case 'idbots/approval/respond': return this.idbotsApprovalRespond(params)
      case 'idbots/tool/respond': return this.idbotsToolRespond(params)
      case 'idbots/policy/respond': return this.idbotsPolicyRespond(params)
      case 'idbots/ask/respond': return this.idbotsAskRespond(params)
      case 'idbots/subagents/list': return this.idbotsSubagentsList(params)
      case 'idbots/subagents/messages': return this.idbotsSubagentsMessages(params)
      case 'idbots/usage': return this.idbotsUsage(params)
      case 'idbots/ping': {
        return {
          pong: true,
          extensions: ['session/steer', 'session/cancel', 'session/ensure', 'idbots/prompt', 'idbots/approval/respond', 'idbots/tool/respond', 'idbots/ask/respond', 'idbots/usage'],
        }
      }
      default: return super.handleRequest(method, params)
    }
  }

  async idbotsEnsureSession(hostParams) {
    const { sessionId, provider, model, maxTokens, reasoningEffort } = hostParams ?? {}
    const id = String(sessionId ?? '')
    if (id.length === 0) throw new Error('idbots-sdk-server: session/ensure requires sessionId')
    if (this.idbotsAgents.has(id)) {
      this.idbotsBindRoute(this.idbotsAgents.get(id), { provider, model, maxTokens, reasoningEffort })
      return { ensured: true, resumed: false }
    }

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
    this.idbotsBindRoute(handle.agent, { provider, model, maxTokens, reasoningEffort })
    // Register with the stock server's bookkeeping (private at the type level,
    // present at runtime) so its lazy session/prompt create reuses this agent
    // instead of colliding on the registry id.
    this.sessions.set(id, { handle })
    return { ensured: true, resumed }
  }

  /**
   * Pin this agent's next LLM request to the host's model+effort selector.
   * Same seam installModelSelection uses: after the first turn the loop seeds
   * every request from the persisted session header, so a live ensure() that
   * only touched effort left provider/model stuck on the original pick.
   * An explicit effort wins; an absent effort strips the inherited value so
   * the adapter falls back to the route default (DeepSeek: high; pi-ai: none).
   */
  idbotsBindRoute(agent, route) {
    if (!agent) return
    const id = String(agent.id)
    const provider = typeof route?.provider === 'string' ? route.provider.trim() : ''
    const model = typeof route?.model === 'string' ? route.model.trim() : ''
    const effort = typeof route?.reasoningEffort === 'string' ? route.reasoningEffort.trim() : ''
    this.idbotsRoute.set(id, {
      ...(provider.length > 0 ? { provider } : {}),
      ...(model.length > 0 ? { model } : {}),
      ...Number.isFinite(route?.maxTokens) ? { maxTokens: route.maxTokens } : {},
      ...(effort.length > 0 ? { reasoningEffort: effort } : {}),
    })
    if (this.idbotsRouteBound.has(agent) || !agent.ctx?.on) return
    this.idbotsRouteBound.add(agent)
    agent.ctx.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      const bound = this.idbotsRoute.get(String(agent.id))
      if (bound === undefined) return resolved
      const {
        reasoningEffort: _inheritedEffort,
        provider: _inheritedProvider,
        model: _inheritedModel,
        ...rest
      } = resolved ?? {}
      return {
        ...rest,
        provider: bound.provider || resolved?.provider,
        model: bound.model || resolved?.model,
        ...Number.isFinite(bound.maxTokens) ? { maxTokens: bound.maxTokens } : {},
        ...(bound.reasoningEffort ? { reasoningEffort: bound.reasoningEffort } : {}),
      }
    })
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

  // Prompt submission with optional image attachments: the host reads the
  // image files (attachment marker lines carry no bytes over the wire), the
  // runtime commits them through the attachments store and queues the user
  // message as [text, ...image blocks] via the stock prompt path. Same route
  // gate as tool-result images: a user message is durable history, so a
  // text-only route never receives image blocks — an omission note rides the
  // text instead.
  async idbotsPrompt({ sessionId, text, images }) {
    let content = [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text ?? '') }]
    const imageList = Array.isArray(images) ? images.filter((image) => typeof image?.data === 'string' && image.data.length > 0) : []
    if (imageList.length > 0) {
      const rec = await this.getOrCreateSession(sessionId)
      const agent = rec?.handle?.agent
      const attachments = this.ctx.get('attachments')
      const imageCapable = attachments !== undefined && await this.idbotsRouteAcceptsImages(agent)
      if (imageCapable) {
        for (const image of imageList) {
          const ref = await attachments.saveImage({
            data: Uint8Array.from(Buffer.from(image.data, 'base64')),
            mediaType: image.mediaType,
            ...typeof image.name === 'string' && image.name.length > 0 ? { name: image.name } : {},
          })
          content.push({ type: 'image', attachment: ref })
        }
      } else {
        content = [{
          type: 'text',
          text: `${content[0].text}\n[idbots: ${imageList.length} attached image${imageList.length === 1 ? '' : 's'} omitted — the active model does not accept image input; their file paths stay in the text above]`,
        }]
      }
    }
    return this.prompt({ sessionId, contentBlocks: content })
  }

  async idbotsCancel({ sessionId, cause, keepInbox }) {
    const agent = this.liveAgent(sessionId)
    // Report whether an abort actually fired: a cancel against an idle agent
    // is a documented no-op that never emits a turn boundary, and the host's
    // steer latch arms only on a real interrupt.
    const cancelled = agent.status === 'running'
    agent.cancel(cause ?? 'idbots client cancel', { keepInbox: keepInbox === true })
    return { cancelled }
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
  //
  // Image results: a respond may carry `images: [{ data: <base64>, mediaType,
  // name? }]` alongside `text`. Each image is committed through the
  // attachments service (durable, content-addressed) and rendered as a DSH
  // image block next to the text. The route is gated first — a tool result is
  // durable session history, so emitting an image on a route whose model does
  // not declare image input would poison that session's continuation with a
  // permanent conversion error. Non-image routes (or a missing attachment
  // store) degrade to text plus an omission note instead.

  /** True when the calling agent's resolved route declares image input. */
  async idbotsRouteAcceptsImages(agent) {
    try {
      const routed = agent?.session?.requestHeader?.()?.config
      const provider = routed?.provider ?? agent?.options?.provider
      const model = routed?.model ?? agent?.options?.model
      const llm = this.ctx.get('llm')
      if (provider === undefined || model === undefined || llm === undefined) return false
      const info = await llm.resolveModelInfo(provider, model)
      return info?.inputModalities?.includes('image') === true
    } catch {
      return false
    }
  }

  /** Build one host-bridged tool proxy (shared by global and agent-scoped registration). */
  idbotsMakeHostTool(definition) {
    const server = this
    return {
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (args, value) => {
            const blocks = [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }]
            for (const image of Array.isArray(value?.images) ? value.images : []) {
              if (typeof image?.attachmentId !== 'string') continue
              blocks.push({
                type: 'image',
                attachment: {
                  attachmentId: image.attachmentId,
                  mediaType: image.mediaType,
                  bytes: image.bytes,
                  width: image.width,
                  height: image.height,
                  ...image.name !== undefined ? { name: image.name } : {},
                },
              })
            }
            return blocks
          },
        },
      execute: async (args, exec) => {
        const id = `tool-${Date.now().toString(36)}-${++server.idbotsToolSeq}`
        const pending = new Promise((resolve, reject) => {
          server.idbotsToolPending.set(id, { resolve, reject, agent: exec.agent })
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
        return pending // { text, images? } on success; throws on host error/abort
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

  async idbotsToolRespond({ id, ok, text, error, images }) {
    const entry = this.idbotsToolPending.get(String(id))
    if (entry === undefined) {
      throw new Error(`idbots-sdk-server: no pending host tool ${JSON.stringify(id)}`)
    }
    this.idbotsToolPending.delete(String(id))
    if (ok === false) {
      entry.reject(new Error(typeof error === 'string' && error ? error : 'host tool failed'))
      return { answered: true, id }
    }
    entry.resolve(await this.idbotsMaterializeToolValue(entry.agent, text, images))
    return { answered: true, id }
  }

  /**
   * Turn a host respond into the tool's canonical value: commit image
   * payloads through the attachments store when the route can carry them,
   * degrade to a text note when it cannot. Never emits an image the active
   * route rejects — the tool result is durable history.
   */
  async idbotsMaterializeToolValue(agent, text, images) {
    const value = { text: typeof text === 'string' ? text : JSON.stringify(text ?? null) }
    if (!Array.isArray(images) || images.length === 0) return value
    const attachments = this.ctx.get('attachments')
    const imageCapable = attachments !== undefined && await this.idbotsRouteAcceptsImages(agent)
    if (!imageCapable) {
      return {
        ...value,
        text: `${value.text}\n[idbots: ${images.length} image${images.length === 1 ? '' : 's'} from this tool result omitted — the active model does not accept image input]`,
      }
    }
    const saved = []
    for (const image of images) {
      if (typeof image?.data !== 'string' || image.data.length === 0) continue
      saved.push(await attachments.saveImage({
        data: Uint8Array.from(Buffer.from(image.data, 'base64')),
        mediaType: image.mediaType,
        ...typeof image.name === 'string' && image.name.length > 0 ? { name: image.name } : {},
      }))
    }
    return saved.length > 0 ? { ...value, images: saved } : value
  }

  // ---- user-questions bridge ---------------------------------------------------
  //
  // The dsh-user-questions service seam + dsh-tool-ask-user expose the
  // model-facing ask_user_question tool; the UI-side PROVIDER is deployment
  // ownership. This bridge forwards each ask to the Electron host
  // (idbots/ask/request out, idbots/ask/respond back) whose renderer renders
  // it through the same AskUserQuestion modal the Claude path uses. The turn
  // signal settles unanswered asks (the tool contract requires settling).

  idbotsRegisterAskProvider() {
    const service = this.ctx.get('userQuestions')
    if (service === undefined) return () => undefined
    return service.registerProvider({
      ask: async (request) => {
        const id = `ask-${Date.now().toString(36)}-${++this.idbotsAskSeq}`
        const questions = Array.isArray(request?.questions) ? request.questions : []
        const pending = new Promise((resolve, reject) => {
          this.idbotsAsks.set(id, { resolve, reject })
        })
        this.idbotsTransport.notify('idbots/ask/request', {
          id,
          sessionId: String(request?.agent?.id ?? ''),
          questions,
        })
        request?.signal?.addEventListener('abort', () => {
          const entry = this.idbotsAsks.get(id)
          if (entry === undefined) return
          this.idbotsAsks.delete(id)
          entry.reject(new Error('ask_user_question was aborted before the user answered'))
          this.idbotsTransport.notify('idbots/ask/cancelled', { id })
        }, { once: true })
        return pending
      },
    })
  }

  async idbotsAskRespond({ id, answers, error }) {
    const entry = this.idbotsAsks.get(String(id))
    if (entry === undefined) {
      throw new Error(`idbots-sdk-server: no pending user question ${JSON.stringify(id)}`)
    }
    this.idbotsAsks.delete(String(id))
    if (error !== undefined) {
      entry.reject(new Error(typeof error === 'string' && error ? error : 'ask failed'))
    } else {
      entry.resolve({
        answers: Array.isArray(answers)
          ? answers.filter((a) => a && typeof a === 'object' && typeof a.id === 'string')
              .map((a) => ({
                id: a.id,
                selected: Array.isArray(a.selected) ? a.selected.map(String) : [],
                ...typeof a.custom === 'string' && a.custom.length > 0 ? { custom: a.custom } : {},
              }))
          : [],
      })
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
    // read/read_image ride the gate so the host can apply its Read guards
    // (non-vision image block, unchanged-file re-read dedup).
    const gated = new Set(policyTools ?? ['bash', 'write', 'edit', 'read', 'read_image'])
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

  // ---- usage projections ------------------------------------------------------
  //
  // idbots/usage reads the official token-meter session projections through
  // ctx.sessionProjections.snapshot(): the durable cumulative tokenUsage
  // buckets (uncachedInput/output/cacheRead/cacheWrite — disjoint), the newest
  // contextPressure sample, and the heuristic contextBreakdown composition.
  // The snapshot is replay-derived, so it stays correct across runtime
  // restarts (the resumed log refolds lazily). Graceful absence: a runtime
  // composed without the projection registry or token-meter answers
  // { available: false } and the host keeps its last persisted stats.

  idbotsUsage({ sessionId }) {
    const id = String(sessionId ?? '')
    if (this.idbotsProjections === null) {
      return { available: false, reason: 'session-projections not composed' }
    }
    const agent = this.idbotsAgents.get(id)
    if (agent === undefined || agent?.session === undefined) {
      return { available: false, reason: `no live agent for session ${id || '(none)'}` }
    }
    const snapshot = this.idbotsProjections.snapshot(agent.session)
    return {
      available: true,
      asOfSeq: snapshot.asOfSeq,
      tokenUsage: snapshot.values.tokenUsage ?? null,
      contextPressure: snapshot.values.contextPressure ?? null,
      contextBreakdown: snapshot.values.contextBreakdown ?? null,
    }
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
    // Mirror the rc.8 stock server: `initialize` is the readiness boundary, so
    // do not answer it until async sibling Loader entries (e.g. an MCP
    // client's initial tool discovery) have settled.
    if (method === 'initialize') await ctx.get('loader')?.await()
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
