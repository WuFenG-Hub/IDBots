// DSH kernel types: the kernel-agnostic surface between coworkRunner and the
// DSH runtime subprocess (Phase 1 M4).
//
// The mapper's output contract mirrors what handleClaudeEvent produces for the
// Claude SDK today: CoworkMessage-shaped messages, same-message-id streaming
// updates, and turn/usage facts. CoworkMessage itself stays the single
// currency — the renderer and coworkStore are untouched.

export type CoworkMessageInput = {
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system'
  content: string
  metadata?: Record<string, unknown>
}

/** Which streaming slot an action refers to (the store assigns real ids). */
export type DshStreamSlot = 'text' | 'thinking'

/**
 * Finalize-time metadata overrides. Used when assembly reclassifies a message
 * after streaming: DeepSeek Responses commentary-phase text streams as text
 * (the wire marks the phase only in the assembled replay state) and is
 * finalized as thinking so it collapses exactly like Claude-kernel thinking.
 * Official DeepSeek (no phase tags) uses the same finalize metadata when a
 * leaked text placeholder has to be closed; tool-step commentary otherwise
 * stays in the thinking slot without a second message.
 */
export type DshFinalizeMetadata = {
  isThinking?: boolean
  /**
   * Keep the streaming pulse on a finalized message. Normally finalize marks
   * the message settled; a message converted mid-stream into the thinking
   * display (tool-call commentary, effort "off") keeps accumulating content
   * across tool rounds, so it must stay visually streaming until the turn's
   * reply or turn/end settles it. The gate spreads metadata AFTER its own
   * isStreaming:false, so this flag wins.
   */
  isStreaming?: boolean
}

/** Actions the adapter applies to the store + event surface. */
export type DshMapperAction =
  | {
      kind: 'message'
      slot?: DshStreamSlot
      message: CoworkMessageInput
    }
  | { kind: 'messageUpdate'; slot: DshStreamSlot; content: string }
  | {
      kind: 'messageFinalize'
      slot: DshStreamSlot
      content: string
      metadata?: DshFinalizeMetadata
    }
  | {
      kind: 'turnEnd'
      turn: number
      reason: { kind: string; reason?: string }
      /** True when the turn stopped cleanly having produced no text and no tool calls. */
      emptyTerminal?: boolean
    }
  | { kind: 'usage'; usage: DshUsageSnapshot }

export interface DshUsageSnapshot {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  provider?: string
  model?: string
}

/**
 * Official token-meter session projections, read over the wire via the
 * idbots/usage extension. Mirrors @deepseek-ai/dsh-token-meter's
 * TokenUsageProjection / ContextPressureProjection / ContextBreakdown
 * projection contracts (all four usage buckets are DISJOINT — reasoning is
 * already inside outputTokens, uncached input excludes cache reads/writes).
 */
export interface DshUsageProjectionResult {
  available: boolean
  reason?: string
  asOfSeq?: number
  tokenUsage?: {
    uncachedInputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  } | null
  contextPressure?: {
    pressureTokens?: number
    projectedTokens?: number
    contextWindow?: number
  } | null
  contextBreakdown?: {
    systemTokens: number
    toolsTokens: number
    messageTokens: number
  } | null
}

/** Loose envelope of the wire `session.event` notification payload. */
export interface DshSessionEventEnvelope {
  type: string
  seq?: number
  time?: number
  data?: any
}

/** One IDBots provider row, normalized for the runtime config generator. */
export interface DshProviderRoute {
  key: string
  apiFormat: 'openai' | 'responses' | 'anthropic'
  baseUrl: string
  apiKeyEnv: string
  /**
   * Official DeepSeek rides its first-party dsh-llm-deepseek adapter
   * (chat-completions wire, native off/low/high/max efforts, reasoning in the
   * dedicated reasoning_content channel) instead of the pi-ai route; the
   * generator emits a dedicated plugin entry and never adds this provider to
   * llm-pi-ai. apiFormat becomes irrelevant for the wire (the adapter always
   * speaks chat completions; the base URL is normalized onto the host root).
   */
  native?: boolean
  models: Array<{
    id: string
    contextWindow: number
    maxOutputTokens?: number
    /** Input modalities the route declares (['text','image'] for vision models); pi-ai gates image blocks on it. */
    input?: string[]
  }>
}

/** Stable prompt layer (promptComposer section list). */
export interface DshPromptSectionInput {
  name: string
  order: number
  text: string
}

/**
 * A user-configured MCP server for the runtime composition: one
 * dsh-mcp-client plugin entry per server (`mcp__<name>__<tool>` naming).
 * Structurally compatible with the app's UserConfiguredMcpServerDefinition
 * (transportType stays `string`; the generator validates and skips unknown
 * transports instead of failing the composition).
 */
