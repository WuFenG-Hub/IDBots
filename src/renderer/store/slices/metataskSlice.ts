import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { MetaTaskBoard, MetaTaskTaskProjection } from '../../types/metatask';

/**
 * MetaTask tab (P1 read path) — renderer state.
 *
 * The store of record is the chain itself, replayed by the main-process
 * engine into a rebuildable projection cache; this slice only caches what IPC
 * returns plus pure UI state (open task, last seen push seq). The renderer
 * never re-derives node states or settlement math.
 */
interface MetaTaskState {
  /** Read path availability (window.electron.metatask present). */
  available: boolean;
  bridgeMissingReason: string | null;
  board: MetaTaskBoard | null;
  /** Detail cache by task root pinId. */
  details: Record<string, MetaTaskTaskProjection>;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  /** Inner view: 任务广场 / 我的参与. */
  view: 'square' | 'mine';
  /** Currently open task root (pure UI state, never persisted). */
  selectedRootPinId: string | null;
  /** Monotonic push seq — frames arriving out of order are dropped. */
  lastSeq: number;
}

const initialState: MetaTaskState = {
  available: false,
  bridgeMissingReason: null,
  board: null,
  details: {},
  loading: false,
  refreshing: false,
  error: null,
  view: 'square',
  selectedRootPinId: null,
  lastSeq: 0,
};

const metataskSlice = createSlice({
  name: 'metatask',
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
    setRefreshing(state, action: PayloadAction<boolean>) {
      state.refreshing = action.payload;
    },
    setError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
      state.loading = false;
    },
    setBoard(state, action: PayloadAction<MetaTaskBoard>) {
      state.available = true;
      state.bridgeMissingReason = null;
      state.board = action.payload;
      state.loading = false;
    },
    upsertDetail(state, action: PayloadAction<MetaTaskTaskProjection>) {
      state.details[action.payload.rootPinId] = action.payload;
    },
    setView(state, action: PayloadAction<'square' | 'mine'>) {
      state.view = action.payload;
    },
    selectTask(state, action: PayloadAction<string | null>) {
      state.selectedRootPinId = action.payload;
    },
    setLastSeq(state, action: PayloadAction<number>) {
      state.lastSeq = action.payload;
    },
  },
});

export const {
  setBridgeMissing,
  setLoading,
  setRefreshing,
  setError,
  setBoard,
  upsertDetail,
  setView,
  selectTask,
  setLastSeq,
} = metataskSlice.actions;

export default metataskSlice.reducer;
