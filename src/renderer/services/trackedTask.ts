import { store } from '../store';
import {
  setBridgeMissing,
  setLoading,
  setError,
  setBoard,
  upsertDetail,
  mergeCardSummary,
} from '../store/slices/trackedTaskSlice';
import type { TrackedCardClosureInput } from '../types/trackedTask';

/**
 * 长期任务看板的前端服务层 —— 只做「调 IPC + 落 Redux」，不做任何推导。
 *
 * 读路径：`window.electron.trackedTask`（单数），由主进程按架构规格 §1.1/§2.2/§4 实现
 * （见 src/main/services/trackedTaskBoard.ts 与 src/main/preload.ts 的 trackedTask 块）。
 * 卡面状态 / actionRank / needsOwnerAction 一律取自后端投影，前端不重算（§2.1 零漂移）。
 *
 * 写路径：收口只调 `close`，由主进程走
 * `orchestrationStore.updateTaskStatus + TASK_TRANSITIONS` 白名单并落 closure_* 四列。
 */
class TrackedTaskService {
  private cleanupFns: (() => void)[] = [];
  private initialized = false;

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
    await this.loadBoard();
  }

  destroy(): void {
    this.cleanupFns.forEach((fn) => fn());
    this.cleanupFns = [];
    this.initialized = false;
  }

  private api() {
    return window.electron?.trackedTask ?? null;
  }

  private setupListeners(api: NonNullable<Window['electron']['trackedTask']>): void {
    if (typeof api.onUpdate !== 'function') return;
    const cleanup = api.onUpdate((data) => {
      void this.loadBoard();
      const openCardId = store.getState().trackedTask.selectedCardId;
      if (data?.cardId && data.cardId === openCardId) {
        void this.loadCard(data.cardId);
      }
    });
    this.cleanupFns.push(cleanup);
  }

  async loadBoard(): Promise<void> {
    const api = this.api();
    if (!api) {
      store.dispatch(
        setBridgeMissing(
          'window.electron.trackedTask is missing on this build: the renderer has no read path to orchestration_tasks.'
        )
      );
      return;
    }

    store.dispatch(setLoading(true));
    try {
      // ownerGlobalMetaId 留空 = 读全部归属人的卡（本机单 owner 场景）。
      const result = await api.list();
      if (result?.success && result.board) {
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
   * 返回错误文案（已含主进程的 code 语义）；null 表示收口成功。
   */
  async closeCard(input: TrackedCardClosureInput): Promise<string | null> {
    const api = this.api();
    if (!api) return 'window.electron.trackedTask is missing on this build.';

    const conclusion = input.conclusion.trim();
    if (!conclusion) return 'A one-line closing conclusion is required.';

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
        return null;
      }
      return result?.error ?? 'Failed to close the card';
    } catch (err: unknown) {
      return err instanceof Error ? err.message : String(err);
    }
  }
}

export const trackedTaskService = new TrackedTaskService();
