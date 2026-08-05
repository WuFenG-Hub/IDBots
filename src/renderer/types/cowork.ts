// Cowork session status
export type CoworkSessionStatus = 'idle' | 'running' | 'completed' | 'error';

/**
 * Permission mode controls how tool calls are gated in the cowork session.
 * - 'default': auto-allow edits; prompt for delete operations and AskUserQuestion.
 * - 'plan': read-only — deny all mutating tools (Write/Edit/Bash/...), allow only read tools.
 * - 'acceptEdits': auto-allow everything including deletes; keep AskUserQuestion prompts.
 * - 'bypassPermissions': auto-allow everything (full trust, no prompts at all).
 */
export type CoworkPermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';

// Cowork message types
export type CoworkMessageType = 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';

// Cowork execution mode
export type CoworkExecutionMode = 'auto' | 'local' | 'sandbox';

// Session type: standard = human↔MetaBot, a2a = MetaBot↔MetaBot, browser = Bot Browser co-work panel
export type CoworkSessionType = 'standard' | 'a2a' | 'browser';

export type CoworkSteerStatus = 'queued' | 'delivered' | 'settled' | 'failed' | 'cancelled';

// Cowork message metadata
export interface CoworkMessageMetadata {
  interactionKind?: 'steer';
  submissionId?: string;
  submissionMode?: 'steer' | 'continue';
  steerStatus?: CoworkSteerStatus;
  steerDeliveredAt?: number;
  steerSettledAt?: number;
  steerFailedAt?: number;
  steerCancelledAt?: number;
  steerErrorCode?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  toolUseId?: string | null;
  error?: string;
  isError?: boolean;
  isStreaming?: boolean;
  isFinal?: boolean;
  isThinking?: boolean;
  isDelegationInternal?: boolean;
  skillIds?: string[];
  /**
   * Prevent renderer stream listeners from treating this message as a new active run.
   * Used for passive A2A follow-up messages that should appear after completion without
   * restarting the session progress state.
   */
  suppressRunningStatus?: boolean;
  /**
   * A2A messages only. Message direction from the local MetaBot's perspective:
   * - 'outgoing': sent by the local MetaBot (displayed on the right)
   * - 'incoming': received from the remote peer (displayed on the left)
   * Only set on A2A sessions; standard sessions use message.type for rendering.
   */
  direction?: 'outgoing' | 'incoming';
  /**
   * A2A incoming messages only. The remote peer's globalmetaid.
   * Do NOT set on outgoing messages — use the session's peerGlobalMetaId instead.
   */
  senderGlobalMetaId?: string;
  /**
   * A2A incoming messages only. The remote peer's display name.
   * Do NOT set on outgoing messages — use the session's peerName instead.
   */
  senderName?: string;
  /**
   * A2A incoming messages only. The remote peer's avatar URL.
   * Do NOT set on outgoing messages — use the session's peerAvatar instead.
   */
  senderAvatar?: string;
  [key: string]: unknown;
}

// Ephemeral SDK runtime status carried on `type: 'system'` messages.
// Surfaced in StreamingActivityBar (transient, not a persisted bubble).
export type CoworkSdkRuntimeStatus = 'requesting' | 'api_retry';

export interface CoworkSdkRuntimeStatusPayload {
  /** Discriminator for SDK runtime-status system messages. */
  sdkRuntimeStatus?: CoworkSdkRuntimeStatus;
  /** Current retry attempt (1-based), present when sdkRuntimeStatus === 'api_retry'. */
  retryAttempt?: number;
  /** Max retries configured by the SDK, present when sdkRuntimeStatus === 'api_retry'. */
  retryMax?: number;
  /** HTTP error status that triggered the retry, if known. */
  retryErrorStatus?: number | null;
}

// Per-session token/cost usage, accumulated from SDK result events. The
// proxy translates DeepSeek's OpenAI usage into Anthropic cache fields, so
// cacheRead = prompt_cache_hit and cacheCreation = prompt_cache_miss.
export interface CoworkUsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** SDK-priced cost (Anthropic direct sessions only; proxy providers use local rates). */
  totalCostUsd?: number;
  /** Where the numbers came from: 'deepseek' via proxy, 'anthropic' direct, or none. */
  source: 'deepseek' | 'anthropic' | 'none';
}

// Live subagent / background task state, driven by SDK task_* and tool_progress
// events. Keyed by task_id in the cowork slice.
export type SubagentTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'killed'
  | 'paused';

export interface SubagentTaskState {
  taskId: string;
  /** Session this task belongs to (set by the renderer on ingest). */
  sessionId?: string;
  toolUseId?: string;
  subagentType?: string;
  /** Friendly task-type label ('shell' | 'subagent' | 'monitor' | 'workflow' ...). */
  taskType?: string;
  /** meta.name of the workflow script, when taskType is 'local_workflow'. */
  workflowName?: string;
  description?: string;
  prompt?: string;
  status: SubagentTaskStatus;
  /** True when the task runs in the background (Ctrl+B / backgroundTasks). */
  isBackgrounded?: boolean;
  /** End timestamp for terminal tasks. */
  endTime?: number;
  summary?: string;
  lastToolName?: string;
  outputFile?: string;
  error?: string;
  usage?: {
    totalTokens?: number;
    toolUses?: number;
    durationMs?: number;
  };
  startedAt?: number;
  updatedAt?: number;
}

