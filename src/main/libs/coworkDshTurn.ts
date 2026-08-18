// DSH turn orchestration for cowork sessions (Phase 1 M5).
//
// DshTurnHub owns one DshKernel (and therefore one runtime subprocess) for the
// whole CoworkRunner and multiplexes its single notification stream to the
// per-session turn controllers. DshTurnController drives one active turn:
// ensure → prompt → mapper actions → turn end, with native steer/cancel and
// approval bridging. The kernel resolves streaming slots to message ids
// internally, so the hub only routes resolved callbacks to the owner of each
// session — every message lands through the same callbacks the Claude path
// uses (store.addMessage + runner events).

import { app } from 'electron'
import { join } from 'path'
import {
  getMetaidRpcToken,
  getMetaidRpcTokenFilePath,
  METAID_RPC_AUTHFILE_ENV,
} from '../services/metaidRpcEndpoint'
import { DshKernel } from './dshKernel/dshKernel'
import type { DshKernelOptions } from './dshKernel/dshKernel'
import type {
  DshApprovalAsk,
  DshHostToolImagePayload,
  DshMcpServerDefinition,
  DshUsageProjectionResult,
  DshUserQuestionAsk,
  DshPromptSectionInput,
  DshProviderRoute,
  DshRuntimeConfigInput,
  DshStreamSlot,
  DshUsageSnapshot,
} from './dshKernel/types'

export interface DshTurnProviderRoute {
  key: string
  apiFormat: 'openai' | 'responses' | 'anthropic'
  baseUrl: string
  apiKey: string
  /** Env var name the credential rides to the runtime child under. */
  apiKeyEnvName?: string
  model: string
  contextWindow?: number
  maxOutputTokens?: number
  thinkingFormat?: string
  /** Input modalities the model declares (['text','image'] for vision models). */
  inputModalities?: string[]
  /** Per-turn DSH/pi-ai reasoning effort (off|low|medium|high|max). */
  reasoningEffort?: string
}

/** Env var carrying the DeepSeek key for the runtime's web-search provider. */
const DSH_WEBSEARCH_API_KEY_ENV = 'IDBOTS_DSH_DEEPSEEK_WEBSEARCH_KEY'
/** Model serving the auxiliary search call (cheap + fast; search quality is
 *  provider-side, the model only formats the query — official DSH default). */
const DSH_WEBSEARCH_MODEL = 'deepseek-v4-flash'

/** Hostname of a URL string, '' when it does not parse (regex, not URL — an
 *  invalid base can never throw here; port/userinfo are not provider shapes). */
function hostnameOf(value: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(value.trim())
  return match?.[1]?.toLowerCase() ?? ''
}

/** True when the route is the official DeepSeek provider (key or api host). */
export function isOfficialDeepSeekRoute(provider: Pick<DshTurnProviderRoute, 'key' | 'baseUrl'>): boolean {
  return provider.key?.toLowerCase() === 'deepseek' || hostnameOf(provider.baseUrl) === 'api.deepseek.com'
}

/**
 * Normalize any DeepSeek provider base URL onto the Anthropic-compatible root
 * the web-search provider expects (`/messages` is appended by the package):
 * `https://api.deepseek.com` / `.../anthropic` / `.../responses`-style bases
 * all resolve to `<root>/anthropic/v1`.
 */
export function deepSeekWebSearchBaseURL(baseUrl: string): string {
  let base = baseUrl.trim().replace(/\/+$/, '')
  base = base.replace(/\/responses$/, '')
  if (/\/anthropic\/v\d+$/.test(base)) return base
  if (/\/anthropic$/.test(base)) return `${base}/v1`
  return `${base}/anthropic/v1`
}

export interface DshTurnCallbacks {
  onMessage: (
    message: { type: string; content: string; metadata?: Record<string, unknown> },
    slot?: DshStreamSlot
  ) => string
  onMessageUpdate: (messageId: string, content: string) => void
  onMessageFinalize: (messageId: string, content: string, metadata?: { isThinking?: boolean }) => void
  onUsage: (usage: DshUsageSnapshot) => void
  onApprovalRequest: (ask: DshApprovalAsk) => void
  onApprovalCancelled: (askId: string) => void
  onAskRequest?: (ask: DshUserQuestionAsk) => void
  onAskCancelled?: (askId: string) => void
  onSubagentEvent?: (event: {
    kind: 'started' | 'progress' | 'finished'
    sessionId: string
    agentId: string
    summary?: string
    status?: string
  }) => void
  onError?: (error: Error) => void
}

