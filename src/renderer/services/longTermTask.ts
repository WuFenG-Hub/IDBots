import { store } from '../store';
import {
  setBoard,
  setBridgeMissing,
  setError,
  setLastSeq,
  setLoading,
  upsertDetail,
} from '../store/slices/longTermTaskSlice';
import type {
  LongTermSubtaskDraft,
  LongTermSubtaskUpdateInput,
  LongTermTaskUpdateInput,
} from '../types/longTermTask';

const FALLBACK_POLL_MS = 30_000;

/**
 * Long-term task board (redesign) — renderer service layer: IPC → Redux, no
 * derivation. Mirrors the trackedTask service shape.
 *
 * Push: `longtermTask:update` frames carry a monotonic seq; stale frames are
 * dropped. A 30s poll backstops a missed push.
 */
class LongTermTaskService {
  private cleanupFns: (() => void)[] = [];
  private initialized = false;
  private lastPushAtMs = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const api = this.api();
    if (!api) {
      store.dispatch(
        setBridgeMissing(
          'window.electron.longtermTask is missing on this build: the renderer has no read path to the long-term task store.',
        ),
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
    return window.electron?.longtermTask ?? null;
  }

  private setupListeners(api: NonNullable<Window['electron']['longtermTask']>): void {
    if (typeof api.onUpdate !== 'function') return;
    const cleanup = api.onUpdate((data) => {
      if (typeof data?.seq === 'number') {
        const last = store.getState().longTermTask.lastSeq;
        if (data.seq <= last) return;
        store.dispatch(setLastSeq(data.seq));
      }
      this.lastPushAtMs = Date.now();
      void this.loadBoard();
      const openTaskId = store.getState().longTermTask.selectedTaskId;
      const taskIds = Array.isArray(data?.taskIds) ? data.taskIds : [];
      if (openTaskId && (taskIds.length === 0 || taskIds.includes(openTaskId))) {
        void this.loadTask(openTaskId);
      }
    });
    this.cleanupFns.push(cleanup);
  }

  private startFallbackPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      if (Date.now() - this.lastPushAtMs < FALLBACK_POLL_MS) return;
      void this.loadBoard();
    }, FALLBACK_POLL_MS);
  }

  async loadBoard(): Promise<void> {
    const api = this.api();
    if (!api) return;
    store.dispatch(setLoading(true));
    try {
      const result = await api.board();
      if (result?.success && result.board) {
        store.dispatch(setBoard(result.board));
      } else {
        store.dispatch(setError(result?.error ?? 'Failed to read the long-term task board'));
      }
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
    }
  }

  async loadTask(taskId: string): Promise<void> {
    const api = this.api();
    if (!api) return;
    try {
      const result = await api.get({ taskId });
      if (result?.success && result.detail) {
        store.dispatch(upsertDetail(result.detail));
      } else if (result?.error) {
        store.dispatch(setError(result.error));
      }
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
    }
  }

  // ── owner actions (actor='owner' on the main side) ──────────────────────

  private async runAction(taskId: string, action: () => Promise<{ ok: boolean; error?: string }>): Promise<{ error: string | null }> {
    const api = this.api();
    if (!api) return { error: 'window.electron.longtermTask is missing on this build.' };
    try {
      const result = await action();
      if (!result?.ok) return { error: result?.error ?? 'Action refused' };
      void this.loadBoard();
      void this.loadTask(taskId);
      return { error: null };
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  async updateTask(input: LongTermTaskUpdateInput) {
    return this.runAction(input.taskId, () => this.api()!.update(input));
  }

  async setStage(input: { taskId: string; action: 'pause' | 'resume' | 'cancel'; note?: string }) {
    return this.runAction(input.taskId, () => this.api()!.setStage(input));
  }

  async subtaskAdd(taskId: string, draft: LongTermSubtaskDraft) {
    return this.runAction(taskId, () => this.api()!.subtaskAdd({ taskId, ...draft }));
  }

  async subtaskUpdate(taskId: string, input: LongTermSubtaskUpdateInput) {
    return this.runAction(taskId, () => this.api()!.subtaskUpdate(input));
  }

  async beginSubtask(taskId: string, subtaskId: string) {
    return this.runAction(taskId, () => this.api()!.begin({ subtaskId }));
  }

  async acceptSubtask(taskId: string, subtaskId: string, note?: string) {
    return this.runAction(taskId, () => this.api()!.accept({ subtaskId, note }));
  }

  async rejectSubtask(taskId: string, subtaskId: string, feedback: string) {
    return this.runAction(taskId, () => this.api()!.reject({ subtaskId, feedback }));
  }

  async unblockSubtask(taskId: string, subtaskId: string, note?: string) {
    return this.runAction(taskId, () => this.api()!.unblock({ subtaskId, note }));
  }

  async addNote(taskId: string, text: string, subtaskId?: string) {
    return this.runAction(taskId, () => this.api()!.note({ taskId, subtaskId, text }));
  }
}

export const longTermTaskService = new LongTermTaskService();