// Cowork message
export interface CoworkMessage {
  id: string;
  type: CoworkMessageType;
  content: string;
  timestamp: number;
  metadata?: CoworkMessageMetadata;
}

export interface CoworkServiceOrderSummary {
  role?: 'buyer' | 'seller';
  status:
    | 'awaiting_first_response'
    | 'in_progress'
    | 'rating_pending'
    | 'completed'
    | 'failed'
    | 'refund_pending'
    | 'refunded';
  servicePinId?: string | null;
  serviceName?: string | null;
  paymentTxid?: string | null;
  outputType?: string | null;
  failureReason?: string | null;
  refundRequestPinId?: string | null;
  refundTxid?: string | null;
}

export interface CoworkA2AGuidanceRequest {
  sessionId: string;
  guidance: string;
}

export interface CoworkA2AGuidanceResult {
  success: boolean;
  mode?: 'queued' | 'restart_started';
  messageId?: string | null;
  error?: string;
}

// Cowork session
export interface CoworkContextUsage {
  /** Estimated tokens currently consumed by the conversation. */
  usedTokens: number;
  /** The model's total context window in tokens. */
  contextWindow: number;
  /** usedTokens / contextWindow, clamped to [0, 1]. */
  usageRatio: number;
  /**
   * When true, usedTokens/contextWindow come from the SDK's getContextUsage()
   * (real per-category accounting) rather than the local heuristic estimator.
   * Only available in local mode after at least one completed turn.
   */
  isRealUsage?: boolean;
  /** Per-category token breakdown from getContextUsage() (local mode only). */
  categories?: Array<{ name: string; tokens: number; color?: string }>;
}

export interface CoworkSession {
  id: string;
  title: string;
  claudeSessionId: string | null;
  status: CoworkSessionStatus;
  pinned: boolean;
  cwd: string;
  systemPrompt: string;
  executionMode: CoworkExecutionMode;
  activeSkillIds: string[];
  messages: CoworkMessage[];
  createdAt: number;
  updatedAt: number;
  /** FK to metabots.id; which MetaBot persona this session uses */
  metabotId?: number | null;
  /** Session type: 'standard' = human↔MetaBot, 'a2a' = MetaBot↔MetaBot */
  sessionType?: CoworkSessionType;
  /** Remote peer MetaBot's globalmetaid (A2A sessions only) */
  peerGlobalMetaId?: string | null;
  /** Remote peer MetaBot's display name (A2A sessions only) */
  peerName?: string | null;
  /** Remote peer MetaBot's avatar data URL (A2A sessions only) */
  peerAvatar?: string | null;
  /** Bot Browser context: URI of the tab this session is about (browser sessions only) */
  browserUri?: string | null;
  /** Bot Browser context: title of the tab this session is about (browser sessions only) */
  browserTitle?: string | null;
  /** Local MetaBot's display name */
  metabotName?: string | null;
  /** Local MetaBot's avatar data URL */
  metabotAvatar?: string | null;
  serviceOrderSummary?: CoworkServiceOrderSummary | null;
  /** Estimated context-window usage, computed by the main process on session load (not persisted). */
  contextUsage?: CoworkContextUsage | null;
  /** Permission mode for tool gating. Defaults to 'default'. Can change mid-session. */
  permissionMode?: CoworkPermissionMode;
  /** Accumulated token/cost usage (computed by the main process, not persisted). */
  usageStats?: CoworkUsageStats | null;
}

// Cowork configuration
export interface CoworkConfig {
  workingDirectory: string;
  systemPrompt: string;
  executionMode: CoworkExecutionMode;
  memoryEnabled: boolean;
  memoryImplicitUpdateEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  memoryGuardLevel: 'strict' | 'standard' | 'relaxed';
  memoryUserMemoriesMaxItems: number;
}

export type CoworkConfigUpdate = Partial<Pick<
  CoworkConfig,
  | 'workingDirectory'
  | 'executionMode'
  | 'memoryEnabled'
  | 'memoryImplicitUpdateEnabled'
  | 'memoryLlmJudgeEnabled'
  | 'memoryGuardLevel'
  | 'memoryUserMemoriesMaxItems'
>>;

export interface CoworkApiConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  apiType?: 'anthropic' | 'openai';
  /** Optional SDK fallback model id (see main-side CoworkApiConfig). */
  fallbackModel?: string;
}

export type CoworkSandboxStatus = {
  supported: boolean;
  runtimeReady: boolean;
  imageReady: boolean;
  downloading: boolean;
  progress?: CoworkSandboxProgress;
  error?: string | null;
};

