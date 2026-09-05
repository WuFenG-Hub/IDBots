// DSH turn orchestration for cowork sessions (Phase 1 M5).
//
// DshTurnHub owns one DshKernel (and therefore one runtime subprocess) PER
// provider key. Twin on official DeepSeek and Lucy on OpenCode must be able
// to run at the same time — a single shared process cannot pick up a new
// provider without restarting, and that restart used to dispose every
// in-flight turn ("DSH runtime stream closed", exit 0). Same-provider
// sessions still multiplex on one kernel (models union via mergeProviderRoute).
//
// A config change the running process cannot serve (a new model route or MCP
// server joining the union) used to wait a bounded 90s for in-flight turns
// and then restart anyway — killing any turn still running past the budget
// (incident: a long scheduled-task turn died exactly 90s after a v4-pro
// session first arrived on a flash-only slot). Now such a change boots a
// SUCCESSOR kernel immediately and marks the old one draining: the caller's
// turn runs on the successor, in-flight turns finish on the old process, and
// the drained process closes once its last turn settles.
// DshTurnController drives one active turn: ensure → prompt → mapper
// actions → turn end, with native steer/cancel and approval bridging.

import { app } from 'electron'
import { join } from 'path'
import {
  getMetaidRpcToken,
  getMetaidRpcTokenFilePath,
  METAID_RPC_AUTHFILE_ENV,
} from '../services/metaidRpcEndpoint'
import { DshKernel, isSessionEncodingMismatchError } from './dshKernel/dshKernel'
import type { DshKernelOptions } from './dshKernel/dshKernel'
import { dshModelReasoningDeclaration } from './dshModelReasoning'
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

export { dshRuntimeConfigFileName } from './dshKernel/dshKernel'

export interface DshTurnProviderRoute {
  key: string
  apiFormat: 'openai' | 'responses' | 'anthropic'
  baseUrl: string
  apiKey: string
  model: string
  contextWindow?: number
  maxOutputTokens?: number
  /** Input modalities the model declares (['text','image'] for vision models). */
  inputModalities?: string[]
  /** Per-turn DSH reasoning effort (off|low|medium|high|max on the pi-ai
   * vocabulary; the native deepseek ladder is off|low|high|max). */
  reasoningEffort?: string
}

/** Pool key for a DSH runtime process: one subprocess per provider. */
export function dshRuntimeKeyOf(provider: Pick<DshTurnProviderRoute, 'key'>): string {
  return provider.key
}

/** Env var carrying the DeepSeek key for the runtime's web-search provider. */
const DSH_WEBSEARCH_API_KEY_ENV = 'IDBOTS_DSH_DEEPSEEK_WEBSEARCH_KEY'
/** Model serving the auxiliary search call (cheap + fast; search quality is
 *  provider-side, the model only formats the query — official DSH default). */
const DSH_WEBSEARCH_MODEL = 'deepseek-v4-flash'

/** Stable per-route credential env var name. The runtime child env is fixed
 *  at spawn while the route table is a cross-session UNION, so every route
 *  MUST read its own env name — a single shared name (the pre-fix
 *  IDBOTS_DSH_API_KEY) carried only the key of whichever provider last
 *  restarted the runtime, and every other route then sent that foreign key
 *  upstream (opencode/deepseek cross-provider 401 "Invalid API key" while
 *  the very same key worked via curl). dsh-credentials only accepts refs
 *  matching /^[A-Za-z_][A-Za-z0-9_]*$/, so provider-key characters outside
 *  [A-Za-z0-9_] collapse to '_' (route-key collisions would already merge
 *  in the config generator's own sanitization, so this stays unique). */
export const dshProviderApiKeyEnv = (providerKey: string): string =>
  `IDBOTS_DSH_KEY_${String(providerKey).replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}`

/** Hostname of a URL string, '' when it does not parse (regex, not URL — an
 *  invalid base can never throw here; port/userinfo are not provider shapes). */
function hostnameOf(value: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(value.trim())
  return match?.[1]?.toLowerCase() ?? ''
}

/** True when the route is the official DeepSeek provider (key or api host). */
export function isOfficialDeepSeekRoute(provider: Pick<DshTurnProviderRoute, 'key' | 'baseUrl'>): boolean {
  const key = provider.key?.toLowerCase()
  return key === 'deepseek' || key === 'deepseek-official' || hostnameOf(provider.baseUrl) === 'api.deepseek.com'
}

/**
 * True when the route rides the first-party dsh-llm-deepseek adapter. That
 * adapter speaks the OFFICIAL chat-completions dialect (thinking /
 * reasoning_effort ladder, root-path `/chat/completions` after the config
 * generator strips `/v1`), so it is only valid against api.deepseek.com. A
 * provider keyed 'deepseek' with a custom base URL — proxy relays preserved
 * by the model-settings migration, which hides the field but keeps stored
 * values — must stay on the generic pi-ai route: the official dialect sent
 * to an OpenAI-compatible relay is an HTTP 400 the relay reports without
 * DeepSeek's `{"error":{...}}` body, surfacing as the generic
 * "DeepSeek API error (HTTP 400)" turn failure.
 */
export function isNativeDeepSeekChatRoute(
  route: { provider?: string | null; baseUrl?: string | null; apiFormat?: string | null },
): boolean {
  return route.provider === 'deepseek'
    && route.apiFormat !== 'anthropic'
    && hostnameOf(String(route.baseUrl ?? '')) === 'api.deepseek.com'
}

/**
 * Normalize any DeepSeek provider base URL onto the Anthropic-compatible root
 * the web-search provider expects (`/messages` is appended by the package):
 * `https://api.deepseek.com` / `.../v1` / `.../anthropic` / `.../responses`-style
 * bases all resolve to `<root>/anthropic/v1`.
 */
