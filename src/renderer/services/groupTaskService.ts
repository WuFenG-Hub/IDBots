import { store } from '../store';
import { i18nService } from './i18n';
import {
  setLoading,
  setError,
  setTasks,
  upsertTask,
  updateTaskStatus,
} from '../store/slices/groupTasksSlice';
import type {
  GroupTaskCreateInput,
  GroupTaskDetail,
  GroupTaskOwnerReportDeliveryEvent,
  GroupTaskStatus,
  GroupTaskStatusEvent,
  GroupTaskSummary,
  GroupChatTranscriptMessage,
} from '../types/groupTask';

/**
 * Renderer-side Group Task service: wraps the window.electron.groupTask IPC
 * surface and keeps the groupTasks slice in sync (same shape as
 * services/scheduledTask.ts). Detail-view data (members, deliverables,
 * transcript) is fetched on demand and kept in component-local state.
 */
class GroupTaskService {
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
    const api = window.electron?.groupTask;
    if (!api) return;

    const cleanup = api.onStatusChanged((event: GroupTaskStatusEvent) => {
      store.dispatch(
        updateTaskStatus({
          taskId: event.taskId,
          status: event.status as GroupTaskStatus,
        })
      );
    });
    this.cleanupFns.push(cleanup);

    const cleanupOwnerReport = api.onOwnerReportDelivery((event: GroupTaskOwnerReportDeliveryEvent) => {
      const isCheckpoint = event.kind === 'checkpoint';
      let message: string;
      if (event.outcome === 'failed') {
        message = i18nService
          .t(isCheckpoint ? 'groupTasksCheckpointReportFailed' : 'groupTasksOwnerReportFailed')
          .replace('{error}', event.error?.trim() || i18nService.t('groupTasksOwnerReportUnknownError'));
      } else if (event.displayError) {
        message = i18nService
          .t(isCheckpoint ? 'groupTasksCheckpointReportDisplayFailed' : 'groupTasksOwnerReportDisplayFailed')
          .replace('{error}', event.displayError);
      } else {
        message = i18nService.t(isCheckpoint ? 'groupTasksCheckpointReportSent' : 'groupTasksOwnerReportSent');
      }
      window.dispatchEvent(new CustomEvent<string>('app:showToast', { detail: message }));
    });
    this.cleanupFns.push(cleanupOwnerReport);
  }

  async loadTasks(status?: GroupTaskStatus): Promise<void> {
    const api = window.electron?.groupTask;
    if (!api) return;

    store.dispatch(setLoading(true));
    try {
      const result = await api.list(status ? { status } : undefined);
      if (result.success && result.tasks) {
        store.dispatch(setTasks(result.tasks));
      } else {
        store.dispatch(setError(result.error ?? 'Failed to load group tasks'));
      }
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
    }
  }

  /** Throws on failure so the caller (modal) can show the API error inline. */
  async createTask(input: GroupTaskCreateInput): Promise<GroupTaskDetail> {
    const api = window.electron?.groupTask;
    if (!api) throw new Error('Group task API unavailable');

    const result = await api.create(input);
    if (!result.success || !result.task) {
      throw new Error(result.error ?? 'Failed to create group task');
    }
    const detail = result.task as GroupTaskDetail;
    store.dispatch(upsertTask(this.toSummary(detail)));
    return detail;
  }

  async getTask(taskId: number): Promise<GroupTaskDetail> {
    const api = window.electron?.groupTask;
    if (!api) throw new Error('Group task API unavailable');

    const result = await api.get(taskId);
    if (!result.success || !result.task) {
      throw new Error(result.error ?? 'Failed to load group task');
    }
    return result.task as GroupTaskDetail;
  }

  /** P0-5: move a REVIEW task back to EXECUTING (rework hatch). */
  async reworkTask(input: { taskId: number; reason?: string }): Promise<GroupTaskDetail> {
    const api = window.electron?.groupTask;
    if (!api) throw new Error('Group task API unavailable');

    const result = await api.rework(input);
    if (!result.success || !result.task) {
      throw new Error(result.error ?? 'Failed to rework group task');
    }
    const task = result.task as GroupTaskDetail;
    store.dispatch(upsertTask(this.toSummary(task)));
    return task;
  }

  async closeTask(input: { taskId: number; status: 'done' | 'cancelled'; reason?: string; rating?: number; ratingComment?: string }): Promise<GroupTaskDetail> {
    const api = window.electron?.groupTask;
    if (!api) throw new Error('Group task API unavailable');

    const result = await api.close(input);
    if (!result.success || !result.task) {
      throw new Error(result.error ?? 'Failed to close group task');
    }
    const task = result.task as GroupTaskDetail;
    store.dispatch(upsertTask(this.toSummary(task)));
    return task;
  }

  /** P0-1: pull a review task back to executing (Back to work / 返回修改). */
  async reopenTask(taskId: number): Promise<GroupTaskDetail> {
    const api = window.electron?.groupTask;
    if (!api) throw new Error('Group task API unavailable');

    const result = await api.reopen({ taskId });
    if (!result.success || !result.task) {
      throw new Error(result.error ?? 'Failed to reopen group task');
    }
    const task = result.task as GroupTaskDetail;
    store.dispatch(upsertTask(this.toSummary(task)));
    return task;
  }

  /**
   * Throws on failure so the caller (modal) can show the API error inline.
   * Resolves with the kicked member row, including chainRemovalConfirmed
   * (R2P1-2: false = the on-chain removal could not be confirmed yet).
   */
  async kickMember(input: {
    taskId: number;
    metabotId?: number;
    globalmetaid?: string;
    reason?: string;
  }): Promise<{ chainRemovalConfirmed?: boolean }> {
    const api = window.electron?.groupTask;
    if (!api) throw new Error('Group task API unavailable');

    const result = await api.kickMember(input);
    if (!result.success) {
      throw new Error(result.error ?? 'Failed to remove the member');
    }
    return (result.member ?? {}) as { chainRemovalConfirmed?: boolean };
  }

  async listMessages(
    taskId: number,
    opts?: { beforeId?: number; limit?: number },
  ): Promise<GroupChatTranscriptMessage[]> {
    const api = window.electron?.groupTask;
    if (!api) throw new Error('Group task API unavailable');

    const result = await api.listMessages({ taskId, ...opts });
    if (!result.success) {
      throw new Error(result.error ?? 'Failed to load messages');
    }
    return (result.messages ?? []) as GroupChatTranscriptMessage[];
  }

  /** Throws on failure so the composer can show the error inline. */
  async sendUserMessage(taskId: number, content: string): Promise<string> {
    const api = window.electron?.groupTask;
    if (!api) throw new Error('Group task API unavailable');

    const result = await api.sendUserMessage({ taskId, content });
    if (!result.success || !result.pinId) {
      throw new Error(result.error ?? 'Failed to send message');
    }
    return result.pinId as string;
  }

  private toSummary(task: GroupTaskDetail): GroupTaskSummary {
    const members = task.members ?? [];
    return {
      ...task,
      memberCount: members.length,
      chairName: members.find((member) => member.role === 'chair')?.name ?? null,
      memberNames: members.map((member) => member.name).filter((name): name is string => Boolean(name)),
    };
  }
}

export const groupTaskService = new GroupTaskService();
