// DSH kernel adapter (Phase 1 M4): owns the DSH runtime subprocess and exposes
// the kernel-agnostic turn/control surface for cowork sessions.
//
// Lifecycle: ensureRuntime() generates the composition (provider table +
// prompt sections via dsh-runtime/lib/generate-runtime-config.mjs), writes it
// next to the session root, and spawns `node bin.mjs <config>` — in Electron
// the binary runs with ELECTRON_RUN_AS_NODE=1 so the packaged app needs no
// extra Node runtime. Credentials ride the child env (apiKeyEnv names), never
// the config file.
//
// Wire: @deepseek-ai/dsh-sdk-client (ESM, dynamic-imported like the Claude
// SDK) against idbots-sdk-server's extensions: session/ensure (create-or-
// resume + per-session provider route), session/steer, session/cancel,
// idbots/approval/respond.
//
// Events: session.event envelopes flow through DshEventMapper into the host's
// handlers — the same message/streaming/turn contract handleClaudeEvent
// produces for the Claude kernel.

import { app } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { DshEventMapper } from './dshEventMapper'
import type {
  DshApprovalAsk,
  DshHostToolImagePayload,
  DshKernelHandlers,
  DshUsageProjectionResult,
  DshUserQuestionAsk,
  DshMapperAction,
  DshRuntimeConfigInput,
  DshSessionEventEnvelope,
  DshStreamSlot,
} from './types'

const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<any>

export const DSH_PUMP_YIELD_EVERY = 8

export interface DshKernelOptions {
  /** Directory containing bin.mjs + node_modules (defaults: repo dsh-runtime/). */
  runtimeDir?: string
  /** Node executable override (tests). Defaults to process.execPath. */
  nodePath?: string
  handlers: DshKernelHandlers
  log?: (level: 'info' | 'warn' | 'error', message: string, detail?: unknown) => void
}

export class DshKernel {
  private readonly opts: DshKernelOptions
  private client: any = null
  private pump: Promise<void> | null = null
  private mappers = new Map<string, DshEventMapper>()
  private slotIds = new Map<string, Partial<Record<DshStreamSlot, string>>>()
  private runtimeConfig: DshRuntimeConfigInput | null = null
  private closed = false
  private pumpEventsSinceYield = 0

  constructor(opts: DshKernelOptions) {
    this.opts = opts
  }

  get runtimeDir(): string {
    if (this.opts.runtimeDir) return this.opts.runtimeDir
    if (process.env.IDBOTS_DSH_RUNTIME_DIR) return process.env.IDBOTS_DSH_RUNTIME_DIR
    // The main bundle lands at different depths depending on the build: the
    // vite dev bundle sits at dist-electron/main.js while tsc output lives at
    // dist-electron/main/libs/dshKernel/. Probe instead of guessing, with
    // app.getAppPath() (project root in dev) first.
    const candidates = [
      // Packaged builds ship dsh-runtime as an extra resource next to the
      // asar archive — real files on disk, which the spawned runtime needs
      // (asar paths would break module resolution inside the child).
      ...(app.isPackaged ? [join(process.resourcesPath, 'dsh-runtime')] : []),
      join(app.getAppPath(), 'dsh-runtime'),
      join(__dirname, 'dsh-runtime'),
      join(__dirname, '..', 'dsh-runtime'),
      join(__dirname, '..', '..', '..', 'dsh-runtime'),
      join(__dirname, '..', '..', '..', '..', 'dsh-runtime'),
    ]
    for (const candidate of candidates) {
      if (existsSync(join(candidate, 'bin.mjs'))) return candidate
    }
    return candidates[0]
  }

  get running(): boolean {
    return this.client !== null && !this.closed
  }

  /** Diagnostics/tests: how many times the runtime process was restarted. */
  restartCount = 0

  /** Generate config, spawn the runtime, and perform the wire handshake. */
  async ensureRuntime(config: DshRuntimeConfigInput): Promise<void> {
    if (this.closed) throw new Error('DshKernel: closed')
    if (this.client) {
      // Reuse the live runtime; regenerate config only when inputs changed.
      if (this.runtimeConfig && !shallowEqualConfig(this.runtimeConfig, config)) {
        await this.restart(config)
      }
      return
    }

    const runtimeDir = this.runtimeDir
    const binPath = join(runtimeDir, 'bin.mjs')
    if (!existsSync(binPath)) {
      throw new Error(`DshKernel: runtime bin not found at ${binPath} (run npm install in dsh-runtime/)`)
    }

    const generatorUrl = pathToFileURL(join(runtimeDir, 'lib', 'generate-runtime-config.mjs')).href
    const { generateRuntimeConfig } = await dynamicImport(generatorUrl)
    mkdirSync(config.sessionRoot, { recursive: true })
    const configPath = join(config.sessionRoot, 'cordis.runtime.json')
    writeFileSync(configPath, JSON.stringify(generateRuntimeConfig(config), null, 2))
    this.runtimeConfig = config

    const clientUrl = pathToFileURL(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-sdk-client', 'lib', 'index.js')).href
    const { HarnessClient } = await dynamicImport(clientUrl)
    const client = new HarnessClient({
      command: this.opts.nodePath ?? process.execPath,
      args: [binPath, configPath],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(config.env ?? {}) },
    })
    client.start()
    const first = config.providers[0]
    await client.initialize({
      cwd: config.sessionRoot,
      provider: first.key,
      model: first.models[0]?.id ?? 'default',
    })

    this.client = client
    this.closed = false
    this.pump = this.pumpNotifications(client)
    this.opts.log?.('info', 'dshKernel.ensureRuntime', { configPath, providers: config.providers.length })
  }