export function deepSeekWebSearchBaseURL(baseUrl: string): string {
  let base = baseUrl.trim().replace(/\/+$/, '')
  base = base.replace(/\/responses$/, '')
  if (/\/anthropic\/v\d+$/.test(base)) return base
  if (/\/anthropic$/.test(base)) return `${base}/v1`
  // A chat-completions-style `.../v1` base (the common OpenAI-format DeepSeek
  // config) must collapse to the host root first — the Anthropic-compatible
  // endpoint is NOT nested under it, so `/v1/anthropic/v1/messages` 404s.
  base = base.replace(/\/v\d+$/, '')
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
  /** Carried on kind:'error' outcomes: the provider/runtime failure detail
   *  straight from the turn/end reason ({ message, code }) — e.g. TRANSPORT
   *  for a network-level fetch failure. */
  error?: { message?: string; code?: string }
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
  mcpServersProvider?: (coworkSessionId: string) => DshMcpServerDefinition[]
  log?: DshKernelOptions['log']
  /** Extra composition entries for the runtime (test fixtures; later the
   * idbots tools/policy plugins mount here). */
  extraEntries?: Array<Record<string, unknown>>
  /** Re-read every turn (unlike the static extraEntries): the user-managed
   *  plugin directory feeds entries here, so an install/uninstall applies on
   *  the next turn — config-change restart waits for quiescence as usual. */
  extraEntriesProvider?: () => Array<Record<string, unknown>>
  /** Idle-session events (native compact checkpoints) when no turn controller is live. */
  onIdleSessionMessage?: (coworkSessionId: string, message: { type: string; content: string; metadata?: Record<string, unknown> }) => string
  /** Global skill-script host env (IDBOTS_API_BASE_URL, SKILLS_ROOT, BASH_ENV, …).
   *  Re-read every ensure. Per-session identity cannot live here (shared
   *  runtime); those values are written to a DSH_SESSION_ID-keyed env file
   *  that bash sources via BASH_ENV after the KEY/TOKEN scrub. */
  skillHostEnvProvider?: () => Record<string, string>
  /** Close a provider-keyed runtime after this long with no in-flight turns
   *  (default 30min; 0 disables; tests shrink it). Next turn on that provider
   *  cold-starts and resumes sessions from disk. Also sweeps drained
   *  (superseded) kernels whose turns have all settled. */
  runtimeIdleTtlMs?: number
}

/** Child-env map for the shared DSH runtime. Route credentials and the RPC
 *  token stay first-class; skillHostEnv (IDBOTS_API_BASE_URL, SKILLS_ROOT)
 *  is merged last so bash-launched SKILL scripts inherit the same host
 *  channels as Claude subprocesses. */
export function buildDshChildEnv(parts: {
  routeApiKeys: Iterable<{ envName: string; apiKey: string }>
  webSearchApiKey?: string
  rpcToken: string
  rpcAuthFile: string
  skillHostEnv?: Record<string, string>
}): Record<string, string> {
  return {
    ...Object.fromEntries(
      [...parts.routeApiKeys].map(({ envName, apiKey }) => [envName, apiKey])
    ),
    ...(parts.webSearchApiKey ? { [DSH_WEBSEARCH_API_KEY_ENV]: parts.webSearchApiKey } : {}),
    IDBOTS_RPC_TOKEN: parts.rpcToken,
    [METAID_RPC_AUTHFILE_ENV]: parts.rpcAuthFile,
    ...(parts.skillHostEnv ?? {}),
  }
}

/** Sentinel cowork/DSH session id for startup warmup (no MCP, no pin). */
export const DSH_WARMUP_SESSION_ID = '__dsh_warmup__'

const DSH_WARMUP_CALLBACKS: DshTurnCallbacks = {
  onMessage: () => 'dsh-warmup',
  onMessageUpdate: () => undefined,
  onMessageFinalize: () => undefined,
  onUsage: () => undefined,
  onApprovalRequest: () => undefined,
  onApprovalCancelled: () => undefined,
}

interface DshEnsureKernelOptions {
  /** Real turns pin composition bash/fs plugin load to the first workspace
   *  (plugin default only). Per-session execution cwd rides session/ensure.
   *  Warmup loads the plugins without locking that default to a guessed cwd. */
  pinWorkspace?: boolean
  /** Real turns union MCP servers into the composition; warmup does not spawn
   *  user MCP subprocesses at app start. */
  accumulateMcp?: boolean
}

/** One DSH subprocess and the composition state it was last spawned with. */
interface DshRuntimeSlot {
  key: string
  kernel: DshKernel
  /** Superseded kernels still serving their in-flight turns. A config change
   *  the running process cannot serve boots a successor kernel instead of
   *  restarting under live turns; drained kernels close once their last turn
   *  settles (never force-killed — a legitimately long turn must outlive the
   *  handover). */
  drainingKernels: DshKernel[]
  /** Serializes ensureRuntime for THIS slot so warmup and the first turn
   *  on the same provider cannot double-spawn. Other providers boot in parallel. */
  kernelEnsureChain: Promise<void>
  lastConfigJson: string | undefined
  workspaceSeen: DshRuntimeConfigInput['workspace']
  providersSeen: Map<string, DshProviderRoute>
  routeApiKeys: Map<string, { envName: string; apiKey: string }>
  mcpServersSeen: Map<string, DshMcpServerDefinition>
  lastUsedAt: number
}