export interface DshTurnInput {
  /** Cowork session id (store key). */
  sessionId: string
  /** Host-bridged tool schemas to expose to the model this turn. */
  hostTools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  /** Workspace mount for DSH-native bash/fs tools. */
  workspace?: { cwd: string }
  /** DSH session id (without the dsh: prefix). */
  dshSessionId: string
  provider: DshTurnProviderRoute
  /** Stable prompt layers (promptComposer sections). */
  sections: DshPromptSectionInput[]
  /** Full user-visible turn text (volatile context already prepended). */
  prompt: string
  /** Image attachments to commit and send alongside the prompt text. */
  promptImages?: DshHostToolImagePayload[]
  callbacks: DshTurnCallbacks
}

export interface DshTurnOutcome {
  kind: string
  reason?: string
  /** True when the turn stopped cleanly having produced no text and no tool
   * calls (the DeepSeek reasoning-only truncation signature). */
  emptyTerminal?: boolean
}

class DshTurnController {
  readonly dshSessionId: string
  private readonly callbacks: DshTurnCallbacks
  private settleTurn!: (reason: DshTurnOutcome) => void
  private readonly turnDone: Promise<DshTurnOutcome>
  private steerWaiters: Array<(text: string) => void> = []
  /**
   * Set while a steer's inbox message has not been consumed by a follow-up
   * turn yet. Any turn boundary that arrives in this state — the steer's own
   * cancel(keepInbox) abort, or a natural end racing the steer — is swallowed
   * instead of settling the turn: the preserved inbox steer is waking input,
   * so a follow-up turn is guaranteed and the caller's single runTurn must
   * stay open until the steered exchange finishes. Only fatal outcomes
   * (kind 'error') and non-steer aborts (user stop, stall watchdog) settle
   * through; see handleTurnEnd.
   */
  private steerFollowUpExpected = false

  constructor(input: DshTurnInput) {
    this.dshSessionId = input.dshSessionId
    this.callbacks = input.callbacks
    this.turnDone = new Promise((resolve) => { this.settleTurn = resolve })
  }

  done(): Promise<DshTurnOutcome> {
    return this.turnDone
  }

  handleTurnEnd(reason: { kind: string; reason?: unknown }, emptyTerminal?: boolean): void {
    const outcome = emptyTerminal === true ? { ...reason, emptyTerminal: true } : reason
    // Fatal outcomes and non-steer aborts (user stop, stall watchdog) always
    // settle through — a pending steer never outranks them.
    const settlesThrough = reason.kind === 'error'
      || (reason.kind === 'aborted' && reason.reason !== 'steer')
    if (this.steerFollowUpExpected && !settlesThrough) {
      // Swallow exactly one boundary — the steer's cancel(keepInbox) abort,
      // or a natural end that raced the steer (an unconsumed inbox steer is
      // waking input, so a follow-up turn is guaranteed and owns settlement).
      this.steerFollowUpExpected = false
      return
    }
    this.steerFollowUpExpected = false
    this.settleTurn(outcome as DshTurnOutcome)
    for (const waiter of this.steerWaiters.splice(0)) waiter('')
  }

  /** Arm the swallow above: the next steer-abort boundary belongs to us. */
  expectSteerFollowUp(): void {
    this.steerFollowUpExpected = true
  }

  /** Disarm without settling — used when the steer/cancel RPCs failed. */
  clearSteerFollowUp(): void {
    this.steerFollowUpExpected = false
  }

  notifySteerDelivered(text: string): void {
    for (const waiter of this.steerWaiters.splice(0)) waiter(text)
  }

  waitForSteerDelivery(): Promise<string> {
    return new Promise((resolve) => this.steerWaiters.push(resolve))
  }

  get cb(): DshTurnCallbacks {
    return this.callbacks
  }
}

