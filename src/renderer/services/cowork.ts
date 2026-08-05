import { store } from '../store';
import {
  setSessions,
  setCurrentSession,
  addSession,
  registerBackgroundSession,
  updateSessionStatus,
  deleteSession as deleteSessionAction,
  addMessage,
  updateMessageContent,
  setStreaming,
  updateSessionPinned,
  updateSessionTitle,
  updateSessionPermissionMode,
  enqueuePendingPermission,
  dequeuePendingPermission,
  setConfig,
  clearCurrentSession,
} from '../store/slices/coworkSlice';
import {
  addBrowserMessage,
  updateBrowserMessageContent,
  updateBrowserSessionStatus,
} from '../store/slices/browserCoworkSlice';
import type {
  CoworkSession,
  CoworkConfigUpdate,
  CoworkApiConfig,
  CoworkSandboxStatus,
  CoworkSandboxProgress,
  CoworkUserMemoryEntry,
  CoworkMemoryStats,
  CoworkMemoryPolicy,
  CoworkPermissionResult,
  CoworkA2AGuidanceRequest,
  CoworkA2AGuidanceResult,
  CoworkPermissionMode,
  CoworkStartOptions,
  CoworkContinueOptions,
  CoworkSubmitInput,
  CoworkSubmitInputResult,
} from '../types/cowork';
import {
  shouldMarkSessionRunningFromStreamMessage,
  shouldRegisterStreamSessionFromFetch,
} from './coworkStreamPresentation';
import { i18nService } from './i18n';

class CoworkService {
  private streamListenerCleanups: Array<() => void> = [];
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;

    // Load initial config
    await this.loadConfig();

    // Load sessions list
    await this.loadSessions();

    // Set up stream listeners
    this.setupStreamListeners();

