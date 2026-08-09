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

  /** 管理操作轮询参数：间隔 2s，最长 60s。 */
  private static readonly POLL_INTERVAL_MS = 2000;
  private static readonly POLL_TIMEOUT_MS = 60_000;

  /**
   * 提交后轮询：管理会话 fire-and-forget，结果经对账异步写回镜像。
   * 每 POLL_INTERVAL_MS 刷新一次镜像，直到 predicate 命中或超时。
   * @returns true=命中（操作成功可见）；false=超时（仍在后台执行，可稍后刷新）。
   */
  private async pollSdkMirrors(
    predicate: (mirrors: import('../types/scheduledTask').SdkCronMirror[]) => boolean,
    timeoutMs: number = ScheduledTaskService.POLL_TIMEOUT_MS
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.loadSdkMirrors();
      const mirrors = store.getState().scheduledTask.sdkMirrors;
      if (predicate(mirrors)) return true;
      await new Promise((resolve) => setTimeout(resolve, ScheduledTaskService.POLL_INTERVAL_MS));
    }
    return false;
  }

  /** 管理桥：UI 删除 SDK cron → 启动管理会话执行 CronDelete，轮询确认镜像消失。 */
  async requestDeleteSdkCron(
    cronId: string
  ): Promise<{ status?: string; hint?: string; done?: boolean; timedOut?: boolean } | null> {
    const mirrorApi = window.electron?.scheduledTasks?.sdkCronMirror;
    if (!mirrorApi) return null;
    try {
      const result = await mirrorApi.requestDelete(cronId);
      if (!result.success) throw new Error(result.error || 'Failed to request cron delete');
      const done = await this.pollSdkMirrors(
        (mirrors) => !mirrors.some((m) => m.id === cronId)
      );
      return {
        status: result.status,
        hint: result.hint,
        done,
        timedOut: !done,
      };
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }

  /**
   * 管理桥：UI 新建/编辑 SDK cron → 启动管理会话执行 CronCreate(durable=true)。
   * 轮询直到带 [SDK_CRON:<nonce>] 的新镜像出现（创建成功）或超时。
   */
  async createSdkCron(
    spec: import('../types/scheduledTask').SdkCronScheduleSpec,
    replacesId?: string | null
  ): Promise<{ sessionId?: string; nonce?: string; done?: boolean; timedOut?: boolean } | null> {
    const mirrorApi = window.electron?.scheduledTasks?.sdkCronMirror;
    if (!mirrorApi?.create) return null;
    try {
      const result = await mirrorApi.create({ spec, replacesId: replacesId ?? null });
      if (!result.success) throw new Error(result.error || 'Failed to create sdk cron');
      const nonce = result.nonce as string | undefined;
      const marker = nonce ? `[SDK_CRON:${nonce}]` : null;
      let done = true;
      if (marker) {
        done = await this.pollSdkMirrors(
          (mirrors) => mirrors.some((m) => m.prompt?.includes(marker))
        );
      }
      return { sessionId: result.sessionId, nonce, done, timedOut: !done };
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }

  /**
   * 管理桥：开关（删→重建）。
   * - enable=false：镜像立即置 enabled=0（同步），SDK 侧删除后台执行，无需轮询确认；
   * - enable=true：用 spec 重建，轮询直到带 nonce 的新镜像出现。
   */
  async toggleSdkCron(
    cronId: string,
    enabled: boolean
  ): Promise<{ status?: string; hint?: string; done?: boolean; timedOut?: boolean } | null> {
    const mirrorApi = window.electron?.scheduledTasks?.sdkCronMirror;
    if (!mirrorApi?.toggle) return null;
    try {
      const result = await mirrorApi.toggle(cronId, enabled);
      if (!result.success) throw new Error(result.error || 'Failed to toggle sdk cron');
      let done = true;
      if (enabled) {
        const nonce = result.nonce as string | undefined;
        const marker = nonce ? `[SDK_CRON:${nonce}]` : null;
        if (marker) {
          done = await this.pollSdkMirrors(
            (mirrors) => mirrors.some((m) => m.prompt?.includes(marker))
          );
        }
      }
      return {
        status: result.status,
        hint: result.hint,
        done,
        timedOut: !done,
      };
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }

  /** 管理桥：立即运行——当场执行该 cron 的 prompt（注入活跃会话或启动一次性会话）。 */
  async runNowSdkCron(cronId: string): Promise<{ injected?: boolean; sessionId?: string } | null> {
    const mirrorApi = window.electron?.scheduledTasks?.sdkCronMirror;
    if (!mirrorApi?.runNow) return null;
    try {
      const result = await mirrorApi.runNow(cronId);
      if (result.success) {
        return { injected: result.injected, sessionId: result.sessionId };
      }
      throw new Error(result.error || 'Failed to run sdk cron now');
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