export interface DshHubOptions {
  runtimeDir?: string
  /** Session-root directory under userData (versioned per format). */
  sessionRoot: string
  /** Execute a host-bridged tool call; resolves {ok,text,images?} or rejects. */
  executeTool?: (coworkSessionId: string, name: string, args: Record<string, unknown>) => Promise<{ ok: true; text: string; images?: DshHostToolImagePayload[] } | { ok: false; error: string }>
  /** Host permission chain for runtime-native tools (bash/write/edit…). */
  evaluatePolicy?: (coworkSessionId: string, name: string, args: Record<string, unknown>) => Promise<{ decision: 'allow' | 'deny' | 'ask'; reason?: string }>
  /** User-configured MCP servers, read fresh each turn (additions mount on the
   * next turn; the config union never removes until restart, same as providers). */
  mcpServersProvider?: () => DshMcpServerDefinition[]
  log?: DshKernelOptions['log']
  /** Extra composition entries for the runtime (test fixtures; later the
   * idbots tools/policy plugins mount here). */
  extraEntries?: Array<Record<string, unknown>>
  /** Re-read every turn (unlike the static extraEntries): the user-managed
   * plugin directory feeds entries here, so an install/uninstall applies on
   * the next turn — config-change restart waits for quiescence as usual. */
  extraEntriesProvider?: () => Array<Record<string, unknown>>
}

export class DshTurnHub {
  private kernel: DshKernel | null = null
  /** Keyed by DSH session id — that is what kernel event callbacks carry. */
  private controllersByDsh = new Map<string, DshTurnController>()
  /** cowork session id → DSH session id (steer/cancel look up by cowork id). */
  private dshByCowork = new Map<string, string>()
  /** Reverse mapping for tool-request routing. */
  private coworkByDsh = new Map<string, string>()
  /** cowork id → dsh id, kept across turns for post-hoc panel lookups. */
  private pinnedDshIds = new Map<string, string>()
  private readonly opts: DshHubOptions

  constructor(opts: DshHubOptions) {
    this.opts = opts
  }

  /** Start (or reuse) the runtime and run one turn to completion. */
  async runTurn(input: DshTurnInput): Promise<DshTurnOutcome> {
    const kernel = await this.ensureKernel(input)
    const controller = new DshTurnController(input)
    // One active turn per cowork session: a stray previous controller (e.g. a
    // turn that never settled) must not swallow events.
    this.controllersByDsh.set(input.dshSessionId, controller)
    this.dshByCowork.set(input.sessionId, input.dshSessionId)
    this.coworkByDsh.set(input.dshSessionId, input.sessionId)
    this.pinnedDshIds.set(input.sessionId, input.dshSessionId)

    try {
      await kernel.ensureSession({
        sessionId: input.dshSessionId,
        provider: input.provider.key,
        model: input.provider.model,
        ...Number.isFinite(input.provider.maxOutputTokens) ? { maxTokens: input.provider.maxOutputTokens } : {},
        ...(input.provider.reasoningEffort ? { reasoningEffort: input.provider.reasoningEffort } : {}),
        sections: input.sections,
        hostTools: input.hostTools,
      })
      await kernel.prompt(input.dshSessionId, input.prompt, input.promptImages)
      return await controller.done()
    } finally {
      this.controllersByDsh.delete(input.dshSessionId)
      this.dshByCowork.delete(input.sessionId)
      this.coworkByDsh.delete(input.dshSessionId)
    }
  }

  private controllerOfCowork(sessionId: string): DshTurnController | undefined {
    const dshId = this.dshByCowork.get(sessionId)
    return dshId === undefined ? undefined : this.controllersByDsh.get(dshId)
  }

  /**
   * Interrupt-on-steer (parity with the local path's interrupt semantics):
   * cancel the active turn with keepInbox FIRST, then submit the steer. The
   * order is load-bearing — the runtime's wake latch only arms for waking
   * input submitted while the abort is converging (or after it reaches
   * idle); a steer submitted BEFORE the cancel parks in the inbox with
   * nobody left to wake it (verified against dsh-agent-loop: the aborted
   * turn exits the driver without the inbox continuation check, so the steer
   * sits dormant until some later wake). Submitted after, the preserved
   * steer wakes a follow-up turn that consumes the correction as its next
   * turn input.
   */
  async steer(sessionId: string, text: string): Promise<void> {
    const controller = this.controllerOfCowork(sessionId)
    if (!controller || !this.kernel) throw new Error('DshTurnHub: no active turn for steer')
    // Arm the boundary latch only when the cancel actually interrupted a
    // running activity. A no-op cancel against an idle agent (steer racing
    // turn start, or a second steer after a first abort already converged)
    // never emits the steer-abort boundary — arming there would swallow the
    // turn's natural end instead. Older runtime builds always report
    // cancelled:true, so only an explicit false skips the latch.
    let interrupted = true
    try {
      const cancelResult = await this.kernel.cancel(controller.dshSessionId, 'steer', { keepInbox: true })
      interrupted = cancelResult.cancelled !== false
    } catch (error) {
      // No interrupt happened: plain step-boundary steering, nothing armed.
      throw error
    }
    if (interrupted) controller.expectSteerFollowUp()
    try {
      await this.kernel.steer(controller.dshSessionId, text)
    } catch (error) {
      // Interrupt landed but the steer never queued: disarm so the aborted
      // turn's boundary settles normally; the steer itself is lost (the
      // caller's delivery promise settles empty at turn end).
      controller.clearSteerFollowUp()
      throw error
    }
    controller.notifySteerDelivered(text)
  }

