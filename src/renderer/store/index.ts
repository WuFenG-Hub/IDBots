import { configureStore } from '@reduxjs/toolkit';
import modelReducer from './slices/modelSlice';
import coworkReducer from './slices/coworkSlice';
import browserCoworkReducer from './slices/browserCoworkSlice';
import skillReducer from './slices/skillSlice';
import imReducer from './slices/imSlice';
import quickActionReducer from './slices/quickActionSlice';
import scheduledTaskReducer from './slices/scheduledTaskSlice';
import groupTasksReducer from './slices/groupTasksSlice';
import mcpReducer from './slices/mcpSlice';

export const store = configureStore({
  reducer: {
    model: modelReducer,
    cowork: coworkReducer,
    browserCowork: browserCoworkReducer,
    skill: skillReducer,
    im: imReducer,
    quickAction: quickActionReducer,
    scheduledTask: scheduledTaskReducer,
    groupTasks: groupTasksReducer,
    mcp: mcpReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch; 