export type CoworkSandboxProgress = {
  stage: 'runtime' | 'image';
  received: number;
  total?: number;
  percent?: number;
  url?: string;
};

export type CoworkUserMemoryStatus = 'created' | 'stale' | 'deleted';

export interface CoworkUserMemoryEntry {
  id: string;
  text: string;
  confidence: number;
  isExplicit: boolean;
  status: CoworkUserMemoryStatus;
  /** 'self_identity' entries are dream-written and protected from edit/delete. */
  usageClass?: 'profile_fact' | 'preference' | 'operational_preference' | 'self_identity' | 'work_review';
  origin?: 'conversation' | 'dream';
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

export interface CoworkMemoryStats {
  total: number;
  created: number;
  stale: number;
  deleted: number;
  explicit: number;
  implicit: number;
}

export interface CoworkMemoryPolicy {
  metabotId: number | null;
  memoryEnabled: boolean;
  memoryImplicitUpdateEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  memoryGuardLevel: 'strict' | 'standard' | 'relaxed';
  memoryUserMemoriesMaxItems: number;
  source: 'global' | 'metabot';
}

// Cowork pending permission request
export interface CoworkPermissionRequest {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  requestId: string;
  toolUseId?: string | null;
}

export type CoworkPermissionResult =
  | {
      behavior: 'allow';
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: Record<string, unknown>[];
      toolUseID?: string;
    }
  | {
      behavior: 'deny';
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
    };

// Cowork permission response
export interface CoworkPermissionResponse {
  requestId: string;
  result: CoworkPermissionResult;
}

// Session summary for list display (without full messages)
export interface CoworkSessionSummary {
  id: string;
  title: string;
  status: CoworkSessionStatus;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  /** Owning MetaBot id (null for legacy/unattributed sessions) */
  metabotId?: number | null;
  /** Only populated for archived sessions. */
  archivedAt?: number | null;
  /** Session type: 'standard' = human↔MetaBot, 'a2a' = MetaBot↔MetaBot */
  sessionType?: CoworkSessionType;
  /** Remote peer MetaBot's display name (A2A sessions only) */
  peerName?: string | null;
  /** Remote peer MetaBot's avatar (A2A sessions only) */
  peerAvatar?: string | null;
  /** Owning MetaBot's display name, when attributed */
  metabotName?: string | null;
  /** Owning MetaBot's avatar (data URL or remote URL), when attributed */
  metabotAvatar?: string | null;
  /** Bot Browser context: URI of the tab this session is about (browser sessions only) */
  browserUri?: string | null;
  /** Bot Browser context: title of the tab this session is about (browser sessions only) */
  browserTitle?: string | null;
  serviceOrderSummary?: CoworkServiceOrderSummary | null;
}

// Start session options
export interface CoworkStartOptions {
  prompt: string;
  cwd?: string;
  systemPrompt?: string;
  title?: string;
  activeSkillIds?: string[];
  metabotId?: number | null;
  /** Only 'standard' (default) and 'browser' sessions can be created from the renderer. */
  sessionType?: 'standard' | 'browser';
  /** Permission mode for this session. Defaults to 'default'. */
  permissionMode?: CoworkPermissionMode;
}

// Continue session options
export interface CoworkContinueOptions {
  sessionId: string;
  prompt: string;
  systemPrompt?: string;
  activeSkillIds?: string[];
  /** Update the session's permission mode for this and subsequent turns. */
  permissionMode?: CoworkPermissionMode;
}

export interface CoworkSubmitInput {
  sessionId: string;
  submissionId: string;
  text: string;
  systemPrompt?: string;
  activeSkillIds?: string[];
}

export type CoworkSubmitInputErrorCode =
  | 'invalid_input'
  | 'session_not_found'
  | 'unsupported_session'
  | 'unsupported_execution'
  | 'cancelled'
  | 'delivery_failed';

export type CoworkSubmitInputResult =
  | {
      success: true;
      mode: 'steer' | 'continue';
      message: CoworkMessage;
    }
  | {
      success: false;
      code: CoworkSubmitInputErrorCode;
      error: string;
    };

// IPC result types
export interface CoworkSessionResult {
  success: boolean;
  session?: CoworkSession;
  error?: string;
}

export interface CoworkSessionListResult {
  success: boolean;
  sessions?: CoworkSessionSummary[];
  error?: string;
}

export interface CoworkConfigResult {
  success: boolean;
  config?: CoworkConfig;
  error?: string;
}

// Stream event types for IPC communication
export type CoworkStreamEventType =
  | 'message'
  | 'tool_use'
  | 'tool_result'
  | 'permission_request'
  | 'complete'
  | 'error';

export interface CoworkStreamEvent {
  type: CoworkStreamEventType;
  sessionId: string;
  data: {
    message?: CoworkMessage;
    permission?: CoworkPermissionRequest;
    error?: string;
    claudeSessionId?: string;
  };
}
