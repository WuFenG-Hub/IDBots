import { store } from '../store';
import {
  setBridgeMissing,
  setLoading,
  setError,
  setBoard,
  upsertDetail,
  mergeCardSummary,
} from '../store/slices/trackedTaskSlice';
import type {
  TrackedCardClosureInput,
  TrackedCardClosureReceipt,
  TrackedCardListInput,
} from '../types/trackedTask';

const FALLBACK_POLL_MS = 30_000;

export interface TrackedCloseOutcome {
  error: string | null;
  receipt: TrackedCardClosureReceipt | null;
}

/**
 * 长期任务看板的前端服务层 —— 只做「调 IPC + 落 Redux」，不做任何推导。
 *
 * 读路径：`window.electron.trackedTask`，由主进程按契约 v1.4 [SEC-05] 实现
 * （`src/main/services/trackedTaskBoard.ts`）。卡面状态 / 排序权重 / closureDue 级别
 * 一律取自后端投影，前端不重算。
 *
 * 写路径：只调 `close`，由主进程做 F1 两段写（永远写收口四列；仅当白名单含目标状态才动 status）。
 *
 * 事件：`onUpdate({ seq, taskIds, reason })` —— `seq` 进程内单调，丢弃过期帧，
 * 只增量重取 `taskIds`；漏推时 30s 轮询兜底。
 */
class TrackedTaskService {
  private cleanupFns: (() => void)[] = [];
  private initialized = false;
  private lastSeenSeq = 0;
  private lastPushAtMs = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastScope: 'default' | 'all' = 'default';

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const api = this.api();
    if (!api) {
      store.dispatch(
        setBridgeMissing(
          'window.electron.trackedTask is missing on this build: the renderer has no read path to orchestration_tasks.'
        )
      );
      return;
    }

    this.setupListeners(api);
    this.startFallbackPolling();
    await this.loadBoard();
  }

  destroy(): void {
    this.cleanupFns.forEach((fn) => fn());
    this.cleanupFns = [];
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.initialized = false;
  }

  private api() {
    return window.electron?.trackedTask ?? null;
  }

  private setupListeners(api: NonNullable<Window['electron']['trackedTask']>): void {
    if (typeof api.onUpdate !== 'function') return;
    const cleanup = api.onUpdate((data) => {
      // seq 去重：迟到的帧直接丢弃（契约 [SEC-05] 事件去重口径）。
      if (typeof data?.seq === 'number') {
        if (data.seq <= this.lastSeenSeq) return;
        this.lastSeenSeq = data.seq;
      }
      this.lastPushAtMs = Date.now();

      void this.loadBoard();

      const openCardId = store.getState().trackedTask.selectedCardId;
      const taskIds = Array.isArray(data?.taskIds) ? data.taskIds : [];
      if (openCardId && (taskIds.length === 0 || taskIds.includes(openCardId))) {
        void this.loadCard(openCardId);
      }
    });
    this.cleanupFns.push(cleanup);
  }

  private startFallbackPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      // 只在「最近的推送已经过期」时兜底，避免 push 正常时重复重拉。
      if (Date.now() - this.lastPushAtMs < FALLBACK_POLL_MS) return;
      void this.loadBoard();
    }, FALLBACK_POLL_MS);
  }

  async loadBoard(input?: TrackedCardListInput): Promise<void> {
    const api = this.api();
    if (!api) {
      store.dispatch(
        setBridgeMissing(
          'window.electron.trackedTask is missing on this build: the renderer has no read path to orchestration_tasks.'
        )
      );
      return;
    }

    if (input?.scope) this.lastScope = input.scope;

    store.dispatch(setLoading(true));
    try {
      const result = await api.list({ scope: this.lastScope, ...input });
      if (result?.success && result.board) {
        if (typeof result.board.seq === 'number' && result.board.seq > this.lastSeenSeq) {
          this.lastSeenSeq = result.board.seq;
        }
        store.dispatch(setBoard(result.board));
      } else {
        store.dispatch(setError(result?.error ?? 'Failed to read the long-task board'));
      }
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
    }
  }

  async loadCard(cardId: string): Promise<void> {
    const api = this.api();
    if (!api) return;

    try {
      const result = await api.detail({ cardId });
      if (result?.success && result.detail) {
        store.dispatch(upsertDetail(result.detail));
      } else if (result?.error) {
        store.dispatch(setError(result.error));
      }
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
    }
  }

  /**
   * 收口并写一句结论（验收⑥：单入口，不做验收/拒绝二选一）。
   * 回执区分「状态已推进」（statusMoved=true）与「结论已记录、状态保留」。
   */
  async closeCard(input: TrackedCardClosureInput): Promise<TrackedCloseOutcome> {
    const api = this.api();
    if (!api) return { error: 'window.electron.trackedTask is missing on this build.', receipt: null };

    const conclusion = input.conclusion.trim();
    if (!conclusion) {
      return { error: 'A one-line closing conclusion is required.', receipt: null };
    }

    try {
      const result = await api.close({
        cardId: input.cardId,
        conclusion,
        by: input.by,
        targetStatus: input.targetStatus,
      });
      if (result?.ok) {
        if (result.card) {
          store.dispatch(mergeCardSummary(result.card));
        }
        void this.loadCard(input.cardId);
        // 收口会改 counts / columns / 页内基数：整块重取一次，别在前端拼统计。
        void this.loadBoard();
        return {
          error: null,
          receipt: {
            cardId: input.cardId,
            statusMoved: Boolean(result.statusMoved),
            statusNote: result.statusNote ?? '',
          },
        };
      }
      return { error: result?.error ?? 'Failed to close the card', receipt: null };
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err), receipt: null };
    }
  }
}

export const trackedTaskService = new TrackedTaskService();