export class DshTurnHub {
  /** One runtime process per provider key. */
  private readonly slots = new Map<string, DshRuntimeSlot>()
  /** Keyed by DSH session id — that is what kernel event callbacks carry. */
  private controllersByDsh = new Map<string, DshTurnController>()
  /** cowork session id → DSH session id (steer/cancel look up by cowork id). */
  private dshByCowork = new Map<string, string>()
  /** Reverse mapping for tool-request routing. */
  private coworkByDsh = new Map<string, string>()
  /** cowork id → dsh id, kept across turns for post-hoc panel lookups. */
  private pinnedDshIds = new Map<string, string>()
  /** dsh session id → provider key of the kernel that last served it. */
  private runtimeKeyByDsh = new Map<string, string>()
  /** dsh session id → the kernel instance whose process holds the session's
   *  live agent. Slot key alone is ambiguous while a superseded kernel drains
   *  alongside its successor; steer/cancel/dispose must reach the exact
   *  process that owns the agent. */
  private kernelByDsh = new Map<string, DshKernel>()
  /** Approval / ask ids belong to the kernel that raised them. */
  private askKernelById = new Map<string, DshKernel>()
  /** DeepSeek server-side web search is composition-level and shared across
   *  every provider slot once an official DeepSeek route has been seen —
   *  same stickiness as the pre-split single runtime. */
  private webSearchSeen: { apiKey: string; baseURL: string } | null = null
  private reapTimer: ReturnType<typeof setTimeout> | null = null
  private readonly opts: DshHubOptions

  constructor(opts: DshHubOptions) {
    this.opts = opts
  }

  get running(): boolean {
    for (const slot of this.slots.values()) {
      if (slot.kernel.running) return true
      if (slot.drainingKernels.some((kernel) => kernel.running)) return true
    }
    return false
  }

  get restartCount(): number {
    let total = 0
    for (const slot of this.slots.values()) {
      total += slot.kernel.restartCount
      for (const kernel of slot.drainingKernels) total += kernel.restartCount
    }
    return total
  }

  /** Test/diagnostics: how many provider-keyed runtime processes exist. */
  get runtimeSlotCount(): number {
    return this.slots.size
  }

  /**
   * Spawn (or reuse) the shared runtime without opening a session or sending
   * a prompt. Used at app-ready so the first cowork turn does not pay process
   * boot + plugin load. Workspace is mounted for bash/fs plugin load but not
   * pinned — execution cwd is per-session on session/ensure, and the first
   * real turn still owns the composition plugin-default lock.
   */
  async prewarm(input: {
    provider: DshTurnProviderRoute
    workspace?: { cwd: string }
  }): Promise<void> {
    await this.ensureKernel({
      sessionId: DSH_WARMUP_SESSION_ID,
      dshSessionId: DSH_WARMUP_SESSION_ID,
      prompt: '',
      provider: input.provider,
      sections: [],
      workspace: input.workspace,
      callbacks: DSH_WARMUP_CALLBACKS,
    }, { pinWorkspace: false, accumulateMcp: false })
  }

  /** Start (or reuse) the runtime and run one turn to completion. */
  async runTurn(input: DshTurnInput): Promise<DshTurnOutcome> {
    const nextKey = dshRuntimeKeyOf(input.provider)
    const prevKey = this.runtimeKeyByDsh.get(input.dshSessionId)
    // Same dsh session id + a new provider key: the old process still holds
    // the live agent (idbotsAgents never evicts on its own). Re-pinning
    // without dispose leaves A→B→A talking to A's stale in-memory agent
    // that never saw B's turns, and two processes writing one JSONL.
    if (prevKey && prevKey !== nextKey) {
      await this.disposeSessionOnSlot(prevKey, input.dshSessionId)
    }
    this.runtimeKeyByDsh.set(input.dshSessionId, nextKey)
    let kernel = await this.ensureKernel(input)
    // The session's live agent may sit on a superseded (draining) kernel when
    // this turn starts — release it there first so exactly one process owns
    // the JSONL (same contract as the cross-provider re-pin above).
    const holder = this.kernelByDsh.get(input.dshSessionId)
    if (holder && holder !== kernel && holder.running) {
      await holder.disposeSession(input.dshSessionId).catch(() => undefined)
    }
    this.kernelByDsh.set(input.dshSessionId, kernel)
    const controller = new DshTurnController(input)
    // One active turn per cowork session: a stray previous controller (e.g. a
    // turn that never settled) must not swallow events.
    this.controllersByDsh.set(input.dshSessionId, controller)
    this.dshByCowork.set(input.sessionId, input.dshSessionId)
    this.coworkByDsh.set(input.dshSessionId, input.sessionId)
    this.pinnedDshIds.set(input.sessionId, input.dshSessionId)

    try {
      // Encoding-mismatch self-heal (2026-09-01 incident: a sibling app
      // instance on an older pre-zstd build sharing this userData kept a
      // compression:'none' backend alive and dropped plaintext artifacts into
      // the root after this slot's zstd runtime booted; every session/ensure
      // then died and the task behind it stalled). The backend caches its
      // root-encoding rejection, so recovery needs all three steps: re-migrate
      // the drifted artifacts, swap in a fresh process (clean cache), retry
      // the ensure there exactly once. Non-mismatch errors propagate as-is.
      const ensureSessionInput = {
        sessionId: input.dshSessionId,
        provider: input.provider.key,
        model: input.provider.model,
        ...Number.isFinite(input.provider.maxOutputTokens) ? { maxTokens: input.provider.maxOutputTokens } : {},
        ...(input.provider.reasoningEffort != null && input.provider.reasoningEffort !== ''
          ? { reasoningEffort: input.provider.reasoningEffort }
          : {}),
        sections: input.sections,
        hostTools: input.hostTools,
        ...(input.workspace?.cwd ? { cwd: input.workspace.cwd } : {}),
      }
      try {
        await kernel.ensureSession(ensureSessionInput)
      } catch (error) {
        const slot = this.slots.get(nextKey)
        // Heal only zstd compositions — a plaintext ('none') test composition
        // must not have its artifacts migrated out from under it.
        if (!slot || !isSessionEncodingMismatchError(error) || slot.lastConfigJson?.includes('"persistenceCompression":"none"')) {
          throw error
        }
        this.opts.log?.('warn', 'dshTurnHub.encodingMismatchHeal', {
          runtime: nextKey,
          sessionId: input.sessionId,
          message: error instanceof Error ? error.message : String(error),
        })
        await kernel.remigrateSessionRootToZstd()
        const successor = this.supersedeKernel(slot)
        const config = this.buildRuntimeConfig(slot, input)
        await successor.ensureRuntime(config)
        slot.lastConfigJson = JSON.stringify(config)
        kernel = successor
        this.kernelByDsh.set(input.dshSessionId, successor)
        await successor.ensureSession(ensureSessionInput)
      }
      await kernel.prompt(input.dshSessionId, input.prompt, input.promptImages)
      return await controller.done()
    } finally {
      this.controllersByDsh.delete(input.dshSessionId)
      this.dshByCowork.delete(input.sessionId)
      this.coworkByDsh.delete(input.dshSessionId)
      // Turn ran on a superseded kernel: release its agent so the successor
      // can resume the session from disk, then retire the drained process
      // once nothing else runs on it.
      const servedKernel = this.kernelByDsh.get(input.dshSessionId)
      const slot = this.slots.get(nextKey)
      if (servedKernel && slot && servedKernel !== slot.kernel) {
        await servedKernel.disposeSession(input.dshSessionId).catch(() => undefined)
        this.settleDrains(nextKey)
      }
      this.scheduleReap()
    }
  }