  /**
   * Watchdog escape hatch: settle the active turn controller directly when
   * the runtime cannot — a cancel against an idle agent (no active activity)
   * is a documented no-op that never emits turnEnd, so a controller whose
   * boundary was swallowed (steer follow-up that never woke) would otherwise
   * await forever. Same no-op safety as a normal double settle.
   */
  forceSettle(sessionId: string, reason: string): void {
    this.controllerOfCowork(sessionId)?.handleTurnEnd({ kind: 'aborted', reason })
  }

  /** Resolves when the steer text was delivered (or the turn ended first). */
  waitForSteerDelivery(sessionId: string): Promise<string> {
    return this.controllerOfCowork(sessionId)?.waitForSteerDelivery() ?? Promise.resolve('')
  }

  async cancel(sessionId: string, cause?: string): Promise<void> {
    const controller = this.controllerOfCowork(sessionId)
    if (!controller || !this.kernel) return
    await this.kernel.cancel(controller.dshSessionId, cause)
  }

  /** Subagent panel (cowork session id in, DSH routing inside). */
  async listSubagents(coworkSessionId: string): Promise<Array<{ agentId: string; status: string; startedAt: number }>> {
    if (!this.kernel) return []
    const dshId = this.dshByCowork.get(coworkSessionId) ?? this.pinnedDshIds.get(coworkSessionId)
    if (!dshId) return []
    const result = await this.kernel.listSubagents(dshId)
    return result.agents ?? []
  }

  async getSubagentMessages(coworkSessionId: string, agentId: string, limit?: number): Promise<Array<{ id: string; type: string; content: string; timestamp: number }>> {
    if (!this.kernel) return []
    const dshId = this.dshByCowork.get(coworkSessionId) ?? this.pinnedDshIds.get(coworkSessionId)
    if (!dshId) return []
    const result = await this.kernel.getSubagentMessages(dshId, agentId, limit)
    return result.messages ?? []
  }

  /**
   * Official token-meter projections for the usage panel (cowork session id
   * in, DSH routing inside; post-turn safe via the pinned-id fallback).
   * Null when the runtime is down or the cowork session never ran on DSH.
   */
  async usageProjection(coworkSessionId: string): Promise<DshUsageProjectionResult | null> {
    if (!this.kernel) return null
    const dshId = this.dshByCowork.get(coworkSessionId) ?? this.pinnedDshIds.get(coworkSessionId)
    if (!dshId) return null
    return this.kernel.usageProjection(dshId)
  }

  async respondApproval(id: string, outcome: 'allowed-once' | 'rejected'): Promise<void> {
    if (!this.kernel) throw new Error('DshTurnHub: runtime not started')
    await this.kernel.respondApproval(id, outcome)
  }

  /** Answer a pending ask_user_question for the owning session. */
  async respondAsk(id: string, answers: Array<{ id: string; selected: string[]; custom?: string }>): Promise<void> {
    if (!this.kernel) throw new Error('DshTurnHub: runtime not started')
    await this.kernel.respondAsk(id, answers)
  }

  async close(): Promise<void> {
    if (this.kernel) await this.kernel.close()
    this.kernel = null
    this.controllersByDsh.clear()
    this.dshByCowork.clear()
  }

