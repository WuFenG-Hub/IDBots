// 调度类型
export interface ScheduleAt {
  type: 'at';
  datetime: string; // ISO 8601
}

export interface ScheduleInterval {
  type: 'interval';
  intervalMs: number;
  unit: 'minutes' | 'hours' | 'days';
  value: number;
}

export interface ScheduleCron {
  type: 'cron';
  expression: string; // 5段 CRON 表达式
}

export type Schedule = ScheduleAt | ScheduleInterval | ScheduleCron;

// 任务状态
export type TaskLastStatus = 'success' | 'error' | 'running' | null;

export interface TaskState {
  nextRunAtMs: number | null;
  lastRunAtMs: number | null;
  lastStatus: TaskLastStatus;
  lastError: string | null;
  lastDurationMs: number | null;
  runningAtMs: number | null;
  consecutiveErrors: number;
}

// IM 通知平台类型
export type NotifyPlatform = 'dingtalk' | 'feishu' | 'telegram' | 'discord';

// 定时任务
export interface ScheduledTask {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  schedule: Schedule;
  prompt: string;
  workingDirectory: string;
  systemPrompt: string;
  executionMode: 'auto' | 'local' | 'sandbox';
  metabotId: number | null;
  coworkSessionId: string | null;
  /** R2：null = 未参与迁移；'migrated' = 已迁移为 SDK durable cron（原任务已禁用）。 */
  migrationStatus: 'pending' | 'migrated' | 'not_supported' | 'skipped_disabled' | null;
  /** R2：迁移后对应的 SDK cron id（幂等键）。 */
  migratedTaskId: string | null;
  expiresAt: string | null; // ISO 8601 日期（精确到天），null 表示不过期
  notifyPlatforms: NotifyPlatform[]; // 任务完成后通知的 IM 平台
  state: TaskState;
  createdAt: string;
  updatedAt: string;
}

// 运行记录
export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  sessionId: string | null;
  status: 'running' | 'success' | 'error';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  trigger: 'scheduled' | 'manual';
}

// 带任务名称的运行记录（用于全局历史列表）
export interface ScheduledTaskRunWithName extends ScheduledTaskRun {
  taskName: string;
}

// 表单输入
export interface ScheduledTaskInput {
  name: string;
  description: string;
  schedule: Schedule;
  prompt: string;
  workingDirectory: string;
  systemPrompt: string;
  executionMode: 'auto' | 'local' | 'sandbox';
  metabotId?: number | null;
  expiresAt: string | null; // ISO 8601 日期（精确到天），null 表示不过期
  notifyPlatforms: NotifyPlatform[]; // 任务完成后通知的 IM 平台
  enabled: boolean;
}

// IPC 事件
export interface ScheduledTaskStatusEvent {
  taskId: string;
  state: TaskState;
}

export interface ScheduledTaskRunEvent {
  run: ScheduledTaskRun;
}

// UI 视图模式
export type ScheduledTaskViewMode = 'list' | 'create' | 'edit' | 'detail';

// ==================== SDK 定时任务镜像（方案 C R1/R2） ====================

/** SDK cron 在宿主侧的展示镜像（只展示不调度）。 */
export interface SdkCronMirror {
  id: string;
  sessionId: string;
  /** 从 prompt 提取的展示名。 */
  name: string;
  /** 5 字段 cron 表达式。 */
  schedule: string;
  /** 人类可读调度描述，可能为空。 */
  humanSchedule: string | null;
  recurring: boolean;
  durable: boolean;
  prompt: string;
  source: 'stop_hook' | 'file_scan' | 'migration';
  /** R2 迁移映射：原 scheduled_tasks.id。 */
  migratedTaskId: string | null;
  status: 'active' | 'deletion_requested' | 'deleted';
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
  /** IPC 增强字段：所属会话标题/是否活跃。 */
  sessionTitle?: string | null;
  sessionActive?: boolean;
}

/** R2 迁移计划项（IPC scheduledTask:migratePlan 返回）。 */
export interface MigrationPlanItem {
  task: ScheduledTask;
  spec?: {
    taskId: string;
    cronExpression: string;
    prompt: string;
    recurring: boolean;
    sevenDayLimited: boolean;
    nextFireMs: number | null;
    promptTruncated: boolean;
  } | null;
  reason?: string | null;
  skipped?: boolean;
}
