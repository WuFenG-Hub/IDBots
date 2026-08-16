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

/** Actions the adapter applies to the store + event surface. */
export type DshMapperAction =
  | {
      kind: 'message'
      slot?: DshStreamSlot
      message: CoworkMessageInput
    }
  | { kind: 'messageUpdate'; slot: DshStreamSlot; content: string }
  | { kind: 'messageFinalize'; slot: DshStreamSlot; content: string }
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
  thinkingFormat?: string
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
  /** User-configured MCP servers mounted as dsh-mcp-client plugin entries. */
  mcpServers?: DshMcpServerDefinition[]
  extraEntries?: Array<Record<string, unknown>>
  /** Extra env for the runtime process (credential vars, never keys in config). */
  env?: Record<string, string>
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

/** Event callbacks the host (coworkRunner adapter wiring) subscribes to. */
export interface DshKernelHandlers {
  onMessage: (sessionId: string, message: CoworkMessageInput, slot?: DshStreamSlot) => string
  onMessageUpdate: (sessionId: string, messageId: string, content: string) => void
  onMessageFinalize: (sessionId: string, messageId: string, content: string) => void
  onTurnEnd: (sessionId: string, reason: { kind: string; reason?: string }, emptyTerminal?: boolean) => void
  onUsage: (sessionId: string, usage: DshUsageSnapshot) => void
  onApprovalRequest: (sessionId: string, ask: DshApprovalAsk) => void
  onApprovalCancelled: (askId: string) => void
  onToolRequest: (request: DshHostToolRequest) => void
  onPolicyRequest?: (request: { id: string; sessionId: string; name: string; arguments: Record<string, unknown> }) => void
  onStatus?: (sessionId: string, status: 'idle' | 'running') => void
  onError?: (error: Error) => void
}