  /** First workspace seen pins the mounted fs/bash cwd (per-session cwd churn
   * would restart the runtime; a follow-up mounts per-agent workspaces). */
  private workspaceSeen: DshRuntimeConfigInput['workspace']
  private lastConfigJson: string | undefined
  /** Provider routes accumulated across sessions — the runtime serves a UNION
   * so a new provider never rewrites (and restarts over) an existing one. */
  private providersSeen = new Map<string, DshProviderRoute & { apiKeyEnvName?: string }>()
  /** MCP servers accumulated the same way: user-level (not per-session), and a
   * removal keeps serving until the runtime restarts — same trade as providers. */
  private mcpServersSeen = new Map<string, DshMcpServerDefinition>()
  /** DeepSeek server-side web search: mounted once an official DeepSeek
   * provider is seen and then sticky — like MCP servers, a later non-DeepSeek
   * session never unmounts it (that would restart the runtime over nothing).
   * Composition-level tools serve every session in the shared runtime, which
   * matches the official DSH bundle (search backend is not per-model). */
  private webSearchSeen: { apiKey: string; baseURL: string } | null = null

  private async ensureKernel(input: DshTurnInput): Promise<DshKernel> {
    this.providersSeen.set(input.provider.key, providerRouteOf(input.provider))
    for (const server of this.opts.mcpServersProvider?.() ?? []) {
      const name = String(server?.name ?? '').trim()
      if (name) this.mcpServersSeen.set(name, server)
    }
    if (isOfficialDeepSeekRoute(input.provider) && input.provider.apiKey) {
      this.webSearchSeen = {
        apiKey: input.provider.apiKey,
        baseURL: deepSeekWebSearchBaseURL(input.provider.baseUrl),
      }
    }
    const config: DshRuntimeConfigInput = {
      sessionRoot: this.opts.sessionRoot,
      providers: [...this.providersSeen.values()],
      // sections/hostTools are PER-SESSION and ride session/ensure (agent-
      // scoped registration) — keeping them out of the config is what stops
      // every new session's prompt from restarting the shared runtime.
      workspace: this.workspaceSeen ?? input.workspace,
      mcpServers: [...this.mcpServersSeen.values()],
      ...(this.webSearchSeen ? {
        webSearch: {
          apiKeyEnv: DSH_WEBSEARCH_API_KEY_ENV,
          baseURL: this.webSearchSeen.baseURL,
          model: DSH_WEBSEARCH_MODEL,
        },
      } : {}),
      extraEntries: [...(this.opts.extraEntries ?? []), ...(this.opts.extraEntriesProvider?.() ?? [])],
      env: {
        // The credential rides the child env under the route's apiKeyEnv name —
        // it never enters the generated config file on disk.
        [input.provider.apiKeyEnvName ?? 'IDBOTS_DSH_API_KEY']: input.provider.apiKey,
        // The web-search credential rides a DEDICATED name so it survives
        // provider switches (the route key above is swapped on every ensure).
        ...(this.webSearchSeen ? { [DSH_WEBSEARCH_API_KEY_ENV]: this.webSearchSeen.apiKey } : {}),
        // The per-launch local RPC bearer token (S1 hardening) must ride the
        // runtime env too, or every bundled SKILL RPC client (group-task /
        // post-buzz / metaapp / omni-caster / upload) fails with 401 from DSH
        // sessions. Mirrors skillManager.ts runSkillById injection.
        IDBOTS_RPC_TOKEN: getMetaidRpcToken(),
        // Layer 2: the DSH bash tool scrubs env names matching
        // /KEY|PASSWORD|SECRET|TOKEN/i before model-visible subprocesses
        // inherit them, so the token above never reaches SKILL scripts run via
        // bash. Its mirror file (written per launch by the MetaID RPC server)
        // carries the credential instead; this env name must stay free of
        // KEY/PASSWORD/SECRET/TOKEN to survive the same scrub.
        [METAID_RPC_AUTHFILE_ENV]: getMetaidRpcTokenFilePath(app.getPath('userData')),
      },
    }
    if (!this.workspaceSeen && input.workspace) this.workspaceSeen = input.workspace
    if (!this.kernel) {
      this.kernel = new DshKernel({
        runtimeDir: this.opts.runtimeDir,
        handlers: this.hubHandlers(),
        log: this.opts.log,
      })
    }
    // A config change restarts the runtime; never do that while OTHER
    // sessions have turns in flight — wait for quiescence first (bounded).
    if (this.kernel?.running && this.lastConfigJson !== undefined) {
      const nextJson = JSON.stringify(config)
      if (nextJson !== this.lastConfigJson && this.controllersByDsh.size > 0) {
        const deadline = Date.now() + 90000
        while (this.controllersByDsh.size > 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
    }
    await this.kernel.ensureRuntime(config)
    this.lastConfigJson = JSON.stringify(config)
    return this.kernel
  }

  private hubHandlers(): DshKernelOptions['handlers'] {
    // Kernel event callbacks carry the DSH session id.
    const controllerOf = (dshSessionId: string) => this.controllersByDsh.get(dshSessionId)
    return {
      onMessage: (sessionId, message, slot) => {
        const controller = controllerOf(sessionId)
        if (!controller) return `dsh-orphan-${sessionId}`
        return controller.cb.onMessage(message, slot)
      },
      onMessageUpdate: (sessionId, messageId, content) => {
        controllerOf(sessionId)?.cb.onMessageUpdate(messageId, content)
      },
      onMessageFinalize: (sessionId, messageId, content, metadata) => {
        controllerOf(sessionId)?.cb.onMessageFinalize(messageId, content, metadata)
      },
      onUsage: (sessionId, usage) => {
        controllerOf(sessionId)?.cb.onUsage(usage)
      },
      onTurnEnd: (sessionId, reason, emptyTerminal) => {
        controllerOf(sessionId)?.handleTurnEnd(reason, emptyTerminal)
      },
      onApprovalRequest: (sessionId, ask) => {
        controllerOf(sessionId)?.cb.onApprovalRequest(ask)
      },
      onApprovalCancelled: (askId) => {
        for (const controller of this.controllersByDsh.values()) controller.cb.onApprovalCancelled(askId)
      },
      onAskRequest: (ask) => {
        controllerOf(ask.sessionId)?.cb.onAskRequest?.(ask)
      },
      onAskCancelled: (askId) => {
        for (const controller of this.controllersByDsh.values()) controller.cb.onAskCancelled?.(askId)
      },
      onSubagentEvent: (event) => {
        controllerOf(event.sessionId)?.cb.onSubagentEvent?.(event)
      },
      onError: (error) => {
        this.opts.log?.('error', 'dshTurnHub.pump', { message: error.message })
        // The runtime stream died (crash or restart): settle every in-flight
        // turn with an error outcome so sessions fail loudly instead of
        // hanging in "running" until manually stopped.
        for (const controller of this.controllersByDsh.values()) {
          controller.handleTurnEnd({ kind: 'error', reason: `DSH runtime stream closed: ${error.message}` })
        }
      },
      onPolicyRequest: (request) => {
        const coworkId = this.coworkByDsh.get(request.sessionId)
        if (!coworkId || !this.opts.evaluatePolicy) {
          // No host policy: default-allow so ungated deployments keep working.
          void this.kernel?.respondPolicy(request.id, 'allow')
          return
        }
        void this.opts.evaluatePolicy(coworkId, request.name, request.arguments ?? {})
          .then((result) => this.kernel?.respondPolicy(request.id, result.decision, result.reason))
          .catch(() => this.kernel?.respondPolicy(request.id, 'deny', 'policy evaluation failed'))
      },
      onToolRequest: (request) => {
        // Map the DSH session id back to the cowork id for the executor.
        const coworkId = this.coworkByDsh.get(request.sessionId)
        if (!coworkId || !this.opts.executeTool) return
        void this.opts.executeTool(coworkId, request.name, request.arguments ?? {})
          .then((result) => this.kernel?.respondTool(request.id, result))
          .catch((error) => this.kernel?.respondTool(request.id, { ok: false, error: error instanceof Error ? error.message : String(error) }))
      },
    }
  }
}

function providerRouteOf(provider: DshTurnProviderRoute): DshProviderRoute {
  return {
    key: provider.key,
    apiFormat: provider.apiFormat,
    baseUrl: provider.baseUrl,
    apiKeyEnv: provider.apiKeyEnvName ?? 'IDBOTS_DSH_API_KEY',
    thinkingFormat: provider.thinkingFormat,
    models: [{
      id: provider.model,
      contextWindow: provider.contextWindow ?? 64000,
      ...Number.isFinite(provider.maxOutputTokens) ? { maxOutputTokens: provider.maxOutputTokens } : {},
      ...(Array.isArray(provider.inputModalities) && provider.inputModalities.length > 0
        ? { input: provider.inputModalities }
        : {}),
    }],
  }
}

export function dshSessionRootFor(userDataPath: string): string {
  // Versioned directory so a future DSH session-format break (format v0 has no
  // upstream compatibility promise) can never touch older logs.
  return join(userDataPath, 'dsh-sessions', 'v0')
}
