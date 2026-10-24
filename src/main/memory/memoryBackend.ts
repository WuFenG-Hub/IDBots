import type { CoworkMemoryGuardLevel } from '../libs/coworkMemoryExtractor';
import type {
  MemoryOrigin,
  MemoryScope,
  MemoryScopeKind,
  MemoryUsageClass,
  MemoryVisibility,
} from './memoryScope';

export type MemoryUserMemoryStatus = 'created' | 'stale' | 'deleted';

export interface MemoryUserMemory {
  id: string;
  text: string;
  confidence: number;
  isExplicit: boolean;
  status: MemoryUserMemoryStatus;
  scopeKind?: MemoryScopeKind;
  scopeKey?: string;
  usageClass?: MemoryUsageClass;
  visibility?: MemoryVisibility;
  origin?: MemoryOrigin;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  /**
   * Dream review P1: stamped only when the nightly hot-layer usage audit
   * judged the memory APPLIED in a reply; outranks lastUsedAt in hygiene
   * decay and prompt eviction. Absent on backends without the column.
   */
  lastAppliedAt?: number | null;
  /** Hygiene-archive timestamp; null/undefined means the row is active. */
  archivedAt?: number | null;
  /** Recall weight derived at write time (see memoryImportance.ts). */
  importance?: number;
  /**
   * Evidence ledger: active provenance rows corroborating this memory.
   * Populated by listUserMemories (one grouped count per call); feeds the
   * bounded proof boost in recall ranking. Absent = unknown = neutral.
   */
  proofCount?: number;
  /** Event-time axis (#3): when the fact/event happened; null = timeless. */
  occurredAt?: number | null;
}

export interface MemoryUserMemorySourceInput {
  sessionId?: string;
  messageId?: string;
  role?: 'user' | 'assistant' | 'tool' | 'system';
  sourceChannel?: string;
  sourceType?: string;
  externalConversationId?: string;
  sourceId?: string;
  /** Dream pipeline: the YYYY-MM-DD this memory was distilled from. */
  dreamDate?: string;
  /**
   * Evidence ledger: the verbatim excerpt this source contributed (see
   * memoryEvidence.ts). Storage + idle-time input only; never injected.
   */
  quote?: string;
}

export interface MemoryUserMemoryStats {
  total: number;
  created: number;
  stale: number;
  deleted: number;
  explicit: number;
  implicit: number;
}

export interface MemoryScopeSelectorInput {
  // Normalize and validate with `normalizeMemoryScopeSelector` before using these fields.
  scope?: MemoryScope;
  scopeKind?: MemoryScopeKind;
  scopeKey?: string;
}

export interface MemoryScopeClassifyInput {
  usageClass?: MemoryUsageClass;
  visibility?: MemoryVisibility;
}

export interface MemoryListUserMemoriesOptions extends MemoryScopeSelectorInput {
  metabotId: number;
  query?: string;
  status?: MemoryUserMemoryStatus | 'all';
  usageClass?: MemoryUsageClass;
  origin?: MemoryOrigin;
  limit?: number;
  offset?: number;
  includeDeleted?: boolean;
  /** Include hygiene-archived rows (admin/stats surfaces); default hides them. */
  includeArchived?: boolean;
  /**
   * Bump last_used_at on EVERY returned row. Only correct when the caller
   * renders the whole result set; prompt-injection paths (which rank + evict)
   * must pass false and touch the rendered ids via touchUserMemoriesLastUsed.
   */
  touchLastUsed?: boolean;
}

export interface MemoryCreateUserMemoryInput extends MemoryScopeSelectorInput, MemoryScopeClassifyInput {
  text: string;
  confidence?: number;
  isExplicit?: boolean;
  origin?: MemoryOrigin;
  /** Explicit importance override; when omitted the store derives it (memoryImportance.ts). */
  importance?: number;
  /**
   * Event-time axis (#3): absolute epoch ms (or YYYY-MM-DD string) of the
   * underlying event, extracted by the turn judge / dream pipeline.
   */
  occurredAt?: number | string | null;
  source?: MemoryUserMemorySourceInput;
  metabotId: number;
  /**
   * Internal escape hatch for the dream pipeline: skip fingerprint/semantic
   * revive and always insert a new row. Dream writes are authoritative
   * per-date batches — cross-date dedup would let a re-dreamed day resurrect
   * (and later cascade-delete) another day's entries.
   */
  forceNew?: boolean;
}

export interface MemoryUpdateUserMemoryInput extends MemoryScopeSelectorInput, MemoryScopeClassifyInput {
  id: string;
  metabotId: number;
  text?: string;
  confidence?: number;
  status?: MemoryUserMemoryStatus;
  isExplicit?: boolean;
  /** Internal escape hatch: only the dream service may touch protected entries (self_identity). */
  allowProtected?: boolean;
  /** When set, an additional source row is recorded for this memory. */
  source?: MemoryUserMemorySourceInput;
}

export interface MemoryDeleteUserMemoryInput extends MemoryScopeSelectorInput {
  id: string;
  metabotId: number;
  /** Internal escape hatch: only the dream service may touch protected entries (self_identity). */
  allowProtected?: boolean;
}

