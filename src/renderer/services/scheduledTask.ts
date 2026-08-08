import { store } from '../store';
import {
  setLoading,
  setError,
  setTasks,
  addTask,
  updateTask,
  removeTask,
  updateTaskState,
  setRuns,
  addOrUpdateRun,
  setAllRuns,
  appendAllRuns,
  setSdkMirrors,
  setSdkMirrorsLoading,
} from '../store/slices/scheduledTaskSlice';
import type {
  ScheduledTaskInput,
  ScheduledTaskStatusEvent,
  ScheduledTaskRunEvent,
  MigrationPlanItem,
} from '../types/scheduledTask';

class ScheduledTaskService {
  private cleanupFns: (() => void)[] = [];
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    this.setupListeners();
    await this.loadTasks();
  }

  destroy(): void {
    this.cleanupFns.forEach((fn) => fn());
    this.cleanupFns = [];
    this.initialized = false;
  }

  private setupListeners(): void {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    const cleanupStatus = api.onStatusUpdate(
      (event: ScheduledTaskStatusEvent) => {
        store.dispatch(
          updateTaskState({
            taskId: event.taskId,
            taskState: event.state,
          })
        );
      }
    );
    this.cleanupFns.push(cleanupStatus);

    const cleanupRun = api.onRunUpdate(
      (event: ScheduledTaskRunEvent) => {
        store.dispatch(addOrUpdateRun(event.run));
      }
    );
    this.cleanupFns.push(cleanupRun);
  }

  async loadTasks(): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    store.dispatch(setLoading(true));
    try {
      const result = await api.list();
      if (result.success && result.tasks) {
        store.dispatch(setTasks(result.tasks));
      }
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
    }
  }

  async createTask(input: ScheduledTaskInput): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    try {
      const result = await api.create(input);
      if (result.success && result.task) {
        store.dispatch(addTask(result.task));
      } else {
        throw new Error(result.error || 'Failed to create task');
      }
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }

  async updateTaskById(
    id: string,
    input: Partial<ScheduledTaskInput>
  ): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    try {
      const result = await api.update(id, input);
      if (result.success && result.task) {
        store.dispatch(updateTask(result.task));
      }
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }

  async deleteTask(id: string): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    try {
      const result = await api.delete(id);
      if (result.success) {
        store.dispatch(removeTask(id));
      }
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }

  async toggleTask(id: string, enabled: boolean): Promise<string | null> {
    const api = window.electron?.scheduledTasks;
    if (!api) return null;

    try {
      const result = await api.toggle(id, enabled);
      if (result.success && result.task) {
        store.dispatch(updateTask(result.task));
      }
      return result.warning ?? null;
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }

  async runManually(id: string): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    try {
      await api.runManually(id);
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }

  async stopTask(id: string): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    try {
      await api.stop(id);
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }

  async loadRuns(taskId: string, limit?: number, offset?: number): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    try {
      const result = await api.listRuns(taskId, limit, offset);
      if (result.success && result.runs) {
        store.dispatch(setRuns({ taskId, runs: result.runs }));
      }
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
    }
  }

  async loadAllRuns(limit?: number, offset?: number): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    try {
      const result = await api.listAllRuns(limit, offset);
      if (result.success && result.runs) {
        if (offset && offset > 0) {
          store.dispatch(appendAllRuns(result.runs));
        } else {
          store.dispatch(setAllRuns(result.runs));
        }
      }
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
    }
  }

  // ==================== SDK 定时任务镜像（方案 C R1/R2） ====================

  async loadSdkMirrors(): Promise<void> {
    const api = window.electron?.scheduledTasks;
    const mirrorApi = api?.sdkCronMirror;
    if (!mirrorApi) return;

    store.dispatch(setSdkMirrorsLoading(true));
    try {
      const result = await mirrorApi.list();
      if (result.success && Array.isArray(result.mirrors)) {
        store.dispatch(setSdkMirrors(result.mirrors));
      }
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
      store.dispatch(setSdkMirrorsLoading(false));
    }
  }

  /** 管理桥：UI 删除/停用 SDK cron → 所属会话内 bot 执行 CronDelete。 */
  async requestDeleteSdkCron(cronId: string): Promise<{ status?: string; injected?: boolean; hint?: string } | null> {
    const mirrorApi = window.electron?.scheduledTasks?.sdkCronMirror;
    if (!mirrorApi) return null;
    try {
      const result = await mirrorApi.requestDelete(cronId);
      if (result.success) {
        // 刷新镜像（deletion_requested 状态立即可见）
        await this.loadSdkMirrors();
        return { status: result.status, injected: result.injected, hint: result.hint };
      }
      throw new Error(result.error || 'Failed to request cron delete');
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }

  /** R2：读取迁移计划（只读，展示用）。 */
  async loadMigrationPlan(): Promise<{ migratable: MigrationPlanItem[]; unsupported: MigrationPlanItem[]; sevenDayLimitedCount: number; truncatedCount: number } | null> {
    const api = window.electron?.scheduledTasks;
    if (!api?.migratePlan) return null;
    try {
      const result = await api.migratePlan();
      if (result.success && result.plan) {
        return {
          migratable: result.plan.migratable ?? [],
          unsupported: result.plan.unsupported ?? [],
          sevenDayLimitedCount: result.plan.sevenDayLimitedCount ?? 0,
          truncatedCount: result.plan.truncatedCount ?? 0,
        };
      }
      return null;
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
      return null;
    }
  }

  /** R2：执行迁移（需 UI 人工确认后调用）。 */
  async migrateToSdkCron(): Promise<{ migrated: number; skipped: number; unsupported: number; sessionId: string | null } | null> {
    const api = window.electron?.scheduledTasks;
    if (!api?.migrateExecute) return null;
    try {
      const result = await api.migrateExecute();
      if (result.success) {
        await this.loadTasks();
        await this.loadSdkMirrors();
        return { migrated: result.migrated ?? 0, skipped: result.skipped ?? 0, unsupported: result.unsupported ?? 0, sessionId: result.sessionId ?? null };
      }
      throw new Error(result.error || 'Failed to execute migration');
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }
}

export const scheduledTaskService = new ScheduledTaskService();
