import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type {
  CoworkSession,
  CoworkSessionSummary,
  CoworkMessage,
  CoworkMessageHistoryState,
  CoworkMessageMetadata,
  CoworkConfig,
  CoworkPermissionRequest,
  CoworkPermissionMode,
  CoworkSessionStatus,
  SubagentTaskState,
  SubagentTaskStatus,
} from '../../types/cowork';

interface CoworkState {
  sessions: CoworkSessionSummary[];
  currentSessionId: string | null;
  currentSession: CoworkSession | null;
  /** When set (e.g. after restore from mnemonic), CoworkView should select this MetaBot and clear it. */
  preferredMetabotId: number | null;
  /** MetaBot selected on the New Task home page; persisted globally so the single-instance page keeps its state across navigation. */
  newTaskMetabotId: number | null;
  draftPrompt: string;
  /**
   * Composer drafts keyed by session id (the steer input of each session
   * detail view). Kept in the store so switching sessions restores the text
   * the user typed in every session's input instead of wiping it.
   */
  sessionDrafts: Record<string, { value: string; attachments: Array<{ path: string; name: string }> }>;
  unreadSessionIds: string[];
  isCoworkActive: boolean;
  isStreaming: boolean;
  pendingPermissions: CoworkPermissionRequest[];
  config: CoworkConfig;
  /** Live subagent/background-task state keyed by task_id (drives SubagentPanel). */
  subagentTasks: Record<string, SubagentTaskState>;
  /** Whether the subagent panel is open. */
  isSubagentPanelOpen: boolean;
}

const initialState: CoworkState = {
  sessions: [],
  currentSessionId: null,
  currentSession: null,
  preferredMetabotId: null,
  newTaskMetabotId: null,
  draftPrompt: '',
  sessionDrafts: {},
  unreadSessionIds: [],
  isCoworkActive: false,
  isStreaming: false,
  pendingPermissions: [],
  subagentTasks: {},
  isSubagentPanelOpen: false,
  config: {
    workingDirectory: '',
    systemPrompt: '',
    executionMode: 'local',
    memoryEnabled: true,
    memoryImplicitUpdateEnabled: true,
    memoryLlmJudgeEnabled: true,
    memoryGuardLevel: 'strict',
    memoryUserMemoriesMaxItems: 12,
  },
};

const markSessionRead = (state: CoworkState, sessionId: string | null) => {
  if (!sessionId) return;
  state.unreadSessionIds = state.unreadSessionIds.filter((id) => id !== sessionId);
};

const markSessionUnread = (state: CoworkState, sessionId: string) => {
  if (state.currentSessionId === sessionId) return;
  if (state.unreadSessionIds.includes(sessionId)) return;
  state.unreadSessionIds.push(sessionId);
};