    this.initialized = true;
  }

  private setupStreamListeners(): void {
    const cowork = window.electron?.cowork;
    if (!cowork) return;

    // Clean up any existing listeners
    this.cleanupListeners();

    // Message listener - also check if session exists (for IM-created sessions)
    const messageCleanup = cowork.onStreamMessage(async ({ sessionId, message }) => {
      // Check if session exists in current list
      let state = store.getState().cowork;
      let sessionExists = state.sessions.some(s => s.id === sessionId);

      if (!sessionExists) {
        // Session was created by IM or another source, refresh the session list
        await this.loadSessions();
        // Re-check after reload
        state = store.getState().cowork;
        sessionExists = state.sessions.some(s => s.id === sessionId);
      }

      // If still not found (e.g. race condition), fetch and register it directly
      if (!sessionExists) {
        try {
          const result = await window.electron?.cowork?.getSession(sessionId);
          if (result?.success && result.session) {
            const s = result.session;
            if (shouldRegisterStreamSessionFromFetch(s)) {
              store.dispatch(registerBackgroundSession({
                id: s.id,
                title: s.title,
                status: s.status,
                pinned: s.pinned ?? false,
                createdAt: s.createdAt,
                updatedAt: s.updatedAt,
                sessionType: s.sessionType,
                peerName: s.peerName ?? null,
                peerAvatar: s.peerAvatar ?? null,
                metabotId: s.metabotId ?? null,
                metabotName: s.metabotName ?? null,
                metabotAvatar: s.metabotAvatar ?? null,
                serviceOrderSummary: s.serviceOrderSummary ?? null,
              }));
            }
          }
        } catch { /* ignore */ }
      }

      // A new user turn means this session is actively running again
      // (especially important for IM-triggered turns that do not call continueSession from renderer).
      if (shouldMarkSessionRunningFromStreamMessage(message)) {
        store.dispatch(updateSessionStatus({ sessionId, status: 'running' }));
        store.dispatch(updateBrowserSessionStatus({ sessionId, status: 'running' }));
      }

      // Do not force status back to "running" on arbitrary messages.
      // Late stream chunks can arrive after an error/complete event.
      store.dispatch(addMessage({ sessionId, message }));
      store.dispatch(addBrowserMessage({ sessionId, message }));

      if (message.metadata?.refreshSessionSummary) {
        await this.loadSessions();
        if (store.getState().cowork.currentSessionId === sessionId) {
          try {
            const refreshed = await window.electron?.cowork?.getSession(sessionId);
            if (refreshed?.success && refreshed.session) {
              store.dispatch(setCurrentSession(refreshed.session));
            }
          } catch { /* ignore */ }
        }
      }
    });
    this.streamListenerCleanups.push(messageCleanup);

    // Message update listener (for streaming content updates)
    const messageUpdateCleanup = cowork.onStreamMessageUpdate(({ sessionId, messageId, content, metadata }) => {
      store.dispatch(updateMessageContent({ sessionId, messageId, content, metadata }));
      store.dispatch(updateBrowserMessageContent({ sessionId, messageId, content, metadata }));
    });
    this.streamListenerCleanups.push(messageUpdateCleanup);

    // Permission request listener
    const permissionCleanup = cowork.onStreamPermission(({ sessionId, request }) => {
      store.dispatch(enqueuePendingPermission({
        sessionId,
        toolName: request.toolName,
        toolInput: request.toolInput,
        requestId: request.requestId,
        toolUseId: request.toolUseId ?? null,
      }));
    });
    this.streamListenerCleanups.push(permissionCleanup);

    // Complete listener
    const completeCleanup = cowork.onStreamComplete(({ sessionId }) => {
      store.dispatch(updateSessionStatus({ sessionId, status: 'completed' }));
      store.dispatch(updateBrowserSessionStatus({ sessionId, status: 'completed' }));
    });
    this.streamListenerCleanups.push(completeCleanup);

    // Error listener
    const errorCleanup = cowork.onStreamError(({ sessionId }) => {
      store.dispatch(updateSessionStatus({ sessionId, status: 'error' }));
      store.dispatch(updateBrowserSessionStatus({ sessionId, status: 'error' }));
    });
    this.streamListenerCleanups.push(errorCleanup);

    // A2A peer profile (name/avatar) was refreshed from latest chain data in
    // the main process; reload so the session list and open detail show it.
    const profileRefreshedCleanup = cowork.onSessionProfileRefreshed?.(async ({ sessionId }) => {
      await this.loadSessions();
      if (store.getState().cowork.currentSessionId === sessionId) {
        try {
          const refreshed = await window.electron?.cowork?.getSession(sessionId);
          if (refreshed?.success && refreshed.session) {
            store.dispatch(setCurrentSession(refreshed.session));
          }
        } catch { /* ignore */ }
      }
    });
    if (typeof profileRefreshedCleanup === 'function') {
      this.streamListenerCleanups.push(profileRefreshedCleanup);
    }
  }

  private cleanupListeners(): void {
    this.streamListenerCleanups.forEach(cleanup => cleanup());
    this.streamListenerCleanups = [];
  }

  async loadSessions(): Promise<void> {
    const result = await window.electron?.cowork?.listSessions();
    if (result?.success && result.sessions) {
      store.dispatch(setSessions(result.sessions));
    }
  }

  async loadConfig(): Promise<void> {
    const result = await window.electron?.cowork?.getConfig();
    if (result?.success && result.config) {
      store.dispatch(setConfig(result.config));
    }
  }

  async startSession(options: CoworkStartOptions): Promise<CoworkSession | null> {
    const cowork = window.electron?.cowork;
    if (!cowork) {
      console.error('Cowork API not available');
      return null;
    }

    store.dispatch(setStreaming(true));

    const result = await cowork.startSession(options);
    if (result.success && result.session) {
      store.dispatch(addSession(result.session));
      return result.session;
    }

    store.dispatch(setStreaming(false));
    console.error('Failed to start session:', result.error);
    return null;
  }

  async continueSession(options: CoworkContinueOptions): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) {
      console.error('Cowork API not available');
      return false;
    }

    store.dispatch(setStreaming(true));
    store.dispatch(updateSessionStatus({ sessionId: options.sessionId, status: 'running' }));

    const result = await cowork.continueSession({
      sessionId: options.sessionId,
      prompt: options.prompt,
      systemPrompt: options.systemPrompt,
      activeSkillIds: options.activeSkillIds,
    });
    if (!result.success) {
      store.dispatch(setStreaming(false));
      store.dispatch(updateSessionStatus({ sessionId: options.sessionId, status: 'error' }));
      console.error('Failed to continue session:', result.error);
      return false;
    }

    return true;
  }

  async submitInput(input: CoworkSubmitInput): Promise<CoworkSubmitInputResult> {
    const cowork = window.electron?.cowork;
    if (!cowork?.submitInput) {
      return {
        success: false,
        code: 'delivery_failed',
        error: 'Cowork submit API not available',
      };
    }

    try {
      return await cowork.submitInput(input);
    } catch (error) {
      return {
        success: false,
        code: 'delivery_failed',
        error: error instanceof Error ? error.message : 'Failed to submit Cowork input',
      };
    }
  }

  async stopSession(sessionId: string): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) return false;

    const result = await cowork.stopSession(sessionId);
    if (result.success) {
      store.dispatch(setStreaming(false));
      store.dispatch(updateSessionStatus({ sessionId, status: 'idle' }));
      return true;
    }

    console.error('Failed to stop session:', result.error);
    return false;
  }

  async setPermissionMode(sessionId: string, mode: CoworkPermissionMode): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.setPermissionMode) {
      console.error('setPermissionMode API not available');
      return false;
    }
    const result = await cowork.setPermissionMode(sessionId, mode);
    if (result.success) {
      store.dispatch(updateSessionPermissionMode({ sessionId, permissionMode: mode }));
      return true;
    }
    console.error('Failed to set permission mode:', result.error);
    return false;
  }

  async setEffort(sessionId: string, effort: string | null): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.setEffort) {
      console.error('setEffort API not available');
      return false;
    }
    const result = await cowork.setEffort(sessionId, effort);
    if (!result.success) {
      console.error('Failed to set effort level:', result.error);
      return false;
    }
    return true;
  }

  async endA2APrivateChat(sessionId: string): Promise<{ success: boolean; noticeSent?: boolean; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.endA2APrivateChat) {
      return { success: false, error: 'A2A private chat end API not available' };
    }

    const result = await cowork.endA2APrivateChat(sessionId);
    if (result.success) {
      store.dispatch(updateSessionStatus({ sessionId, status: 'completed' }));
      await this.loadSession(sessionId);
      return {
        success: true,
        noticeSent: result.noticeSent,
      };
    }

    console.error('Failed to end A2A private chat:', result.error);
    return { success: false, error: result.error || 'Failed to end A2A private chat' };
  }

  async queueA2AGuidance(input: CoworkA2AGuidanceRequest): Promise<CoworkA2AGuidanceResult> {
    const request = {
      sessionId: String(input.sessionId || '').trim(),
      guidance: String(input.guidance || '').trim(),
    };
    const cowork = window.electron?.cowork;
    if (!cowork?.queueA2AGuidance) {
      return { success: false, error: 'A2A guidance API not available' };
    }
    if (!request.sessionId || !request.guidance) {
      return { success: false, error: i18nService.t('a2aGuidanceEmpty') };
    }

    try {
      const result = await cowork.queueA2AGuidance(request);
      if (result?.success) {
        if (result.mode === 'restart_started') {
          if (store.getState().cowork.currentSessionId === request.sessionId) {
            await this.loadSession(request.sessionId, { onlyIfCurrent: true });
          }
          await this.loadSessions();
        }
        return {
          success: true,
          mode: result.mode,
          messageId: result.messageId ?? null,
        };
      }
      return { success: false, error: result?.error || i18nService.t('a2aGuidanceFailed') };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : i18nService.t('a2aGuidanceFailed'),
      };
    }
  }

  async resendA2ADeliveryArtifact(input: string | { sessionId: string; orderTxid?: string | null }): Promise<{ success: boolean; deliveryPinId?: string | null; error?: string }> {
    const request = typeof input === 'string' ? { sessionId: input } : input;
    const cowork = window.electron?.cowork;
    if (!cowork?.resendA2ADeliveryArtifact) {
      return { success: false, error: 'A2A delivery resend API not available' };
    }

    try {
      const result = await cowork.resendA2ADeliveryArtifact(request);
      if (result?.success) {
        await this.loadSession(request.sessionId);
        await this.loadSessions();
        return {
          success: true,
          deliveryPinId: result.deliveryPinId ?? null,
        };
      }
      return { success: false, error: result?.error || 'Failed to resend digital delivery' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to resend digital delivery',
      };
    }
  }

  /**
   * Archive a session: it leaves the UI list but every record is preserved
   * (dream consolidation and experience retrieval still see it). Hard delete
   * is intentionally not exposed to users — experience data is valuable.
   */
  async archiveSession(sessionId: string): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) return false;

    const result = await cowork.archiveSession(sessionId);
    if (result.success) {
      store.dispatch(deleteSessionAction(sessionId));
      return true;
    }

    console.error('Failed to archive session:', result.error);
    return false;
  }

  async setSessionPinned(sessionId: string, pinned: boolean): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.setSessionPinned) return false;

    const result = await cowork.setSessionPinned({ sessionId, pinned });
    if (result.success) {
      store.dispatch(updateSessionPinned({ sessionId, pinned }));
      return true;
    }

    console.error('Failed to update session pin:', result.error);
    return false;
  }

  async renameSession(sessionId: string, title: string): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.renameSession) return false;

    const normalizedTitle = title.trim();
    if (!normalizedTitle) return false;

    const result = await cowork.renameSession({ sessionId, title: normalizedTitle });
    if (result.success) {
      store.dispatch(updateSessionTitle({ sessionId, title: normalizedTitle }));
      return true;
    }

    console.error('Failed to rename session:', result.error);
    return false;
  }

  async processServiceRefund(sessionId: string): Promise<{
    success: boolean;
    refundTxid?: string;
    refundFinalizePinId?: string;
    error?: string;
  }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.processServiceRefund) {
      return { success: false, error: 'Cowork refund API not available' };
    }

    try {
      const result = await cowork.processServiceRefund(sessionId);
      if (result?.success) {
        if (result.session) {
          store.dispatch(setCurrentSession(result.session));
        } else {
          await this.loadSession(sessionId);
        }
        await this.loadSessions();
        return {
          success: true,
          refundTxid: result.refundTxid,
          refundFinalizePinId: result.refundFinalizePinId,
        };
      }
      return { success: false, error: result?.error || 'Failed to process service refund' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to process service refund',
      };
    }
  }

  async exportSessionResultImage(options: {
    rect: { x: number; y: number; width: number; height: number };
    defaultFileName?: string;
  }): Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.exportResultImage) {
      return { success: false, error: 'Cowork export API not available' };
    }

    try {
      const result = await cowork.exportResultImage(options);
      return result ?? { success: false, error: 'Failed to export session image' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to export session image',
      };
    }
  }

  async captureSessionImageChunk(options: {
    rect: { x: number; y: number; width: number; height: number };
  }): Promise<{ success: boolean; width?: number; height?: number; pngBase64?: string; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.captureImageChunk) {
      return { success: false, error: 'Cowork capture API not available' };
    }

    try {
      const result = await cowork.captureImageChunk(options);
      return result ?? { success: false, error: 'Failed to capture session image chunk' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to capture session image chunk',
      };
    }
  }

  async saveSessionResultImage(options: {
    pngBase64: string;
    defaultFileName?: string;
  }): Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.saveResultImage) {
      return { success: false, error: 'Cowork save image API not available' };
    }

    try {
      const result = await cowork.saveResultImage(options);
      return result ?? { success: false, error: 'Failed to save session image' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save session image',
      };
    }
  }

  async loadSession(sessionId: string, options: { onlyIfCurrent?: boolean } = {}): Promise<CoworkSession | null> {
    const cowork = window.electron?.cowork;
    if (!cowork) return null;

    const result = await cowork.getSession(sessionId);
    if (result.success && result.session) {
      if (options.onlyIfCurrent && store.getState().cowork.currentSessionId !== sessionId) {
        return result.session;
      }
      store.dispatch(setCurrentSession(result.session));
      store.dispatch(setStreaming(result.session.status === 'running'));
      return result.session;
    }

    console.error('Failed to load session:', result.error);
    return null;
  }

  async respondToPermission(requestId: string, result: CoworkPermissionResult): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) return false;

    const response = await cowork.respondToPermission({ requestId, result });
    if (response.success) {
      store.dispatch(dequeuePendingPermission({ requestId }));
      return true;
    }

    console.error('Failed to respond to permission:', response.error);
    return false;
  }

  async updateConfig(config: CoworkConfigUpdate): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) return false;

    const result = await cowork.setConfig(config);
    if (result.success) {
      const currentConfig = store.getState().cowork.config;
      store.dispatch(setConfig({ ...currentConfig, ...config }));
      return true;
    }

    console.error('Failed to update config:', result.error);
    return false;
  }

  async getApiConfig(): Promise<CoworkApiConfig | null> {
    if (!window.electron?.getApiConfig) {
      return null;
    }
    return window.electron.getApiConfig();
  }

  async checkApiConfig(): Promise<{ hasConfig: boolean; config: CoworkApiConfig | null; error?: string } | null> {
    if (!window.electron?.checkApiConfig) {
      return null;
    }
    return window.electron.checkApiConfig();
  }

  async saveApiConfig(config: CoworkApiConfig): Promise<{ success: boolean; error?: string } | null> {
    if (!window.electron?.saveApiConfig) {
      return null;
    }
    return window.electron.saveApiConfig(config);
  }

  async getSandboxStatus(): Promise<CoworkSandboxStatus | null> {
    if (!window.electron?.cowork?.getSandboxStatus) {
      return null;
    }
    return window.electron.cowork.getSandboxStatus();
  }

  async installSandbox(): Promise<{ success: boolean; status: CoworkSandboxStatus; error?: string } | null> {
    if (!window.electron?.cowork?.installSandbox) {
      return null;
    }
    return window.electron.cowork.installSandbox();
  }

  async listMemoryEntries(input: {
    sessionId?: string;
    metabotId?: number;
    query?: string;
    status?: 'created' | 'stale' | 'deleted' | 'all';
    includeDeleted?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<CoworkUserMemoryEntry[]> {
    const api = window.electron?.cowork?.listMemoryEntries;
    if (!api) return [];
    const result = await api(input);
    if (!result?.success || !result.entries) return [];
    return result.entries;
  }

  async createMemoryEntry(input: {
    sessionId?: string;
    metabotId?: number;
    text: string;
    confidence?: number;
    isExplicit?: boolean;
  }): Promise<CoworkUserMemoryEntry | null> {
    const api = window.electron?.cowork?.createMemoryEntry;
    if (!api) return null;
    const result = await api(input);
    if (!result?.success || !result.entry) return null;
    return result.entry;
  }

  async updateMemoryEntry(input: {
    sessionId?: string;
    metabotId?: number;
    id: string;
    text?: string;
    confidence?: number;
    status?: 'created' | 'stale' | 'deleted';
    isExplicit?: boolean;
  }): Promise<CoworkUserMemoryEntry | null> {
    const api = window.electron?.cowork?.updateMemoryEntry;
    if (!api) return null;
    const result = await api(input);
    if (!result?.success || !result.entry) return null;
    return result.entry;
  }

  async deleteMemoryEntry(input: { sessionId?: string; metabotId?: number; id: string }): Promise<boolean> {
    const api = window.electron?.cowork?.deleteMemoryEntry;
    if (!api) return false;
    const result = await api(input);
    return Boolean(result?.success);
  }

  async getMemoryStats(input?: { sessionId?: string; metabotId?: number }): Promise<CoworkMemoryStats | null> {
    const api = window.electron?.cowork?.getMemoryStats;
    if (!api) return null;
    const result = await api(input);
    if (!result?.success || !result.stats) return null;
    return result.stats;
  }

  async getMemoryPolicy(input?: { sessionId?: string; metabotId?: number }): Promise<CoworkMemoryPolicy | null> {
    const api = window.electron?.cowork?.getMemoryPolicy;
    if (!api) return null;
    const result = await api(input);
    if (!result?.success || !result.policy) return null;
    return result.policy;
  }

  async setMemoryPolicy(input: {
    metabotId: number;
    memoryEnabled?: boolean;
    memoryImplicitUpdateEnabled?: boolean;
    memoryLlmJudgeEnabled?: boolean;
    memoryGuardLevel?: 'strict' | 'standard' | 'relaxed';
    memoryUserMemoriesMaxItems?: number;
  }): Promise<CoworkMemoryPolicy | null> {
    const api = window.electron?.cowork?.setMemoryPolicy;
    if (!api) return null;
    const result = await api(input);
    if (!result?.success || !result.policy) return null;
    return result.policy;
  }

  onSandboxDownloadProgress(callback: (progress: CoworkSandboxProgress) => void): () => void {
    if (!window.electron?.cowork?.onSandboxDownloadProgress) {
      return () => {};
    }
    return window.electron.cowork.onSandboxDownloadProgress(callback);
  }

  async generateSessionTitle(prompt: string | null): Promise<string | null> {
    if (!window.electron?.generateSessionTitle) {
      return null;
    }
    return window.electron.generateSessionTitle(prompt);
  }

  async getRecentCwds(limit?: number): Promise<string[]> {
    if (!window.electron?.getRecentCwds) {
      return [];
    }
    return window.electron.getRecentCwds(limit);
  }

  clearSession(): void {
    store.dispatch(clearCurrentSession());
  }

  destroy(): void {
    this.cleanupListeners();
    this.initialized = false;
  }
}

export const coworkService = new CoworkService();
