import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type {
  TrackedCardBoard,
  TrackedCardClosureReceipt,
  TrackedCardDetail,
  TrackedCardScope,
  TrackedCardSummary,
  TrackedTaskViewMode,
  TrackingTabId,
} from '../../types/trackedTask';

/**
 * 长期任务看板的渲染层状态。
 *
 * 事实源永远是 orchestration_tasks（经 `trackedTask:*` 读路径投影）。
 * 本 slice 只缓存投影结果与纯 UI 态（当前 Tab / 视图 / 打开的卡），不落任何数据库表（验收①），
 * 也不自行推导卡面状态——`state / actionRank / needsOwnerAction` 一律用后端给的字段。
 */
interface TrackedTaskState {
  /** 读路径是否可用（`window.electron.trackedTask` 是否挂上）。 */
  available: boolean;
  bridgeMissingReason: string | null;
  board: TrackedCardBoard | null;
  /** 已按 id 缓存的卡详情（抽屉展开时按需拉取）。 */
  details: Record<string, TrackedCardDetail>;
  loading: boolean;
  error: string | null;
  /** 外层 Tab：长期任务默认在前。 */
  activeTab: TrackingTabId;
  /** 内层视图：看板 / 清单。 */
  viewMode: TrackedTaskViewMode;
  /** 当前打开的卡（纯 UI 态，规格 §4 明确不落库）。 */
  selectedCardId: string | null;
  /** 清单视图：只看需要我出手。 */
  onlyOwnerAction: boolean;
  /** 看板范围：default = 近期活动 ∪ 全部 closureDue；all = 不折叠（D3 显式筛选）。 */
  scope: TrackedCardScope;
  /** 最近一次收口回执（UI 区分「状态已推进」与「结论已记录、状态保留」）。 */
  receipt: TrackedCardClosureReceipt | null;
}

const initialState: TrackedTaskState = {
  available: false,
  bridgeMissingReason: null,
  board: null,
  details: {},
  loading: false,
  error: null,
  activeTab: 'longTerm',
  viewMode: 'board',
  selectedCardId: null,
  onlyOwnerAction: false,
  scope: 'default',
  receipt: null,
};

const trackedTaskSlice = createSlice({
  name: 'trackedTask',
  initialState,
  reducers: {
    setBridgeMissing(state, action: PayloadAction<string | null>) {
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
    setBoard(state, action: PayloadAction<TrackedCardBoard>) {
      state.available = true;
      state.bridgeMissingReason = null;
      state.board = action.payload;
      state.loading = false;
    },
    upsertDetail(state, action: PayloadAction<TrackedCardDetail>) {
      state.details[action.payload.id] = action.payload;
    },
    /** 收口成功后把后端回传的卡摘要并回看板，避免整表重拉。 */
    mergeCardSummary(state, action: PayloadAction<TrackedCardSummary>) {
      if (!state.board) return;
      const card = action.payload;
      const index = state.board.cards.findIndex((candidate) => candidate.id === card.id);
      if (index === -1) {
        state.board.cards.push(card);
      } else {
        state.board.cards[index] = card;
      }
      state.board.columns = state.board.columns.map((column) => ({
        ...column,
        cardIds: state.board!.cards.filter((c) => c.state === column.state).map((c) => c.id),
      }));
      state.board.closureDueCardIds = state.board.cards.filter((c) => c.closureDue).map((c) => c.id);
      state.board.closureDueCount = state.board.closureDueCardIds.length;
    },
    dropDetail(state, action: PayloadAction<string>) {
      delete state.details[action.payload];
    },
    setActiveTab(state, action: PayloadAction<TrackingTabId>) {
      state.activeTab = action.payload;
    },
    setViewMode(state, action: PayloadAction<TrackedTaskViewMode>) {
      state.viewMode = action.payload;
    },
    selectCard(state, action: PayloadAction<string | null>) {
      state.selectedCardId = action.payload;
    },
    setOnlyOwnerAction(state, action: PayloadAction<boolean>) {
      state.onlyOwnerAction = action.payload;
    },
    setScope(state, action: PayloadAction<TrackedCardScope>) {
      state.scope = action.payload;
    },
    setReceipt(state, action: PayloadAction<TrackedCardClosureReceipt | null>) {
      state.receipt = action.payload;
    },
  },
});

export const {
  setBridgeMissing,
  setLoading,
  setError,
  setBoard,
  upsertDetail,
  mergeCardSummary,
  dropDetail,
  setActiveTab,
  setViewMode,
  selectCard,
  setOnlyOwnerAction,
  setScope,
  setReceipt,
} = trackedTaskSlice.actions;

export default trackedTaskSlice.reducer;