  private coworkOfDsh(dshSessionId: string): string | undefined {
    const live = this.coworkByDsh.get(dshSessionId)
    if (live) return live
    for (const [coworkId, dshId] of this.pinnedDshIds) {
      if (dshId === dshSessionId) return coworkId
    }
    return undefined
  }

  /**
   * Idle-session native compact (DSH /compact). Requires a live runtime and a
   * pinned DSH session from a previous turn. Busy when a turn is in flight.
   */
  async compact(coworkSessionId: string): Promise<{
    ok: boolean
    compacted?: boolean
    code?: string
    message?: string
    shadowedItemCount?: number
    shadowedTokenCount?: number
  }> {
    const dshId = this.dshByCowork.get(coworkSessionId) ?? this.pinnedDshIds.get(coworkSessionId)
    if (!dshId) {
      return { ok: false, code: 'no-agent', message: 'no DSH session to compact' }
    }
    const kernel = this.kernelForDsh(dshId)
    if (!kernel) {
      return { ok: false, code: 'no-runtime', message: 'DSH runtime is not running' }
    }
    if (this.controllersByDsh.has(dshId)) {
      return {
        ok: false,
        code: 'busy',
        message: 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.',
      }
    }
    return kernel.compact(dshId)
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
    const kernel = this.kernelForDsh(controller?.dshSessionId)
    if (!controller || !kernel) throw new Error('DshTurnHub: no active turn for steer')
    // Arm the boundary latch only when the cancel actually interrupted a
    // running activity. A no-op cancel against an idle agent (steer racing
    // turn start, or a second steer after a first abort already converged)
    // never emits the steer-abort boundary — arming there would swallow the
    // turn's natural end instead. Older runtime builds always report
    // cancelled:true, so only an explicit false skips the latch.
    let interrupted = true
    // A thrown cancel means no interrupt happened: plain step-boundary
    // steering, nothing armed. Let it propagate.
    const cancelResult = await kernel.cancel(controller.dshSessionId, 'steer', { keepInbox: true })
    interrupted = cancelResult.cancelled !== false
    if (interrupted) controller.expectSteerFollowUp()
    try {
      await kernel.steer(controller.dshSessionId, text)
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
    const kernel = this.kernelForDsh(controller?.dshSessionId)
    if (!controller || !kernel) return
    await kernel.cancel(controller.dshSessionId, cause)
  }

  /** Cancel a live DSH agent by its runtime session id (subagent Stop). */
  async cancelAgent(dshSessionId: string, cause?: string): Promise<void> {
    if (!dshSessionId) return
    const kernel = this.kernelForDsh(dshSessionId)
    if (kernel) {
      await kernel.cancel(dshSessionId, cause)
      return
    }
    for (const slot of this.slots.values()) {
      const candidates = [slot.kernel, ...slot.drainingKernels]
      for (const kernel of candidates) {
        if (kernel.running) {
          await kernel.cancel(dshSessionId, cause).catch(() => undefined)
        }
      }
    }
  }

  /** Subagent panel (cowork session id in, DSH routing inside). */
  async listSubagents(coworkSessionId: string): Promise<Array<{ agentId: string; status: string; startedAt: number }>> {
    const dshId = this.dshByCowork.get(coworkSessionId) ?? this.pinnedDshIds.get(coworkSessionId)
    const kernel = this.kernelForDsh(dshId)
    if (!kernel || !dshId) return []
    const result = await kernel.listSubagents(dshId)
    return result.agents ?? []
  }

  async getSubagentMessages(coworkSessionId: string, agentId: string, limit?: number): Promise<Array<{ id: string; type: string; content: string; timestamp: number }>> {
    const dshId = this.dshByCowork.get(coworkSessionId) ?? this.pinnedDshIds.get(coworkSessionId)
    const kernel = this.kernelForDsh(dshId)
    if (!kernel || !dshId) return []
    const result = await kernel.getSubagentMessages(dshId, agentId, limit)
    return result.messages ?? []
  }

  /** Subagent panel stop: kernel 'user'-authority interrupt (DSH sessions). */
  async interruptSubagent(coworkSessionId: string, agentId: string): Promise<{ accepted: boolean; reason?: string }> {
    const dshId = this.dshByCowork.get(coworkSessionId) ?? this.pinnedDshIds.get(coworkSessionId)
    const kernel = this.kernelForDsh(dshId)
    if (!kernel || !dshId) return { accepted: false, reason: 'DSH kernel not running for this session' }
    return kernel.interruptSubagent(dshId, agentId)
  }

  /**
   * Official token-meter projections for the usage panel (cowork session id
   * in, DSH routing inside; post-turn safe via the pinned-id fallback).
   * Null when the runtime is down or the cowork session never ran on DSH.
   */
  async usageProjection(coworkSessionId: string): Promise<DshUsageProjectionResult | null> {
    const dshId = this.dshByCowork.get(coworkSessionId) ?? this.pinnedDshIds.get(coworkSessionId)
    const kernel = this.kernelForDsh(dshId)
    if (!kernel || !dshId) return null
    return kernel.usageProjection(dshId)
  }

  async respondApproval(id: string, outcome: 'allowed-once' | 'rejected'): Promise<void> {
    const kernel = this.askKernelById.get(id) ?? this.firstRunningKernel()
    if (!kernel) throw new Error('DshTurnHub: runtime not started')
    await kernel.respondApproval(id, outcome)
  }

  /** Answer a pending ask_user_question for the owning session. */
  async respondAsk(id: string, answers: Array<{ id: string; selected: string[]; custom?: string }>): Promise<void> {
    const kernel = this.askKernelById.get(id) ?? this.firstRunningKernel()
    if (!kernel) throw new Error('DshTurnHub: runtime not started')
    await kernel.respondAsk(id, answers)
  }

  async close(): Promise<void> {
    if (this.reapTimer) {
      clearTimeout(this.reapTimer)
      this.reapTimer = null
    }
    const kernels: Promise<void>[] = []
    for (const slot of this.slots.values()) {
      kernels.push(slot.kernel.close())
      for (const kernel of slot.drainingKernels) kernels.push(kernel.close())
    }
    await Promise.all(kernels)
    this.slots.clear()
    this.controllersByDsh.clear()
    this.dshByCowork.clear()
    this.coworkByDsh.clear()
    this.runtimeKeyByDsh.clear()
    this.kernelByDsh.clear()
    this.askKernelById.clear()
  }

  private kernelForDsh(dshId: string | undefined): DshKernel | null {
    if (!dshId) return null
    // Holder first: while a drained kernel and its successor coexist, the
    // agent (and any in-flight turn) lives on the exact process recorded here.
    const holder = this.kernelByDsh.get(dshId)
    if (holder?.running) return holder
    const key = this.runtimeKeyByDsh.get(dshId)
    if (key) {
      const slot = this.slots.get(key)
      if (slot?.kernel.running) return slot.kernel
    }
    return null
  }

  private firstRunningKernel(): DshKernel | null {
    for (const slot of this.slots.values()) {
      if (slot.kernel.running) return slot.kernel
      for (const kernel of slot.drainingKernels) {
        if (kernel.running) return kernel
      }
    }
    return null
  }

  private inFlightOnSlot(key: string): number {
    let count = 0
    for (const dshId of this.controllersByDsh.keys()) {
      if (this.runtimeKeyByDsh.get(dshId) === key) count += 1
    }
    return count
  }

  private async disposeSessionOnSlot(runtimeKey: string, dshSessionId: string): Promise<void> {
    // The agent may live on a drained kernel of this slot rather than on the
    // current one — dispose where it actually is (no-op elsewhere).
    const kernel = this.kernelForDsh(dshSessionId)
    if (!kernel) return
    this.opts.log?.('info', 'dshTurnHub.disposeSession', {
      dshSessionId,
      runtime: runtimeKey,
    })
    try {
      await kernel.disposeSession(dshSessionId)
    } catch (error) {
      this.opts.log?.('warn', 'dshTurnHub.disposeSession failed', {
        dshSessionId,
        runtime: runtimeKey,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private scheduleReap(): void {
    const ttl = this.opts.runtimeIdleTtlMs ?? 30 * 60 * 1000
    if (ttl <= 0 || this.reapTimer) return
    const delay = Math.max(50, Math.min(ttl, 60_000))
    this.reapTimer = setTimeout(() => {
      this.reapTimer = null
      void this.reapIdleSlots()
    }, delay)
    this.reapTimer.unref?.()
  }

  private async reapIdleSlots(): Promise<void> {
    const ttl = this.opts.runtimeIdleTtlMs ?? 30 * 60 * 1000
    if (ttl <= 0) return
    const now = Date.now()
    for (const [key, slot] of [...this.slots]) {
      // Retire drained kernels whose turns have all settled, even when the
      // slot itself is too young/fresh to reap.
      this.settleDrains(key)
      if (this.inFlightOnSlot(key) > 0) continue
      if (now - slot.lastUsedAt < ttl) continue
      this.opts.log?.('info', 'dshTurnHub.reapIdleRuntime', { runtime: key })
      await slot.kernel.close().catch(() => undefined)
      for (const kernel of slot.drainingKernels) await kernel.close().catch(() => undefined)
      this.slots.delete(key)
      for (const [dshId, mapped] of [...this.runtimeKeyByDsh]) {
        if (mapped === key) this.runtimeKeyByDsh.delete(dshId)
      }
      for (const [dshId, holder] of [...this.kernelByDsh]) {
        if (holder === slot.kernel || slot.drainingKernels.includes(holder)) {
          this.kernelByDsh.delete(dshId)
        }
      }
    }
    if (this.slots.size > 0) this.scheduleReap()
  }

  private getOrCreateSlot(key: string): DshRuntimeSlot {
    const existing = this.slots.get(key)
    if (existing) {
      existing.lastUsedAt = Date.now()
      return existing
    }
    const slot: DshRuntimeSlot = {
      key,
      kernel: null as unknown as DshKernel,
      drainingKernels: [],
      kernelEnsureChain: Promise.resolve(),
      lastConfigJson: undefined,
      workspaceSeen: undefined,
      providersSeen: new Map(),
      routeApiKeys: new Map(),
      mcpServersSeen: new Map(),
      lastUsedAt: Date.now(),
    }
    this.attachKernel(slot)
    this.slots.set(key, slot)
    return slot
  }

  /** Create the slot's CURRENT kernel. Handlers bind to this exact instance —
   *  a slot can briefly host a drained kernel alongside its successor, and
   *  approvals/tool responses must reach the process that raised them. The
   *  lazy resolver dodges the constructor/assignment cycle. */
  private attachKernel(slot: DshRuntimeSlot): DshKernel {
    const kernel = new DshKernel({
      runtimeDir: this.opts.runtimeDir,
      handlers: this.hubHandlers(slot, () => kernel),
      log: this.opts.log,
    })
    slot.kernel = kernel
    return kernel
  }

  /** Swap in a successor kernel and mark the current one draining. Idle
   *  agents on the old process are released right away; in-flight turns keep
   *  it alive until they settle (their runTurn finally releases the agent and
   *  calls settleDrains). */
  private supersedeKernel(slot: DshRuntimeSlot): DshKernel {
    const old = slot.kernel
    for (const [dshId, holder] of this.kernelByDsh) {
      if (holder !== old || this.controllersByDsh.has(dshId)) continue
      void old.disposeSession(dshId).then(
        () => this.settleDrains(slot.key),
        () => undefined,
      )
    }
    slot.drainingKernels.push(old)
    return this.attachKernel(slot)
  }

  /** Close drained kernels: a superseded runtime retires once no turn is left
   *  running on it. Never force-closes — a turn that legitimately outlasts the
   *  handover keeps its process for exactly as long as it runs. */
  private settleDrains(key: string): void {
    const slot = this.slots.get(key)
    if (!slot) return
    slot.drainingKernels = slot.drainingKernels.filter((kernel) => {
      if (kernel.running && this.inFlightOnKernel(kernel) > 0) return true
      void kernel.close().then(() => undefined, () => undefined)
      for (const [dshId, holder] of this.kernelByDsh) {
        if (holder === kernel) this.kernelByDsh.delete(dshId)
      }
      this.opts.log?.('info', 'dshTurnHub.drainedRuntimeClosed', { runtime: key })
      return false
    })
  }

  /** Turns whose kernel is this exact instance (a slot's in-flight turns may
   *  be split between a drained kernel and its successor). */
  private inFlightOnKernel(kernel: DshKernel): number {
    let count = 0
    for (const [dshId, holder] of this.kernelByDsh) {
      if (holder === kernel && this.controllersByDsh.has(dshId)) count += 1
    }
    return count
  }

  private rememberTurnInputs(slot: DshRuntimeSlot, input: DshTurnInput, options?: DshEnsureKernelOptions): void {
    slot.providersSeen.set(
      input.provider.key,
      mergeProviderRoute(slot.providersSeen.get(input.provider.key), providerRouteOf(input.provider)),
    )
    slot.routeApiKeys.set(input.provider.key, {
      envName: dshProviderApiKeyEnv(input.provider.key),
      apiKey: input.provider.apiKey,
    })
    if (options?.accumulateMcp !== false) {
      for (const server of this.opts.mcpServersProvider?.(input.sessionId) ?? []) {
        const name = String(server?.name ?? '').trim()
        if (name) slot.mcpServersSeen.set(name, server)
      }
    }
    if (isOfficialDeepSeekRoute(input.provider) && input.provider.apiKey) {
      this.webSearchSeen = {
        apiKey: input.provider.apiKey,
        baseURL: deepSeekWebSearchBaseURL(input.provider.baseUrl),
      }
    }
    if (options?.pinWorkspace !== false && !slot.workspaceSeen && input.workspace) {
      slot.workspaceSeen = input.workspace
    }
  }

  private buildRuntimeConfig(slot: DshRuntimeSlot, input: DshTurnInput): DshRuntimeConfigInput {
    return {
      sessionRoot: this.opts.sessionRoot,
      runtimeId: slot.key,
      providers: [...slot.providersSeen.values()],
      // sections/hostTools are PER-SESSION and ride session/ensure (agent-
      // scoped registration) — keeping them out of the config is what stops
      // every new session's prompt from restarting this slot's runtime.
      workspace: slot.workspaceSeen ?? input.workspace,
      // Pin the user-global AGENTS.md home to an empty directory under
      // userData: the host never reads ~/.dsh, so a global instruction file
      // left over from another harness cannot silently enter every session.
      ...(slot.workspaceSeen ?? input.workspace) ? {
        workspaceInstructions: { dshHome: join(app.getPath('userData'), 'dsh-home') },
      } : {},
      mcpServers: [...slot.mcpServersSeen.values()],
      ...(this.webSearchSeen ? {
        webSearch: {
          apiKeyEnv: DSH_WEBSEARCH_API_KEY_ENV,
          baseURL: this.webSearchSeen.baseURL,
          model: DSH_WEBSEARCH_MODEL,
        },
      } : {}),
      extraEntries: [...(this.opts.extraEntries ?? []), ...(this.opts.extraEntriesProvider?.() ?? [])],
      env: buildDshChildEnv({
        routeApiKeys: slot.routeApiKeys.values(),
        webSearchApiKey: this.webSearchSeen?.apiKey,
        rpcToken: getMetaidRpcToken(),
        rpcAuthFile: getMetaidRpcTokenFilePath(app.getPath('userData')),
        skillHostEnv: this.opts.skillHostEnvProvider?.(),
      }),
    }
  }

  private async ensureKernel(input: DshTurnInput, options?: DshEnsureKernelOptions): Promise<DshKernel> {
    // Apply this slot's route/MCP/workspace immediately so a racing first
    // turn can steer a still-booting warmup spawn (config is snapshotted
    // only after the per-slot serialize lock is acquired).
    const slot = this.getOrCreateSlot(dshRuntimeKeyOf(input.provider))
    this.rememberTurnInputs(slot, input, options)
    const run = slot.kernelEnsureChain.then(() => this.spawnOrReuseFromSeenState(slot, input))
    slot.kernelEnsureChain = run.then(() => undefined, () => undefined)
    return run
  }

  private async spawnOrReuseFromSeenState(slot: DshRuntimeSlot, input: DshTurnInput): Promise<DshKernel> {
    const config = this.buildRuntimeConfig(slot, input)
    // A config change restarts THIS slot's runtime only. Other providers
    // keep their processes. GT#26 follow-up still applies inside a slot:
    // MCP/env flaps on the same provider must not kill in-flight turns.
    if (slot.kernel.running && slot.lastConfigJson !== undefined) {
      const nextJson = JSON.stringify(config)
      const inFlight = this.inFlightOnSlot(slot.key)
      if (nextJson !== slot.lastConfigJson && inFlight > 0) {
        const changedKeys = dshConfigChangedKeys(slot.lastConfigJson, nextJson)
        const callerRouteJson = JSON.stringify(providerRouteOf(input.provider))
        const servedByRunningRuntime =
          lastProviderRouteJsonOf(slot.lastConfigJson, input.provider.key) === callerRouteJson
        if (servedByRunningRuntime) {
          this.opts.log?.('warn',
            'config changed but the running runtime serves this turn; restart deferred until quiescence',
            { runtime: slot.key, changed: changedKeys, inFlight })
          return slot.kernel
        }
        // The caller needs a config the running process cannot serve (e.g.
        // the first v4-pro turn on a flash-only slot). Waiting a bounded 90s
        // and restarting anyway killed turns that legitimately ran longer
        // (incident: "DSH runtime stream closed", exit 0, exactly 90s after
        // the config diff). Instead boot a successor process immediately and
        // let the old one drain its in-flight turns.
        this.opts.log?.('warn',
          'config change with in-flight turns; booting a successor runtime and draining the old one',
          { runtime: slot.key, changed: changedKeys, inFlight })
        const successor = this.supersedeKernel(slot)
        await successor.ensureRuntime(config)
        slot.lastConfigJson = nextJson
        return successor
      }
    }
    await slot.kernel.ensureRuntime(config)
    slot.lastConfigJson = JSON.stringify(config)
    return slot.kernel
  }

  private hubHandlers(slot: DshRuntimeSlot, kernelOf: () => DshKernel): DshKernelOptions['handlers'] {
    // Kernel event callbacks carry the DSH session id.
    const controllerOf = (dshSessionId: string) => this.controllersByDsh.get(dshSessionId)
    // Bound to THIS kernel instance: while a drained kernel coexists with its
    // successor, responses (approvals/tools/policy) must reach the process
    // that raised the request.
    return {
      onMessage: (sessionId, message, streamSlot) => {
        const controller = controllerOf(sessionId)
        if (controller) return controller.cb.onMessage(message, streamSlot)
        const coworkId = this.coworkOfDsh(sessionId)
        if (coworkId && this.opts.onIdleSessionMessage) {
          return this.opts.onIdleSessionMessage(coworkId, message)
        }
        return `dsh-orphan-${sessionId}`
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
        this.askKernelById.set(ask.id, kernelOf())
        controllerOf(sessionId)?.cb.onApprovalRequest(ask)
      },
      onApprovalCancelled: (askId) => {
        for (const controller of this.controllersByDsh.values()) controller.cb.onApprovalCancelled(askId)
      },
      onAskRequest: (ask) => {
        this.askKernelById.set(ask.id, kernelOf())
        const controller = controllerOf(ask.sessionId)
        const onAskRequest = controller?.cb.onAskRequest
        if (!controller || !onAskRequest) {
          // A silent drop here strands the runtime-side bridge promise
          // forever (the tool contract requires settling). Decline explicitly
          // so the asking turn unwinds instead of hanging. A controller can
          // still exist during a handoff/drain while its callback is absent;
          // that case must settle the same way as a missing controller.
          this.opts.log?.('warn', 'dshTurnHub.onAskRequest', {
            message: !controller
              ? 'ask_user_question has no live turn controller for its DSH session; auto-declining'
              : 'ask_user_question has no host callback for its DSH session; auto-declining',
            askId: ask.id,
            dshSessionId: ask.sessionId,
            runtime: slot.key,
          })
          void kernelOf().respondAsk(
            ask.id,
            (ask.questions ?? []).map((q) => ({
              id: q.id,
              selected: [],
              custom: 'The user could not be reached for this question.',
            })),
          ).catch(() => undefined)
          return
        }
        onAskRequest(ask)
      },
      onAskCancelled: (askId) => {
        for (const controller of this.controllersByDsh.values()) controller.cb.onAskCancelled?.(askId)
      },
      onSubagentEvent: (event) => {
        controllerOf(event.sessionId)?.cb.onSubagentEvent?.(event)
      },
      onError: (error) => {
        this.opts.log?.('error', 'dshTurnHub.pump', { message: error.message, runtime: slot.key })
        // Only settle turns on THIS kernel instance — a drained kernel dying
        // must not fail turns already re-pinned to its successor (and vice
        // versa; the slot key alone cannot tell them apart).
        const kernel = kernelOf()
        for (const [dshId, controller] of this.controllersByDsh) {
          if (this.kernelByDsh.get(dshId) !== kernel) continue
          controller.handleTurnEnd({ kind: 'error', reason: `DSH runtime stream closed: ${error.message}` })
        }
      },
      onPolicyRequest: (request) => {
        const coworkId = this.coworkByDsh.get(request.sessionId)
        if (!coworkId || !this.opts.evaluatePolicy) {
          // No host policy: default-allow so ungated deployments keep working.
          void kernelOf().respondPolicy(request.id, 'allow')
          return
        }
        void this.opts.evaluatePolicy(coworkId, request.name, request.arguments ?? {})
          .then((result) => kernelOf().respondPolicy(request.id, result.decision, result.reason))
          .catch(() => {
            try {
              kernelOf().respondPolicy(request.id, 'deny', 'policy evaluation failed')
            } catch {
              // Drained kernel already closed — nothing left to answer.
            }
          })
      },
      onToolRequest: (request) => {
        // Map the DSH session id back to the cowork id for the executor.
        const coworkId = this.coworkByDsh.get(request.sessionId)
        if (!coworkId || !this.opts.executeTool) return
        void this.opts.executeTool(coworkId, request.name, request.arguments ?? {})
          .then((result) => kernelOf().respondTool(request.id, result))
          .catch((error) => {
            // The kernel may have drained and closed while the host tool ran.
            try {
              kernelOf().respondTool(request.id, { ok: false, error: error instanceof Error ? error.message : String(error) })
            } catch {
              // Process already gone — nothing left to answer.
            }
          })
      },
    }
  }
}

function providerRouteOf(provider: DshTurnProviderRoute): DshProviderRoute {
  // Reasoning declaration rides the MODEL (its family's wire dialect), not the
  // provider: a catalog-unknown gateway serving a reasoning-capable model
  // would otherwise materialize reasoning:false and lose all effort control.
  // The native route is exempt — the first-party adapter owns its own ladder.
  const reasoning = provider.key === 'deepseek-official'
    ? null
    : dshModelReasoningDeclaration(provider.model, provider.apiFormat);
  return {
    key: provider.key,
    apiFormat: provider.apiFormat,
    baseUrl: provider.baseUrl,
    // Per-route credential name (see dshProviderApiKeyEnv): the runtime reads
    // process.env under exactly this name, and the child env carries every
    // seen route's key under its own name.
    apiKeyEnv: dshProviderApiKeyEnv(provider.key),
    // 'deepseek-official' is the dsh-llm-deepseek adapter's route key — the
    // generator mounts it on its first-party adapter instead of pi-ai.
    native: provider.key === 'deepseek-official',
    models: [{
      id: provider.model,
      contextWindow: provider.contextWindow ?? 64000,
      ...Number.isFinite(provider.maxOutputTokens) ? { maxOutputTokens: provider.maxOutputTokens } : {},
      ...(Array.isArray(provider.inputModalities) && provider.inputModalities.length > 0
        ? { input: provider.inputModalities }
        : {}),
      ...(reasoning
        ? { reasoningEfforts: reasoning.reasoningEfforts, compat: reasoning.compat }
        : {}),
    }],
  }
}

/**
 * Union models onto an already-seen provider route instead of replacing it.
 * Replacing dropped the original model and forced a runtime restart on every
 * same-provider switch; the live agent then ignored the new ensure() route
 * (effort-only bind) so only the cowork's first model kept working.
 */
export function mergeProviderRoute(
  existing: DshProviderRoute | undefined,
  next: DshProviderRoute,
): DshProviderRoute {
  if (!existing) return next
  const models = [...existing.models]
  for (const model of next.models) {
    const index = models.findIndex((candidate) => candidate.id === model.id)
    if (index >= 0) models[index] = model
    else models.push(model)
  }
  return { ...next, models }
}

/** Top-level config keys whose serialized value differs between two configs
 *  (restarting the shared runtime is destructive — say WHAT changed). */
export function dshConfigChangedKeys(lastJson: string, nextJson: string): string[] {
  try {
    const last = JSON.parse(lastJson) as Record<string, unknown>
    const next = JSON.parse(nextJson) as Record<string, unknown>
    const keys = new Set([...Object.keys(last), ...Object.keys(next)])
    return [...keys].filter((key) => JSON.stringify(last[key]) !== JSON.stringify(next[key]))
  } catch {
    return ['<unparseable>']
  }
}

/** Serialized provider route stored in a config JSON by key, or null when the
 *  key is absent — the runtime can only serve a turn whose route is present
 *  verbatim. */
export function lastProviderRouteJsonOf(configJson: string, providerKey: string): string | null {
  try {
    const parsed = JSON.parse(configJson) as { providers?: Array<{ key: string }> }
    const route = (parsed.providers ?? []).find((candidate) => candidate.key === providerKey)
    return route === undefined ? null : JSON.stringify(route)
  } catch {
    return null
  }
}

export function dshSessionRootFor(userDataPath: string): string {
  // Versioned directory so a future DSH session-format break (format v0 has no
  // upstream compatibility promise) can never touch older logs.
  return join(userDataPath, 'dsh-sessions', 'v0')
}