  /** Ensure a live agent for the session: fresh create or restart-resume. */
  async ensureSession(input: {
    sessionId: string
    provider?: string
    model?: string
    maxTokens?: number
    /** DSH/pi-ai ReasoningEffortId (off|low|medium|high|max). */
    reasoningEffort?: string
    sections?: Array<{ name: string; order: number; text: string }>
    hostTools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  }): Promise<{ resumed: boolean }> {
    this.requireClient()
    return this.client.request('session/ensure', input)
  }

  async prompt(
    sessionId: string,
    text: string,
    images?: DshHostToolImagePayload[]
  ): Promise<{ messageId: string }> {
    this.requireClient()
    if (!images || images.length === 0) {
      return this.client.prompt(sessionId, [{ type: 'text', text }])
    }
    // Image attachments ride the idbots/prompt extension: the runtime commits
    // them through its attachment store and queues [text, ...image blocks].
    return this.client.request('idbots/prompt', {
      sessionId,
      text,
      ...(images.length > 0 ? { images } : {}),
    })
  }

  async steer(sessionId: string, text: string): Promise<{ steered: boolean; messageId: string }> {
    this.requireClient()
    return this.client.request('session/steer', {
      sessionId,
      contentBlocks: [{ type: 'text', text }],
    })
  }

  async cancel(
    sessionId: string,
    cause?: string,
    options?: { keepInbox?: boolean }
  ): Promise<{ cancelled: boolean }> {
    this.requireClient()
    return this.client.request('session/cancel', {
      sessionId,
      cause,
      keepInbox: options?.keepInbox === true,
    })
  }

  async respondApproval(id: string, outcome: 'allowed-once' | 'rejected'): Promise<{ answered: boolean }> {
    this.requireClient()
    return this.client.request('idbots/approval/respond', { id, outcome })
  }

  /** Subagent panel: children of a DSH session. */
  async listSubagents(dshSessionId: string): Promise<{ agents: Array<{ agentId: string; status: string; startedAt: number }> }> {
    this.requireClient()
    return this.client.request('idbots/subagents/list', { sessionId: dshSessionId })
  }

  /** Subagent panel: transcript view of one child. */
  async getSubagentMessages(dshSessionId: string, agentId: string, limit?: number): Promise<{ messages: Array<{ id: string; type: string; content: string; timestamp: number }> }> {
    void dshSessionId
    this.requireClient()
    return this.client.request('idbots/subagents/messages', { sessionId: dshSessionId, agentId, limit })
  }

  /**
   * Official token-meter session projections for the usage panel (cumulative
   * disjoint token buckets + context pressure/composition). Degrades to
   * { available: false } when the runtime composition lacks the projection
   * registry or the session has no live agent.
   */
  async usageProjection(dshSessionId: string): Promise<DshUsageProjectionResult> {
    this.requireClient()
    return this.client.request('idbots/usage', { sessionId: dshSessionId })
  }

  /**
   * Idle-session native compaction (DSH /compact). Replaces a history span
   * in place on the live agent; does not mint a new session id.
   */
  async compact(dshSessionId: string): Promise<{
    ok: boolean
    compacted?: boolean
    code?: string
    message?: string
    shadowedItemCount?: number
    shadowedTokenCount?: number
  }> {
    this.requireClient()
    return this.client.request('idbots/compact', { sessionId: dshSessionId })
  }

  /** Answer a pending ask_user_question bridged from the runtime. */
  async respondAsk(
    id: string,
    answers: Array<{ id: string; selected: string[]; custom?: string }>
  ): Promise<{ answered: boolean }> {
    this.requireClient()
    return this.client.request('idbots/ask/respond', { id, answers })
  }

  /** Answer a runtime-native tool policy check. */
  async respondPolicy(id: string, decision: 'allow' | 'deny' | 'ask', reason?: string): Promise<{ answered: boolean }> {
    this.requireClient()
    return this.client.request('idbots/policy/respond', { id, decision, reason })
  }

  /** Answer a host tool bridge call. Images commit through the runtime's
   * attachment store and render as image blocks when the route allows. */
  async respondTool(
    id: string,
    result: { ok: true; text: string; images?: DshHostToolImagePayload[] } | { ok: false; error: string }
  ): Promise<{ answered: boolean }> {
    this.requireClient()
    return this.client.request('idbots/tool/respond', { id, ...result })
  }

