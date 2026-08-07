/**
 * Renderer service wrapper for the Agent-Game-v2 host (docs/14). Wraps the
 * `window.electron.agentGame` IPC surface and owns the consent/session listener
 * lifecycle. Mirrors metaApp.ts (request/response) + cowork.ts (listeners).
 */

import type {
  AgentGameConsentCardInfo,
  AgentGameSessionResult,
  AgentGameSessionView,
  AgentGameSessionStatus,
} from '../types/agentGame';

class AgentGameService {
  private consentCleanups: Array<() => void> = [];

  /** Dispatch a browser.app.session.* method (start/list/status/pause/resume/stop). */
  async session(method: string, payload?: unknown, actorId?: string): Promise<AgentGameSessionResult> {
    try {
      return await window.electron.agentGame.session({ method, payload, actorId });
    } catch (error) {
      console.error('Failed to dispatch agent-game session method:', error);
      return { __error: true, code: 'internal_error', message: error instanceof Error ? error.message : String(error) };
    }
  }

  async respondConsent(requestId: string, approved: boolean, reason?: string): Promise<void> {
    try {
      await window.electron.agentGame.respondConsent({ requestId, approved, reason });
    } catch (error) {
      console.error('Failed to respond to agent-game consent:', error);
    }
  }

  async listPendingConsent(): Promise<AgentGameConsentCardInfo[]> {
    try {
      const result = await window.electron.agentGame.listPendingConsent();
      return result.cards ?? [];
    } catch (error) {
      console.error('Failed to list pending agent-game consent cards:', error);
      return [];
    }
  }

  async listSessions(input?: { appId?: string; status?: AgentGameSessionStatus; groupId?: string }): Promise<AgentGameSessionView[]> {
    try {
      const result = await window.electron.agentGame.listSessions(input);
      return result.sessions ?? [];
    } catch (error) {
      console.error('Failed to list agent-game sessions:', error);
      return [];
    }
  }

  /** Subscribe to consent-card requests + session updates. Returns a teardown. */
  setupListeners(handlers: {
    onConsentRequired: (info: AgentGameConsentCardInfo) => void;
    onSessionUpdated: (session: AgentGameSessionView) => void;
  }): () => void {
    const consentCleanup = window.electron.agentGame.onConsentRequired(handlers.onConsentRequired);
    const sessionCleanup = window.electron.agentGame.onSessionUpdated(handlers.onSessionUpdated);
    this.consentCleanups.push(consentCleanup, sessionCleanup);
    return () => {
      consentCleanup();
      sessionCleanup();
      this.consentCleanups = this.consentCleanups.filter((c) => c !== consentCleanup && c !== sessionCleanup);
    };
  }
}

export const agentGameService = new AgentGameService();
