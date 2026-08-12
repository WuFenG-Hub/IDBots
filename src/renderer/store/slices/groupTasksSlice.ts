import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { GroupTaskSummary } from '../../types/groupTask';

interface GroupTasksState {
  tasks: GroupTaskSummary[];
  selectedTaskId: number | null;
  loading: boolean;
  error: string | null;
}

const initialState: GroupTasksState = {
  tasks: [],
  selectedTaskId: null,
  loading: false,
  error: null,
};

const groupTasksSlice = createSlice({
  name: 'groupTasks',
  initialState,
  reducers: {
    setLoading(state, action: PayloadAction<boolean>) {
      state.loading = action.payload;
    },
    setError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setTasks(state, action: PayloadAction<GroupTaskSummary[]>) {
      state.tasks = action.payload;
      state.loading = false;
    },
    upsertTask(state, action: PayloadAction<GroupTaskSummary>) {
      const index = state.tasks.findIndex((t) => t.id === action.payload.id);
      if (index !== -1) {
        state.tasks[index] = action.payload;
      } else {
        state.tasks.unshift(action.payload);
      }
    },
    updateTaskStatus(
      state,
      action: PayloadAction<{ taskId: number; status: GroupTaskSummary['status'] }>
    ) {
      const task = state.tasks.find((t) => t.id === action.payload.taskId);
      if (task) {
        task.status = action.payload.status;
      }
    },
    updateTaskPinned(
      state,
      action: PayloadAction<{ taskId: number; pinned: boolean }>
    ) {
      const task = state.tasks.find((t) => t.id === action.payload.taskId);
      if (task) {
        task.pinned = action.payload.pinned;
      }
    },
    updateTaskDisplayName(
      state,
      action: PayloadAction<{ taskId: number; displayName: string | null }>
    ) {
      const task = state.tasks.find((t) => t.id === action.payload.taskId);
      if (task) {
        task.displayName = action.payload.displayName;
      }
    },
    removeTask(state, action: PayloadAction<number>) {
      state.tasks = state.tasks.filter((t) => t.id !== action.payload);
      if (state.selectedTaskId === action.payload) {
        state.selectedTaskId = null;
      }
    },
    selectTask(state, action: PayloadAction<number | null>) {
      state.selectedTaskId = action.payload;
    },
  },
});

export const {
  setLoading,
  setError,
  setTasks,
  upsertTask,
  updateTaskStatus,
  updateTaskPinned,
  updateTaskDisplayName,
  removeTask,
  selectTask,
} = groupTasksSlice.actions;

export default groupTasksSlice.reducer;