  /** Latest usage snapshot for a session (getContextUsage equivalent). */
  usage(sessionId: string) {
    return this.mappers.get(sessionId)?.usage() ?? null
  }

  /** Kill the runtime (sessions persist; ensureRuntime can resume them). */
  async restart(config?: DshRuntimeConfigInput): Promise<void> {
    // client.close() owns the EOF→SIGTERM→SIGKILL ladder and reaps the child;
    // dropping the reference without closing leaks the runtime (its keepalive
    // interval would pin the parent's event loop).
    if (this.client) await this.client.close().catch(() => undefined)
    this.client = null
    this.pump = null
    this.mappers.clear()
    this.slotIds.clear()
    this.runtimeConfig = null
    if (config) {
      this.restartCount += 1
      await this.ensureRuntime(config)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.client) await this.client.close().catch(() => undefined)
    this.client = null
    this.pump = null
  }

  private requireClient(): void {
    if (!this.client) throw new Error('DshKernel: runtime not started (call ensureRuntime first)')
  }

  private async pumpNotifications(client: any): Promise<void> {
    try {
      const subscription = client.subscribe()
      for (;;) {
        const notification = await subscription.next()
        const { method, params } = notification
        if (method === 'session.event') {
          // One bad handler must never kill the whole event stream: contain
          // per-event failures and keep the pump alive.
          try {
            this.applyEvent(params.sessionId, params.event as DshSessionEventEnvelope)
          } catch (error) {
            // Contained per-event failure: log and keep pumping. onError is
            // the FATAL channel (transport death) that settles in-flight turns.
            this.opts.log?.('error', 'dshKernel.eventError', {
              message: error instanceof Error ? error.message : String(error),
              type: (params.event as DshSessionEventEnvelope)?.type,
            })
          }
        } else if (method === 'idbots/approval/request') {
          this.opts.handlers.onApprovalRequest(params.sessionId, params as DshApprovalAsk)
        } else if (method === 'idbots/approval/cancelled') {
          this.opts.handlers.onApprovalCancelled(params.id)
        } else if (method === 'idbots/tool/request') {
          this.opts.handlers.onToolRequest?.(params)
        } else if (method === 'idbots/policy/request') {
          this.opts.handlers.onPolicyRequest?.(params)
        } else if (method === 'idbots/ask/request') {
          this.opts.handlers.onAskRequest?.(params as DshUserQuestionAsk)
        } else if (method === 'idbots/ask/cancelled') {
          this.opts.handlers.onAskCancelled?.(params.id)
        } else if (method === 'idbots/subagent/started') {
          this.opts.handlers.onSubagentEvent?.({ kind: 'started', ...params })
        } else if (method === 'idbots/subagent/progress') {
          this.opts.handlers.onSubagentEvent?.({ kind: 'progress', ...params })
        } else if (method === 'idbots/subagent/finished') {
          this.opts.handlers.onSubagentEvent?.({ kind: 'finished', ...params })
        } else if (method === 'session.status') {
          this.opts.handlers.onStatus?.(params.sessionId, params.status)
        }
        // Yield so session-switch / other IPC can run while two sessions
        // stream. The pump is a single sequential loop; without this, handler
        // work (even after persist is deferred) still head-of-line-blocks
        // cowork:session:get.
        this.pumpEventsSinceYield += 1
        if (this.pumpEventsSinceYield >= DSH_PUMP_YIELD_EVERY) {
          this.pumpEventsSinceYield = 0
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      }
    } catch (error) {
      if (!this.closed) this.opts.handlers.onError?.(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private applyEvent(sessionId: string, envelope: DshSessionEventEnvelope): void {
    if (!sessionId) return
    const mapper = this.mappers.get(sessionId) ?? new DshEventMapper()
    this.mappers.set(sessionId, mapper)
    for (const action of mapper.consume(envelope)) {
      this.applyAction(sessionId, action)
    }
  }

  private applyAction(sessionId: string, action: DshMapperAction): void {
    const handlers = this.opts.handlers
    switch (action.kind) {
      case 'message': {
        const id = handlers.onMessage(sessionId, action.message, action.slot)
        if (action.slot) {
          const slots = this.slotIds.get(sessionId) ?? {}
          slots[action.slot] = id
          this.slotIds.set(sessionId, slots)
        }
        break
      }
      case 'messageUpdate': {
        const id = this.slotId(sessionId, action.slot)
        if (id) handlers.onMessageUpdate(sessionId, id, action.content)
        break
      }
      case 'messageFinalize': {
        const id = this.slotId(sessionId, action.slot)
        if (id) handlers.onMessageFinalize(sessionId, id, action.content, action.metadata)
        break
      }
      case 'turnEnd':
        handlers.onTurnEnd(sessionId, action.reason, action.emptyTerminal)
        break
      case 'usage':
        handlers.onUsage(sessionId, action.usage)
        break
    }
  }

  private slotId(sessionId: string, slot: DshStreamSlot): string | undefined {
    return this.slotIds.get(sessionId)?.[slot]
  }
}

function shallowEqualConfig(a: DshRuntimeConfigInput, b: DshRuntimeConfigInput): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