const coworkSlice = createSlice({
  name: 'cowork',
  initialState,
  reducers: {
    setCoworkActive(state, action: PayloadAction<boolean>) {
      state.isCoworkActive = action.payload;
    },

    setSessions(state, action: PayloadAction<CoworkSessionSummary[]>) {
      state.sessions = action.payload;
      const validSessionIds = new Set(action.payload.map((session) => session.id));
      state.unreadSessionIds = state.unreadSessionIds.filter((id) => {
        return validSessionIds.has(id) && id !== state.currentSessionId;
      });
    },

    setCurrentSessionId(state, action: PayloadAction<string | null>) {
      state.currentSessionId = action.payload;
      markSessionRead(state, action.payload);
    },

    setCurrentSession(state, action: PayloadAction<CoworkSession | null>) {
      let nextSession = action.payload;
      if (
        nextSession
        && nextSession.messageHistory
        && state.currentSession?.id === nextSession.id
        && state.currentSession.messageHistory
      ) {
        const incomingById = new Map(nextSession.messages.map((message) => [message.id, message]));
        const existingIds = new Set(state.currentSession.messages.map((message) => message.id));
        nextSession = {
          ...nextSession,
          messages: [
            ...state.currentSession.messages.map((message) => incomingById.get(message.id) ?? message),
            ...nextSession.messages.filter((message) => !existingIds.has(message.id)),
          ],
          messageHistory: state.currentSession.messageHistory,
        };
      }
      state.currentSession = nextSession;
      if (nextSession) {
        state.currentSessionId = nextSession.id;
        if (!nextSession.id.startsWith('temp-')) {
          const {
            id,
            title,
            status,
            pinned,
            createdAt,
            updatedAt,
            sessionType,
            peerName,
            serviceOrderSummary,
          } = nextSession;
          const summary: CoworkSessionSummary = {
            id,
            title,
            status,
            pinned: pinned ?? false,
            createdAt,
            updatedAt,
            sessionType,
            peerName,
            serviceOrderSummary: serviceOrderSummary ?? null,
          };
          const sessionIndex = state.sessions.findIndex((session) => session.id === id);
          if (sessionIndex !== -1) {
            state.sessions[sessionIndex] = {
              ...state.sessions[sessionIndex],
              ...summary,
            };
          } else {
            state.sessions.unshift(summary);
          }
        }
        markSessionRead(state, nextSession.id);
      }
    },

    setDraftPrompt(state, action: PayloadAction<string>) {
      state.draftPrompt = action.payload;
    },

    /**
     * Persist one session's composer draft (text + attachments). Empty drafts
     * are dropped so idle sessions do not accumulate entries.
     */
    setSessionDraft(state, action: PayloadAction<{ sessionId: string; value: string; attachments: Array<{ path: string; name: string }> }>) {
      const { sessionId, value, attachments } = action.payload;
      if (!sessionId) return;
      if (!value && attachments.length === 0) {
        delete state.sessionDrafts[sessionId];
        return;
      }
      state.sessionDrafts[sessionId] = { value, attachments };
    },

    setNewTaskMetabotId(state, action: PayloadAction<number | null>) {
      state.newTaskMetabotId = action.payload;
    },

    addSession(state, action: PayloadAction<CoworkSession>) {
      const summary: CoworkSessionSummary = {
        id: action.payload.id,
        title: action.payload.title,
        status: action.payload.status,
        pinned: action.payload.pinned ?? false,
        createdAt: action.payload.createdAt,
        updatedAt: action.payload.updatedAt,
        sessionType: action.payload.sessionType,
        peerName: action.payload.peerName,
        peerAvatar: action.payload.peerAvatar,
        metabotId: action.payload.metabotId,
        metabotName: action.payload.metabotName,
        metabotAvatar: action.payload.metabotAvatar,
        serviceOrderSummary: action.payload.serviceOrderSummary ?? null,
      };
      state.sessions.unshift(summary);
      state.currentSession = action.payload;
      state.currentSessionId = action.payload.id;
      markSessionRead(state, action.payload.id);
    },

    // Register a background session (e.g. IM-created) without switching currentSession
    registerBackgroundSession(state, action: PayloadAction<CoworkSessionSummary>) {
      const exists = state.sessions.some(s => s.id === action.payload.id);
      if (!exists) {
        state.sessions.unshift(action.payload);
      }
    },

    updateSessionStatus(state, action: PayloadAction<{ sessionId: string; status: CoworkSessionStatus }>) {
      const { sessionId, status } = action.payload;

      // Update in sessions list
      const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        state.sessions[sessionIndex].status = status;
        state.sessions[sessionIndex].updatedAt = Date.now();
      }

      // Update current session if applicable
      if (state.currentSession?.id === sessionId) {
        state.currentSession.status = status;
        state.currentSession.updatedAt = Date.now();
        // Streaming state is tied to the currently opened session only
        state.isStreaming = status === 'running';
      }
    },

    deleteSession(state, action: PayloadAction<string>) {
      const sessionId = action.payload;
      state.sessions = state.sessions.filter(s => s.id !== sessionId);
      state.unreadSessionIds = state.unreadSessionIds.filter((id) => id !== sessionId);
      // A deleted session can never be reopened, so its composer draft is gone too.
      delete state.sessionDrafts[sessionId];

      if (state.currentSessionId === sessionId) {
        state.currentSessionId = null;
        state.currentSession = null;
      }
    },

    addMessage(state, action: PayloadAction<{ sessionId: string; message: CoworkMessage }>) {
      const { sessionId, message } = action.payload;

      if (state.currentSession?.id === sessionId) {
        const exists = state.currentSession.messages.some((item) => item.id === message.id);
        if (!exists) {
          state.currentSession.messages.push(message);
          state.currentSession.updatedAt = message.timestamp;
        }
      }

      // Update session in list
      const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        state.sessions[sessionIndex].updatedAt = message.timestamp;
      }

      markSessionUnread(state, sessionId);
    },

    prependMessages(state, action: PayloadAction<{
      sessionId: string;
      messages: CoworkMessage[];
      messageHistory: CoworkMessageHistoryState;
    }>) {
      const { sessionId, messages, messageHistory } = action.payload;
      if (state.currentSession?.id !== sessionId) return;
      const existingIds = new Set(state.currentSession.messages.map((message) => message.id));
      const uniqueEarlierMessages = messages.filter((message) => !existingIds.has(message.id));
      state.currentSession.messages = [
        ...uniqueEarlierMessages,
        ...state.currentSession.messages,
      ];
      state.currentSession.messageHistory = messageHistory;
    },

    updateMessageContent(state, action: PayloadAction<{ sessionId: string; messageId: string; content?: string; metadata?: CoworkMessageMetadata }>) {
      const { sessionId, messageId, content, metadata } = action.payload;

      if (state.currentSession?.id === sessionId) {
        const messageIndex = state.currentSession.messages.findIndex(m => m.id === messageId);
        if (messageIndex !== -1) {
          if (content !== undefined) {
            state.currentSession.messages[messageIndex].content = content;
          }
          if (metadata !== undefined) {
            state.currentSession.messages[messageIndex].metadata = metadata;
          }
        }
      }

      markSessionUnread(state, sessionId);
    },

    setStreaming(state, action: PayloadAction<boolean>) {
      state.isStreaming = action.payload;
    },

    updateSessionPinned(state, action: PayloadAction<{ sessionId: string; pinned: boolean }>) {
      const { sessionId, pinned } = action.payload;
      const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        state.sessions[sessionIndex].pinned = pinned;
      }
      if (state.currentSession?.id === sessionId) {
        state.currentSession.pinned = pinned;
      }
    },

    updateSessionTitle(state, action: PayloadAction<{ sessionId: string; title: string }>) {
      const { sessionId, title } = action.payload;
      const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        state.sessions[sessionIndex].title = title;
        state.sessions[sessionIndex].updatedAt = Date.now();
      }
      if (state.currentSession?.id === sessionId) {
        state.currentSession.title = title;
        state.currentSession.updatedAt = Date.now();
      }
    },

    updateSessionPermissionMode(state, action: PayloadAction<{ sessionId: string; permissionMode: CoworkPermissionMode }>) {
      const { sessionId, permissionMode } = action.payload;
      // currentSession is the full CoworkSession; the sessions list holds
      // summaries without permissionMode, so only patch the active session.
      if (state.currentSession?.id === sessionId) {
        state.currentSession.permissionMode = permissionMode;
      }
    },

    /**
     * Upsert a subagent task row from a SDK task or tool_progress event.
     * Later events (progress, notification) merge into the existing row.
     */
    upsertSubagentTask(state, action: PayloadAction<SubagentTaskState>) {
      const task = action.payload;
      const existing = state.subagentTasks[task.taskId];
      state.subagentTasks[task.taskId] = existing
        ? { ...existing, ...task }
        : task;
    },

    /**
     * Replace the task set for one session (background_tasks_changed REPLACE
     * semantics). Tasks for other sessions are kept; existing detail for the
     * same task_id is preserved since the payload is ids-only (no status).
     */
    setSubagentTasks(state, action: PayloadAction<{ sessionId: string; tasks: Array<Partial<SubagentTaskState> & { taskId: string }> }>) {
      const { sessionId, tasks } = action.payload;
      const next: Record<string, SubagentTaskState> = {};
      for (const [key, existing] of Object.entries(state.subagentTasks)) {
        if (existing.sessionId !== sessionId) {
          next[key] = existing;
        }
      }
      for (const task of tasks) {
        next[task.taskId] = {
          ...(state.subagentTasks[task.taskId] ?? { status: 'running' as SubagentTaskStatus }),
          ...task,
          sessionId,
        };
      }
      state.subagentTasks = next;
    },

    setSubagentPanelOpen(state, action: PayloadAction<boolean>) {
      state.isSubagentPanelOpen = action.payload;
    },

    enqueuePendingPermission(state, action: PayloadAction<CoworkPermissionRequest>) {
      const alreadyQueued = state.pendingPermissions.some(
        (permission) => permission.requestId === action.payload.requestId
      );
      if (alreadyQueued) return;
      state.pendingPermissions.push(action.payload);
    },

    dequeuePendingPermission(state, action: PayloadAction<{ requestId?: string } | undefined>) {
      const requestId = action.payload?.requestId;
      if (!requestId) {
        state.pendingPermissions.shift();
        return;
      }
      state.pendingPermissions = state.pendingPermissions.filter(
        (permission) => permission.requestId !== requestId
      );
    },

    clearPendingPermissions(state) {
      state.pendingPermissions = [];
    },

    setConfig(state, action: PayloadAction<CoworkConfig>) {
      state.config = action.payload;
    },

    updateConfig(state, action: PayloadAction<Partial<CoworkConfig>>) {
      state.config = { ...state.config, ...action.payload };
    },

    clearCurrentSession(state) {
      state.currentSessionId = null;
      state.currentSession = null;
      state.isStreaming = false;
      // Tasks belong to a session; leaving the session clears its task view
      // (background_tasks_changed REPLACE will repopulate on the next signal).
      state.subagentTasks = {};
      state.isSubagentPanelOpen = false;
    },

    setPreferredMetabotId(state, action: PayloadAction<number | null>) {
      state.preferredMetabotId = action.payload;
    },

    clearPreferredMetabotId(state) {
      state.preferredMetabotId = null;
    },
  },
});

export const {
  setCoworkActive,
  setSessions,
  setCurrentSessionId,
  setCurrentSession,
  setDraftPrompt,
  setSessionDraft,
  setNewTaskMetabotId,
  addSession,
  registerBackgroundSession,
  updateSessionStatus,
  deleteSession,
  addMessage,
  prependMessages,
  updateMessageContent,
  setStreaming,
  updateSessionPinned,
  updateSessionTitle,
  updateSessionPermissionMode,
  upsertSubagentTask,
  setSubagentTasks,
  setSubagentPanelOpen,
  enqueuePendingPermission,
  dequeuePendingPermission,
  clearPendingPermissions,
  setConfig,
  updateConfig,
  clearCurrentSession,
  setPreferredMetabotId,
  clearPreferredMetabotId,
} = coworkSlice.actions;

export default coworkSlice.reducer;
