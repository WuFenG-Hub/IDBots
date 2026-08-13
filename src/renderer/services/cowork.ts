import { store } from '../store';
import {
  setSessions,
  setCurrentSession,
  addSession,
  registerBackgroundSession,
  updateSessionStatus,
  deleteSession as deleteSessionAction,
  addMessage,
  prependMessages,
  updateMessageContent,
  setMessageFeedback as setMessageFeedbackAction,
  clearMessageFeedback as clearMessageFeedbackAction,
  loadSessionFeedback as loadSessionFeedbackAction,
  setStreaming,
  updateSessionPinned,
  updateSessionTitle,
  updateSessionPermissionMode,
  upsertSubagentTask,
  setSubagentTasks,
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
  CoworkMemoryScopesOverview,
  CoworkSessionMemoryScope,
  CoworkMetaIDContactSummary,
  CoworkMetaIDContactDetail,
  CoworkKnowledgeEntry,
  CoworkKnowledgeKind,
  CoworkKnowledgeStatus,
  CoworkPermissionResult,
  CoworkA2AGuidanceRequest,
  CoworkA2AGuidanceResult,
  CoworkA2AHistoryCursor,
  CoworkA2AHistoryPage,
  CoworkPermissionMode,
  CoworkStartOptions,
  CoworkContinueOptions,
  CoworkSubmitInput,
  CoworkSubmitInputResult,
  CoworkMessage,
  MessageFeedbackRating,
  SubagentTaskState,
  SubagentTaskStatus,
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

      // Subagent activity events ride on system messages via
      // metadata.subagentEvent; drive the live subagent panel, not the message list.
      const subagentEvent = message.metadata?.subagentEvent as
        | (Record<string, unknown> & { event?: string; taskId?: string })
        | undefined;
      if (subagentEvent?.event) {
        const eventName = subagentEvent.event;

        // background_tasks_changed is a level signal for the whole set (no
        // taskId); REPLACE the task map. Preserve existing task detail — the
        // payload is ids-only — and keep real terminal status.
        if (eventName === 'background_tasks_changed') {
          const backgroundTasks = Array.isArray(subagentEvent.backgroundTasks)
            ? subagentEvent.backgroundTasks as Array<{ taskId: string; taskType: string; description: string }>
            : [];
          store.dispatch(setSubagentTasks({
            sessionId,
            tasks: backgroundTasks,
          }));
          return;
        }

        if (!subagentEvent.taskId) return;
        const taskId = String(subagentEvent.taskId);
        const task: SubagentTaskState = {
          taskId,
          sessionId,
          toolUseId: typeof subagentEvent.toolUseId === 'string' ? subagentEvent.toolUseId : undefined,
          subagentType: typeof subagentEvent.subagentType === 'string' ? subagentEvent.subagentType : undefined,
          taskType: typeof subagentEvent.taskType === 'string' ? subagentEvent.taskType : undefined,
          workflowName: typeof subagentEvent.workflowName === 'string' ? subagentEvent.workflowName : undefined,
          description: typeof subagentEvent.description === 'string' ? subagentEvent.description : undefined,
          prompt: typeof subagentEvent.prompt === 'string' ? subagentEvent.prompt : undefined,
          status: (subagentEvent.status as SubagentTaskStatus) ?? 'running',
          isBackgrounded: typeof subagentEvent.isBackgrounded === 'boolean'
            ? subagentEvent.isBackgrounded
            : undefined,
          endTime: typeof subagentEvent.endTime === 'number' ? subagentEvent.endTime : undefined,
          summary: typeof subagentEvent.summary === 'string' ? subagentEvent.summary : undefined,
          lastToolName: typeof subagentEvent.lastToolName === 'string' ? subagentEvent.lastToolName : undefined,
          outputFile: typeof subagentEvent.outputFile === 'string' ? subagentEvent.outputFile : undefined,
          error: typeof subagentEvent.error === 'string' ? subagentEvent.error : undefined,
          usage: subagentEvent.usage as SubagentTaskState['usage'],
          startedAt: typeof subagentEvent.startedAt === 'number' ? subagentEvent.startedAt : undefined,
          updatedAt: typeof subagentEvent.updatedAt === 'number' ? subagentEvent.updatedAt : undefined,
        };
        store.dispatch(upsertSubagentTask(task));
      }

      if (message.metadata?.refreshSessionSummary) {
        await this.loadSessions();
        const currentSessionId = store.getState().cowork.currentSessionId;
        const previousEpisodeSessionId = typeof message.metadata.previousEpisodeSessionId === 'string'
          ? message.metadata.previousEpisodeSessionId
          : null;
        if (previousEpisodeSessionId && currentSessionId === previousEpisodeSessionId) {
          await this.loadSession(sessionId);
        } else if (currentSessionId === sessionId) {
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
      // Correct the status from the backend if it did NOT actually mark the
      // turn completed. An "empty terminal turn" (DeepSeek thinking-placeholder
      // truncation — the model ended with only reasoning and no final reply)
      // is left `idle` by the backend; without this correction the task list
      // would falsely show "completed" while the final handoff is missing.
      // Also refreshes the current session so usageStats (token/cost chip)
      // reflects the just-finished turn.
      void window.electron?.cowork?.getSession(sessionId).then((refreshed) => {
        if (!refreshed?.success || !refreshed.session) return;
        const backendStatus = refreshed.session.status;
        if (backendStatus && backendStatus !== 'completed') {
          store.dispatch(updateSessionStatus({ sessionId, status: backendStatus }));
          store.dispatch(updateBrowserSessionStatus({ sessionId, status: backendStatus }));
        }
        if (store.getState().cowork.currentSessionId === sessionId) {
          store.dispatch(setCurrentSession(refreshed.session));
        }
      }).catch(() => {});
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

  /**
   * Queues a manual compaction for the next local-mode turn (Phase 3). The
   * runner validates that the session is idle and has history; on success the
   * next submitted message continues from a compacted summary.
   */
  async requestManualCompaction(sessionId: string): Promise<{ success: boolean; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.requestManualCompaction) {
      console.error('requestManualCompaction API not available');
      return { success: false, error: 'Manual compaction API not available' };
    }
    const result = await cowork.requestManualCompaction(sessionId);
    if (!result) {
      return { success: false, error: 'Unknown error while requesting manual compaction' };
    }
    return result;
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

  /**
   * Stops a running subagent/background task via the live SDK Query control.
   * Returns true when the stop request was accepted (the SDK emits a
   * task_notification with status 'stopped' afterwards).
   */
  async stopTask(sessionId: string, taskId: string): Promise<{ success: boolean; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.stopTask) {
      return { success: false, error: 'stopTask API not available' };
    }
    try {
      return await cowork.stopTask(sessionId, taskId);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Backgrounds a running foreground task via the live SDK Query control.
   * Pass toolUseId to target one task; omit it to background all foreground
   * tasks. Returns true when the request was accepted.
   */
  async backgroundTask(sessionId: string, toolUseId?: string): Promise<{ success: boolean; backgrounded?: boolean; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.backgroundTask) {
      return { success: false, error: 'backgroundTask API not available' };
    }
    try {
      return await cowork.backgroundTask(sessionId, toolUseId);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
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

  /**
   * Forks the session from a message into a new session. On success, loads the
   * forked session as the current one.
   */
  async forkSession(sessionId: string, messageId: string, title?: string): Promise<CoworkSession | null> {
    const cowork = window.electron?.cowork;
    if (!cowork?.forkSession) {
      console.error('forkSession API not available');
      return null;
    }
    const result = await cowork.forkSession(sessionId, messageId, title);
    if (result.success && result.session) {
      store.dispatch(addSession(result.session));
      store.dispatch(setCurrentSession(result.session));
      return result.session;
    }
    console.error('Failed to fork session:', result.error);
    return null;
  }

  /**
   * Rewinds the session to a message (deletes everything after it). On success,
   * reloads the truncated session as the current one.
   */
  async rewindSession(sessionId: string, messageId: string): Promise<CoworkSession | null> {
    const cowork = window.electron?.cowork;
    if (!cowork?.rewindSession) {
      console.error('rewindSession API not available');
      return null;
    }
    const result = await cowork.rewindSession(sessionId, messageId);
    if (result.success && result.session) {
      store.dispatch(addSession(result.session));
      store.dispatch(setCurrentSession(result.session));
      return result.session;
    }
    console.error('Failed to rewind session:', result.error);
    return null;
  }

  /** Lists subagent transcript ids for a session (post-hoc, from disk). */
  async getSubagents(sessionId: string): Promise<string[]> {
    const cowork = window.electron?.cowork;
    if (!cowork?.getSubagents) return [];
    const result = await cowork.getSubagents(sessionId);
    return result.success ? result.agents ?? [] : [];
  }

  /** Reads and flattens a subagent's transcript into CoworkMessages. */
  async getSubagentMessages(sessionId: string, agentId: string, limit?: number): Promise<CoworkMessage[]> {
    const cowork = window.electron?.cowork;
    if (!cowork?.getSubagentMessages) return [];
    const result = await cowork.getSubagentMessages(sessionId, agentId, limit);
    return result.success ? result.messages ?? [] : [];
  }

  async getAutoApproveTools(sessionId: string): Promise<string[]> {
    const cowork = window.electron?.cowork;
    if (!cowork?.getAutoApproveTools) return [];
    const result = await cowork.getAutoApproveTools(sessionId);
    return result.success ? result.tools ?? [] : [];
  }

  async addAutoApproveTool(sessionId: string, toolName: string): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.addAutoApproveTool) return false;
    const result = await cowork.addAutoApproveTool(sessionId, toolName);
    return result.success;
  }

  async removeAutoApproveTool(sessionId: string, toolName: string): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.removeAutoApproveTool) return false;
    const result = await cowork.removeAutoApproveTool(sessionId, toolName);
    return result.success;
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

  async loadEarlierMessages(sessionId: string): Promise<number> {
    const cowork = window.electron?.cowork;
    if (!cowork?.getSessionMessagesPage) return 0;
    const currentSession = store.getState().cowork.currentSession;
    const history = currentSession?.id === sessionId ? currentSession.messageHistory : null;
    if (!history?.hasMoreBefore || history.beforeSequence == null) return 0;

    const result = await cowork.getSessionMessagesPage({
      sessionId,
      beforeSequence: history.beforeSequence,
      limit: history.pageSize,
    });
    if (!result.success || !result.page) {
      console.error('Failed to load earlier session messages:', result.error);
      return 0;
    }
    if (store.getState().cowork.currentSessionId !== sessionId) return 0;
    store.dispatch(prependMessages({
      sessionId,
      messages: result.page.messages,
      messageHistory: {
        hasMoreBefore: result.page.hasMoreBefore,
        beforeSequence: result.page.beforeSequence,
        pageSize: history.pageSize,
      },
    }));
    return result.page.messages.length;
  }

  async setMessageFeedback(input: { messageId: string; rating: MessageFeedbackRating | null; comment?: string | null }): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.setMessageFeedback) return false;

    const result = await cowork.setMessageFeedback(input);
    if (!result.success) {
      console.error('Failed to set message feedback:', result.error);
      return false;
    }
    if (result.feedback) {
      store.dispatch(setMessageFeedbackAction({
        messageId: result.feedback.messageId,
        rating: result.feedback.rating,
        comment: result.feedback.comment ?? undefined,
      }));
    } else {
      store.dispatch(clearMessageFeedbackAction(input.messageId));
    }
    return true;
  }

  async loadSessionFeedback(sessionId: string): Promise<void> {
    const cowork = window.electron?.cowork;
    if (!cowork?.listSessionFeedback) return;

    const result = await cowork.listSessionFeedback({ sessionId });
    if (!result.success || !result.feedback) {
      console.error('Failed to load session feedback:', result.error);
      return;
    }
    store.dispatch(loadSessionFeedbackAction(result.feedback.map((record) => ({
      messageId: record.messageId,
      rating: record.rating,
      comment: record.comment ?? undefined,
    }))));
  }

  async getA2AConversationHistoryPage(input: {
    sessionId: string;
    beforeCursor?: CoworkA2AHistoryCursor | null;
    limit?: number;
  }): Promise<CoworkA2AHistoryPage | null> {
    const cowork = window.electron?.cowork;
    if (!cowork?.getA2AConversationHistoryPage) return null;
    const result = await cowork.getA2AConversationHistoryPage(input);
    if (!result.success || !result.page) {
      console.error('Failed to load A2A conversation history:', result.error);
      return null;
    }
    return result.page;
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
    scopeKind?: 'owner' | 'contact' | 'conversation';
    scopeKey?: string;
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
    scopeKind?: 'owner' | 'contact' | 'conversation';
    scopeKey?: string;
    usageClass?: 'profile_fact' | 'preference' | 'operational_preference' | 'work_review' | 'value_boundary';
    visibility?: 'local_only' | 'external_safe';
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
    scopeKind?: 'owner' | 'contact' | 'conversation';
    scopeKey?: string;
    usageClass?: 'profile_fact' | 'preference' | 'operational_preference' | 'work_review' | 'value_boundary';
    visibility?: 'local_only' | 'external_safe';
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

  async getMemoryStats(input?: {
    sessionId?: string;
    metabotId?: number;
    scopeKind?: 'owner' | 'contact' | 'conversation';
    scopeKey?: string;
  }): Promise<CoworkMemoryStats | null> {
    const api = window.electron?.cowork?.getMemoryStats;
    if (!api) return null;
    const result = await api(input);
    if (!result?.success || !result.stats) return null;
    return result.stats;
  }

  async listMemoryScopes(input: { metabotId?: number }): Promise<CoworkMemoryScopesOverview | null> {
    const api = window.electron?.cowork?.listMemoryScopes;
    if (!api) return null;
    const result = await api(input);
    if (!result?.success || !result.overview) return null;
    return result.overview;
  }

  async getSessionMemoryScope(input: { sessionId?: string }): Promise<CoworkSessionMemoryScope | null> {
    const api = window.electron?.cowork?.getSessionMemoryScope;
    if (!api) return null;
    const result = await api(input);
    if (!result?.success || !result.sessionScope) return null;
    return result.sessionScope;
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

  async listMetaIDContacts(input: { observerGlobalMetaId: string }): Promise<CoworkMetaIDContactSummary[]> {
    const api = window.electron?.p2p?.listContacts;
    if (!api) return [];
    const result = await api(input);
    if (!result?.success || !Array.isArray(result.contacts)) return [];
    return result.contacts;
  }

  async getMetaIDContactDetail(input: {
    observerGlobalMetaId: string;
    subjectGlobalMetaId: string;
  }): Promise<CoworkMetaIDContactDetail | null> {
    const api = window.electron?.p2p?.getContactDetail;
    if (!api) return null;
    const result = await api(input);
    if (!result?.success || !result.detail) return null;
    return result.detail;
  }

  /** List knowledge-point anchored memories for a MetaBot (Settings → Memory → Knowledge). */
  async listKnowledge(input: {
    metabotId: number;
    kind?: CoworkKnowledgeKind;
    status?: CoworkKnowledgeStatus | 'all';
    query?: string;
    limit?: number;
    offset?: number;
  }): Promise<CoworkKnowledgeEntry[]> {
    const api = window.electron?.cowork?.listKnowledge;
    if (!api) return [];
    const result = await api(input);
    if (!result?.success || !Array.isArray(result.entries)) return [];
    return result.entries;
  }

  /** Archive a knowledge point (soft-delete: hidden from active recall). */
  async archiveKnowledge(input: { id: string; metabotId: number }): Promise<boolean> {
    const api = window.electron?.cowork?.archiveKnowledge;
    if (!api) return false;
    const result = await api(input);
    return Boolean(result?.success);
  }

  /** Edit a knowledge point in place (prior text is kept as a revision). */
  async updateKnowledge(input: {
    id: string;
    metabotId: number;
    topic?: string;
    summary?: string;
    kind?: CoworkKnowledgeKind;
  }): Promise<CoworkKnowledgeEntry | null> {
    const api = window.electron?.cowork?.updateKnowledge;
    if (!api) return null;
    const result = await api(input);
    if (!result?.success || !result.entry) return null;
    return result.entry;
  }

  /** Hard-delete a knowledge point and its sources/revisions. */
  async deleteKnowledge(input: { id: string; metabotId: number }): Promise<boolean> {
    const api = window.electron?.cowork?.deleteKnowledge;
    if (!api) return false;
    const result = await api(input);
    return Boolean(result?.success && result.deleted);
  }

  /** Drop a per-MetaBot memory policy override so it follows the global default. */
  async deleteMemoryPolicy(metabotId: number): Promise<boolean> {
    const api = window.electron?.cowork?.deleteMemoryPolicy;
    if (!api) return false;
    const result = await api({ metabotId });
    return Boolean(result?.success);
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