export interface DshMcpServerDefinition {
  name: string
  transportType: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export interface DshRuntimeConfigInput {
  sessionRoot: string
  providers: DshProviderRoute[]
  sections?: DshPromptSectionInput[]
  shaping?: { maxChars?: number; tailChars?: number }
  hostTools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  workspace?: { cwd: string }
  /**
   * AGENTS.md/CLAUDE.md discovery controls for the dsh-agent-instructions
   * plugin. `dshHome` is pinned by the host to a controlled empty directory
   * under userData so a user-global `~/.dsh/AGENTS.md` (e.g. left over from a
   * DeepSeek Harness install) never silently leaks into IDBots sessions.
   */
  workspaceInstructions?: { maxBytes?: number; dshHome?: string }
  /** User-configured MCP servers mounted as dsh-mcp-client plugin entries. */
  mcpServers?: DshMcpServerDefinition[]
  /**
   * DeepSeek server-side web search (dsh-web trio): mounts the model-facing
   * `web_search` tool backed by an auxiliary Anthropic-compatible Messages
   * call with the native web_search_20250305 server tool. Present once the
   * host has seen a DeepSeek provider; the API key rides `env` under
   * `apiKeyEnv`, never this config.
   */
  webSearch?: {
    apiKeyEnv: string
    baseURL: string
    model: string
  }
  extraEntries?: Array<Record<string, unknown>>
  /** Extra env for the runtime process (credential vars, never keys in config). */
  env?: Record<string, string>
  /**
   * Child-delegation model choice (DSH 0.1.2): default enabled — the
   * allowlist is derived from `providers` by the generator (the provider
   * table is the authorization surface). Set `enabled: false` to opt out.
   */
  subagentModelSelection?: { enabled?: boolean }
  /**
   * Session artifact physical encoding (DSH 0.1.2). Default `zstd` (Node
   * builtin zlib); `ensureRuntime` migrates existing plaintext artifacts
   * before booting a zstd composition. `'none'` stays plaintext (tests that
   * parse the artifact as text).
   */
  persistenceCompression?: 'zstd' | 'none'
  /** Distinguishes this process's composition file when several kernels share
   *  one sessionRoot (one runtime per provider). Not a composition field. */
  runtimeId?: string
}

export interface DshHostToolImagePayload {
  /** Base64-encoded image bytes. */
  data: string
  /** Declared media type (image/png | image/jpeg | image/webp | image/gif). */
  mediaType: string
  /** Optional display name stripped of path information. */
  name?: string
}

export interface DshHostToolRequest {
  id: string
  sessionId: string
  name: string
  arguments: Record<string, unknown>
}

export interface DshApprovalAsk {
  id: string
  sessionId: string
  toolName: string
  callId?: string
  reason?: string
}

/** A pending ask_user_question bridged from the runtime's user-questions service. */
export interface DshUserQuestionAsk {
  id: string
  sessionId: string
  questions: Array<{
    id: string
    question: string
    header?: string
    options?: Array<{ label: string; description?: string }>
    multiSelect?: boolean
  }>
}

/** Event callbacks the host (coworkRunner adapter wiring) subscribes to. */
export interface DshKernelHandlers {
  onMessage: (sessionId: string, message: CoworkMessageInput, slot?: DshStreamSlot) => string
  onMessageUpdate: (sessionId: string, messageId: string, content: string) => void
  onMessageFinalize: (sessionId: string, messageId: string, content: string, metadata?: DshFinalizeMetadata) => void
  onTurnEnd: (sessionId: string, reason: { kind: string; reason?: string }, emptyTerminal?: boolean) => void
  onUsage: (sessionId: string, usage: DshUsageSnapshot) => void
  onApprovalRequest: (sessionId: string, ask: DshApprovalAsk) => void
  onApprovalCancelled: (askId: string) => void
  onAskRequest?: (ask: DshUserQuestionAsk) => void
  onAskCancelled?: (askId: string) => void
  /** Live subagent lifecycle rows (parent DSH session id in the payload). */
  onSubagentEvent?: (event: {
    kind: 'started' | 'progress' | 'finished'
    sessionId: string
    agentId: string
    summary?: string
    status?: string
  }) => void
  onToolRequest: (request: DshHostToolRequest) => void
  onPolicyRequest?: (request: { id: string; sessionId: string; name: string; arguments: Record<string, unknown> }) => void
  onStatus?: (sessionId: string, status: 'idle' | 'running') => void
  onError?: (error: Error) => void
}
