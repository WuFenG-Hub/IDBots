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

import { join } from 'path'
import { DshKernel } from './dshKernel/dshKernel'
import type { DshKernelOptions } from './dshKernel/dshKernel'
import type {
  DshApprovalAsk,
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
}

export interface DshTurnCallbacks {
  onMessage: (
    message: { type: string; content: string; metadata?: Record<string, unknown> },
    slot?: DshStreamSlot
  ) => string
  onMessageUpdate: (messageId: string, content: string) => void
  onMessageFinalize: (messageId: string, content: string) => void
  onUsage: (usage: DshUsageSnapshot) => void
  onApprovalRequest: (ask: DshApprovalAsk) => void
  onApprovalCancelled: (askId: string) => void
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
  callbacks: DshTurnCallbacks
}

class DshTurnController {
  readonly dshSessionId: string
  private readonly callbacks: DshTurnCallbacks
  private settleTurn!: (reason: { kind: string; reason?: string }) => void
  private readonly turnDone: Promise<{ kind: string; reason?: string }>
  private steerWaiters: Array<(text: string) => void> = []

  constructor(input: DshTurnInput) {
    this.dshSessionId = input.dshSessionId
    this.callbacks = input.callbacks
    this.turnDone = new Promise((resolve) => { this.settleTurn = resolve })
  }

  done(): Promise<{ kind: string; reason?: string }> {
    return this.turnDone
  }

  handleTurnEnd(reason: { kind: string; reason?: string }): void {
    this.settleTurn(reason)
    for (const waiter of this.steerWaiters.splice(0)) waiter('')
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
  /** Execute a host-bridged tool call; resolves {ok,text} or rejects. */
  executeTool?: (coworkSessionId: string, name: string, args: Record<string, unknown>) => Promise<{ ok: true; text: string } | { ok: false; error: string }>
  /** Host permission chain for runtime-native tools (bash/write/edit…). */
  evaluatePolicy?: (coworkSessionId: string, name: string, args: Record<string, unknown>) => Promise<{ decision: 'allow' | 'deny' | 'ask'; reason?: string }>
  log?: DshKernelOptions['log']
  /** Extra composition entries for the runtime (test fixtures; later the
   * idbots tools/policy plugins mount here). */
  extraEntries?: Array<Record<string, unknown>>
}

export class DshTurnHub {
  private kernel: DshKernel | null = null
  /** Keyed by DSH session id — that is what kernel event callbacks carry. */
  private controllersByDsh = new Map<string, DshTurnController>()
  /** cowork session id → DSH session id (steer/cancel look up by cowork id). */
  private dshByCowork = new Map<string, string>()
  /** Reverse mapping for tool-request routing. */
  private coworkByDsh = new Map<string, string>()
  private readonly opts: DshHubOptions

  constructor(opts: DshHubOptions) {
    this.opts = opts
  }

  /** Start (or reuse) the runtime and run one turn to completion. */
  async runTurn(input: DshTurnInput): Promise<{ kind: string; reason?: string }> {
    const kernel = await this.ensureKernel(input)
    const controller = new DshTurnController(input)
    // One active turn per cowork session: a stray previous controller (e.g. a
    // turn that never settled) must not swallow events.
    this.controllersByDsh.set(input.dshSessionId, controller)
    this.dshByCowork.set(input.sessionId, input.dshSessionId)
    this.coworkByDsh.set(input.dshSessionId, input.sessionId)

    try {
      await kernel.ensureSession({
        sessionId: input.dshSessionId,
        provider: input.provider.key,
        model: input.provider.model,
        ...Number.isFinite(input.provider.maxOutputTokens) ? { maxTokens: input.provider.maxOutputTokens } : {},
      })
      await kernel.prompt(input.dshSessionId, input.prompt)
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

  /** Native step-boundary steer; resolves once the runtime accepted it. */
  async steer(sessionId: string, text: string): Promise<void> {
    const controller = this.controllerOfCowork(sessionId)
    if (!controller || !this.kernel) throw new Error('DshTurnHub: no active turn for steer')
    await this.kernel.steer(controller.dshSessionId, text)
    controller.notifySteerDelivered(text)
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

  async respondApproval(id: string, outcome: 'allowed-once' | 'rejected'): Promise<void> {
    if (!this.kernel) throw new Error('DshTurnHub: runtime not started')
    await this.kernel.respondApproval(id, outcome)
  }

  async close(): Promise<void> {
    if (this.kernel) await this.kernel.close()
    this.kernel = null
    this.controllersByDsh.clear()
    this.dshByCowork.clear()
  }

  private async ensureKernel(input: DshTurnInput): Promise<DshKernel> {
    const config: DshRuntimeConfigInput = {
      sessionRoot: this.opts.sessionRoot,
      providers: [providerRouteOf(input.provider)],
      sections: input.sections,
      hostTools: input.hostTools,
      workspace: input.workspace,
      extraEntries: this.opts.extraEntries,
      env: {
        // The credential rides the child env under the route's apiKeyEnv name —
        // it never enters the generated config file on disk.
        [input.provider.apiKeyEnvName ?? 'IDBOTS_DSH_API_KEY']: input.provider.apiKey,
      },
    }
    if (!this.kernel) {
      this.kernel = new DshKernel({
        runtimeDir: this.opts.runtimeDir,
        handlers: this.hubHandlers(),
        log: this.opts.log,
      })
    }
    await this.kernel.ensureRuntime(config)
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
      onMessageFinalize: (sessionId, messageId, content) => {
        controllerOf(sessionId)?.cb.onMessageFinalize(messageId, content)
      },
      onUsage: (sessionId, usage) => {
        controllerOf(sessionId)?.cb.onUsage(usage)
      },
      onTurnEnd: (sessionId, reason) => {
        controllerOf(sessionId)?.handleTurnEnd(reason)
      },
      onApprovalRequest: (sessionId, ask) => {
        controllerOf(sessionId)?.cb.onApprovalRequest(ask)
      },
      onApprovalCancelled: (askId) => {
        for (const controller of this.controllersByDsh.values()) controller.cb.onApprovalCancelled(askId)
      },
      onError: (error) => this.opts.log?.('error', 'dshTurnHub.pump', { message: error.message }),
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
    }],
  }
}

export function dshSessionRootFor(userDataPath: string): string {
  // Versioned directory so a future DSH session-format break (format v0 has no
  // upstream compatibility promise) can never touch older logs.
  return join(userDataPath, 'dsh-sessions', 'v0')
}
