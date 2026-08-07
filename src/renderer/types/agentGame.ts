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
}
