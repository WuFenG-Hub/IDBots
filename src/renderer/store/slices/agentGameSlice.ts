/**
 * Agent-Game-v2 consent card queue (renderer). Mirrors the cowork permission
 * queue pattern: the service subscribes to agentGame:consentRequired and
 * enqueues; App reads the queue head and renders the consent card.
 */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { AgentGameConsentCardInfo } from '../../types/agentGame';

interface AgentGameState {
  pendingConsents: AgentGameConsentCardInfo[];
}

const initialState: AgentGameState = {
  pendingConsents: [],
};

const agentGameSlice = createSlice({
  name: 'agentGame',
  initialState,
  reducers: {
    enqueuePendingConsent(state, action: PayloadAction<AgentGameConsentCardInfo>) {
      // Dedup by requestId so a re-hydration never double-shows a card.
      if (state.pendingConsents.some((c) => c.requestId === action.payload.requestId)) return;
      state.pendingConsents.push(action.payload);
    },
    dequeuePendingConsent(state, action: PayloadAction<{ requestId: string }>) {
      state.pendingConsents = state.pendingConsents.filter((c) => c.requestId !== action.payload.requestId);
    },
    clearPendingConsents(state) {
      state.pendingConsents = [];
    },
  },
});

export const { enqueuePendingConsent, dequeuePendingConsent, clearPendingConsents } = agentGameSlice.actions;
export default agentGameSlice.reducer;
