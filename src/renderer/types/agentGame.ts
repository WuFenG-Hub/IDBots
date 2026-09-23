/**
 * Renderer-side types for the Agent-Game-v2 host (mirrors the main-process
 * abi.ts / consent.ts shapes that cross the IPC boundary).
 */

export type AgentGameSessionStatus = 'running' | 'paused' | 'stopped' | 'finished' | 'error';

/** Session view returned by browser.app.session.* and emitted on updates. */
export interface AgentGameSessionView {
  sessionId: string;
  status: AgentGameSessionStatus;
  appId: string;
  groupId: string;
  gameId: string;
  seat: string;
  agentId: string;
  lastIndex: number;
  lastActionSeq: number;
  lastError: { code: string; message: string; at: number } | null;
  expiresAt: number;
  budget: { llmCalls: number; llmCallsUsed: number; writes: number; writesUsed: number };
}

/** Consent card payload emitted by the host for start-time authorization. */
export interface AgentGameConsentCardInfo {
  requestId: string;
  actor: string;
  appId: string;
  groupId: string;
  gameId: string;
  seat: string;
  resourceUri: string;
  rulesHash: string;
  adapterHash: string;
  manifestUri: string;
  protocolPaths: string[];
  ttlMs: number;
  budget: { llmCalls: number; writes: number };
}

/** Authorization card issued by the host two-phase start (ABC renders it). */
export interface AgentGameSessionConfirmation {
  actor: { uri: string; globalMetaId: string; name: string };
  resourceUri: string;
  appId: string;
  sessionType: string;
  groupId: string;
  gameId: string;
  manifestUri: string;
  rulesHash: string;
  adapterHash: string;
  seat: string;
  protocolPaths: string[];
  ttlMs: number;
  llmBudget: number;
  writeBudget: number;
  expiresAt: number;
}

/** Host-issued confirmRequest the page must echo verbatim in Phase 2. */
export interface AgentGameSessionConfirmRequest {
  kind: 'app-session-start';
  resourceUri: string;
  payload: Record<string, unknown>;
}

/** Dispatch result envelope ({ __error: true, code, message } on failure). */
export interface AgentGameSessionResult {
  __error?: boolean;
  code?: string;
  message?: string;
  sessionId?: string;
  status?: AgentGameSessionStatus;
  lastIndex?: number;
  lastActionSeq?: number;
  lastError?: AgentGameSessionView['lastError'];
  expiresAt?: number;
  budget?: AgentGameSessionView['budget'];
  sessions?: AgentGameSessionView[];
  /** Two-phase start Phase 1 outcome (manual_action_required). */
  manualAction?: boolean;
  confirmation?: AgentGameSessionConfirmation;
  confirmRequest?: AgentGameSessionConfirmRequest;
}