export interface MemoryPolicy {
  metabotId: number;
  memoryEnabled: boolean;
  memoryImplicitUpdateEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  memoryGuardLevel: CoworkMemoryGuardLevel;
  memoryUserMemoriesMaxItems: number;
  dreamEnabled: boolean;
  hygieneEnabled: boolean;
  /** Self-curriculum practice tasks (design 2026-10-10 §3.4); default off. */
  practiceTasksEnabled: boolean;
  /** Auto-approve read_only practice proposals (only effective with practiceTasksEnabled). */
  practiceAutoApproveReadOnly: boolean;
  updatedAt: number;
}

export interface MemoryEffectivePolicy {
  metabotId: number | null;
  memoryEnabled: boolean;
  memoryImplicitUpdateEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  memoryGuardLevel: CoworkMemoryGuardLevel;
  memoryUserMemoriesMaxItems: number;
  /** Combined char budget for injected memory blocks (oldest-first eviction; global-only). */
  memoryPromptMaxChars: number;
  dreamEnabled: boolean;
  /** Whether the nightly hygiene (active-forgetting) pass covers this bot. */
  hygieneEnabled: boolean;
  /** Self-curriculum practice tasks (design 2026-10-10 §3.4); default off. */
  practiceTasksEnabled: boolean;
  /** Auto-approve read_only practice proposals (only effective with practiceTasksEnabled). */
  practiceAutoApproveReadOnly: boolean;
  source: 'global' | 'metabot';
}

export type MemoryPolicyUpdates = Partial<Pick<
  MemoryEffectivePolicy,
  | 'memoryEnabled'
  | 'memoryImplicitUpdateEnabled'
  | 'memoryLlmJudgeEnabled'
  | 'memoryGuardLevel'
  | 'memoryUserMemoriesMaxItems'
  | 'dreamEnabled'
  | 'hygieneEnabled'
  | 'practiceTasksEnabled'
  | 'practiceAutoApproveReadOnly'
>>;

export interface ApplyTurnMemoryUpdatesOptions {
  sessionId: string;
  userText: string;
  assistantText: string;
  implicitEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  guardLevel: CoworkMemoryGuardLevel;
  userMessageId?: string;
  assistantMessageId?: string;
}

export interface ApplyTurnMemoryUpdatesResult {
  totalChanges: number;
  created: number;
  updated: number;
  deleted: number;
  judgeRejected: number;
  llmReviewed: number;
  skipped: number;
  /** Memory defense (#6): candidates refused for containing secrets. */
  defenseRejected: number;
}

export interface MemoryScopeSummary {
  kind: MemoryScopeKind;
  key: string;
  /** Number of non-deleted entries in this scope. */
  count: number;
  peerGlobalMetaId?: string | null;
  peerName?: string | null;
  peerAvatar?: string | null;
}

export interface MemoryScopesOverview {
  owner: MemoryScopeSummary | null;
  contacts: MemoryScopeSummary[];
  conversations: MemoryScopeSummary[];
}

export interface MemorySessionScopeResolution {
  metabotId: number;
  scope: MemoryScope;
  peerName?: string | null;
  peerAvatar?: string | null;
}

export interface MemoryBackend {
  resolveMetabotIdForMemory(sessionId?: string | null): number | null;
  getEffectiveMemoryPolicyForMetabot(metabotId?: number | null): MemoryEffectivePolicy;
  getEffectiveMemoryPolicyForSession(sessionId?: string | null): MemoryEffectivePolicy;
  setMemoryPolicyForMetabot(metabotId: number, updates: MemoryPolicyUpdates): MemoryPolicy;
  deleteMemoryPolicyForMetabot(metabotId: number): boolean;
  listUserMemories(options: MemoryListUserMemoriesOptions): MemoryUserMemory[];
  /**
   * Bump last_used_at for exactly the given rows — the usage event behind the
   * hygiene decay clock. Prompt-injection paths must call this with ONLY the
   * ids that actually rendered (see buildScopedMemoryPromptBlocksDetailed);
   * pooling a row without injecting it is not usage.
   */
  touchUserMemoriesLastUsed(metabotId: number, memoryIds: string[]): void;
  /**
   * Dream review P1: stamp last_applied_at for exactly the given rows — the
   * "was actually used" signal, written only when the nightly hot-layer usage
   * audit judges a memory APPLIED (evidence-cited) in a reply. Distinct from
   * the injection touch above; hygiene decay and prompt eviction read the
   * applied stamp first. Returns rows changed.
   */
  touchUserMemoriesLastApplied(metabotId: number, memoryIds: string[]): number;
  createUserMemory(input: MemoryCreateUserMemoryInput): MemoryUserMemory;
  updateUserMemory(input: MemoryUpdateUserMemoryInput): MemoryUserMemory | null;
  deleteUserMemory(input: MemoryDeleteUserMemoryInput): boolean;
  deleteUserMemory(id: string, metabotId: number): boolean;
  getUserMemoryStats(input: { metabotId: number } & MemoryScopeSelectorInput): MemoryUserMemoryStats;
  getUserMemoryStats(metabotId: number): MemoryUserMemoryStats;
  applyTurnMemoryUpdates(options: ApplyTurnMemoryUpdatesOptions): Promise<ApplyTurnMemoryUpdatesResult>;
  /** Aggregate of all memory scopes under one MetaBot, with peer identity resolved where possible. */
  listMemoryScopes(metabotId: number): MemoryScopesOverview;
  /** Resolve the write scope for a session (owner for local sessions, contact/conversation for external ones). */
  resolveMemoryScopeForSession(sessionId?: string | null): MemorySessionScopeResolution | null;
}
