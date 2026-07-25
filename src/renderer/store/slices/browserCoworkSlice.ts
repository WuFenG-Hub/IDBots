import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type {
  CoworkMessage,
  CoworkMessageMetadata,
  CoworkSession,
  CoworkSessionStatus,
} from '../../types/cowork';

/**
 * State for the Bot Browser side-panel Co-Work surface.
 *
 * Deliberately separate from the main cowork slice: the browser panel and the
 * main CoworkView can each have a different session open at the same time.
 * Stream events are dual-dispatched from services/cowork.ts; every reducer
 * here no-ops when the event's sessionId does not match the panel's open
 * session, mirroring the guard pattern in coworkSlice.
 */
interface BrowserCoworkState {
  currentSession: CoworkSession | null;
  isStreaming: boolean;
}

const initialState: BrowserCoworkState = {
  currentSession: null,
  isStreaming: false,
};

const browserCoworkSlice = createSlice({
  name: 'browserCowork',
  initialState,
  reducers: {
    setBrowserSession(state, action: PayloadAction<CoworkSession | null>) {
      state.currentSession = action.payload;
      state.isStreaming = action.payload?.status === 'running';
    },

    addBrowserMessage(state, action: PayloadAction<{ sessionId: string; message: CoworkMessage }>) {
      const { sessionId, message } = action.payload;
      if (state.currentSession?.id !== sessionId) return;
      const exists = state.currentSession.messages.some((item) => item.id === message.id);
      if (!exists) {
        state.currentSession.messages.push(message);
        state.currentSession.updatedAt = message.timestamp;
      }
    },

    updateBrowserMessageContent(
      state,
      action: PayloadAction<{ sessionId: string; messageId: string; content?: string; metadata?: CoworkMessageMetadata }>
    ) {
      const { sessionId, messageId, content, metadata } = action.payload;
      if (state.currentSession?.id !== sessionId) return;
      const messageIndex = state.currentSession.messages.findIndex((m) => m.id === messageId);
      if (messageIndex === -1) return;
      if (content !== undefined) {
        state.currentSession.messages[messageIndex].content = content;
      }
      if (metadata !== undefined) {
        state.currentSession.messages[messageIndex].metadata = metadata;
      }
    },

    updateBrowserSessionStatus(state, action: PayloadAction<{ sessionId: string; status: CoworkSessionStatus }>) {
      const { sessionId, status } = action.payload;
      if (state.currentSession?.id !== sessionId) return;
      state.currentSession.status = status;
      state.currentSession.updatedAt = Date.now();
      state.isStreaming = status === 'running';
    },

    setBrowserStreaming(state, action: PayloadAction<boolean>) {
      state.isStreaming = action.payload;
    },

    clearBrowserSession(state) {
      state.currentSession = null;
      state.isStreaming = false;
    },
  },
});

export const {
  setBrowserSession,
  addBrowserMessage,
  updateBrowserMessageContent,
  updateBrowserSessionStatus,
  setBrowserStreaming,
  clearBrowserSession,
} = browserCoworkSlice.actions;

export default browserCoworkSlice.reducer;
