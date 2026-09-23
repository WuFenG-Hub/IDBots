import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { LongTermBoard, LongTermTaskDetail } from '../../types/longTermTask';

/**
 * Long-term task board (redesign) — renderer state.
 *
 * The store of record is the main-process LongTermTaskStore (long_term_*
 * tables); this slice only caches its projections plus pure UI state (open
 * task, last seen push seq). Column/progress/current-subtask always come from
 * the backend — the renderer never re-derives them.
 */
interface LongTermTaskState {
  /** Read path availability (window.electron.longtermTask present). */
  available: boolean;
  bridgeMissingReason: string | null;
  board: LongTermBoard | null;
  /** Detail cache by task id. */
  details: Record<string, LongTermTaskDetail>;
  loading: boolean;
  error: string | null;
  /** Currently open task (pure UI state, never persisted). */
  selectedTaskId: string | null;
  /** Monotonic push seq — frames arriving out of order are dropped. */
  lastSeq: number;
}

const initialState: LongTermTaskState = {
  available: false,
  bridgeMissingReason: null,
  board: null,
  details: {},
  loading: false,
  error: null,
  selectedTaskId: null,
  lastSeq: 0,
};

const longTermTaskSlice = createSlice({
  name: 'longTermTask',
  initialState,
  reducers: {
    setBridgeMissing(state, action: PayloadAction<string>) {
      state.available = false;
      state.bridgeMissingReason = action.payload;
      state.loading = false;
      state.board = null;
    },
    setLoading(state, action: PayloadAction<boolean>) {
      state.loading = action.payload;
    },
    setError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
      state.loading = false;
    },
    setBoard(state, action: PayloadAction<LongTermBoard>) {
      state.available = true;
      state.bridgeMissingReason = null;
      state.board = action.payload;
      state.loading = false;
    },
    upsertDetail(state, action: PayloadAction<LongTermTaskDetail>) {
      state.details[action.payload.id] = action.payload;
    },
    dropDetail(state, action: PayloadAction<string>) {
      delete state.details[action.payload];
    },
    selectTask(state, action: PayloadAction<string | null>) {
      state.selectedTaskId = action.payload;
    },
    setLastSeq(state, action: PayloadAction<number>) {
      state.lastSeq = action.payload;
    },
  },
});

export const {
  setBridgeMissing,
  setLoading,
  setError,
  setBoard,
  upsertDetail,
  dropDetail,
  selectTask,
  setLastSeq,
} = longTermTaskSlice.actions;

export default longTermTaskSlice.reducer;
