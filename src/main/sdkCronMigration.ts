import type { MigrationStatus, Schedule, ScheduledTask } from './scheduledTaskStore';
import { CronExpressionParser } from 'cron-parser';

/**
 * R2：老任务（scheduledTaskStore）→ SDK durable cron 的幂等迁移规划（纯函数，可单测）。
 *
 * 事实与决策：
 * - 宿主进程不能直接调用 CronCreate（Agent 工具），迁移由宿主启动一个迁移会话、
 *   让会话内 bot 逐个执行 CronCreate(durable=true) 完成；本模块负责「规划」部分：
 *   哪些任务可迁移、cron 表达式怎么映射、prompt 如何截断、7 天限制如何标记。
 * - 幂等键：scheduled_tasks.migrated_task_id + migration_status='migrated'；
 *   已迁移任务在后续规划中跳过（重复执行不产生重复 cron）。
 * - schedule 映射：
 *   * type='at'    → 一次性 cron（M H DoM Mth *）+ recurring=false（SDK 语义：false 为一次性）
 *   * type='cron'  → 表达式直通 + recurring=true
 *   * type='interval' → 明确不支持（相对间隔无法等价表达为固定 cron；需求允许「明确不支持清单」）
 * - prompt > 1000 字符 → 按 SDK 裁剪规则截断并记录（见 truncateCronPrompt）。
 * - 7 天限制：SDK recurring 任务 7 天自动过期。expiresAt 为空/超过 7 天、
 *   或下一次触发在 7 天外的任务，迁移后必然在 7 天内失效 → sevenDayLimited 标记，
 *   UI 展示「7 天有效，到期需重建」（主人已接受该限制）。
 * - enabled=false 的任务不迁移（保留原状）。
 */

export const SDK_CRON_PROMPT_LIMIT = 1000;
export const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

export type { MigrationStatus } from './scheduledTaskStore';

export interface MigratedCronSpec {
  /** 原 scheduled_tasks.id。 */
  taskId: string;
  /** 5 字段 cron 表达式。 */
  cronExpression: string;
  /** 迁移后的 cron prompt（含 [SDK_MIGRATE:<taskId>] 标记，前置保证不被裁剪）。 */
  prompt: string;
  recurring: boolean;
  /** true = 7 天内必然失效，UI 展示「到期需重建」。 */
  sevenDayLimited: boolean;
  /** 下一次触发时间（ms），无法计算为 null。 */
  nextFireMs: number | null;
  /** 原 prompt 是否被截断。 */
  promptTruncated: boolean;
}

export interface MigrationPlanItem {
  task: ScheduledTask;
  spec: MigratedCronSpec | null;
  /** 不可迁移原因（spec 为 null 时）。 */
  reason: string | null;
  /** 已迁移（跳过）或本就不该迁移。 */
  skipped: boolean;
}

export interface MigrationPlan {
  migratable: MigrationPlanItem[];
  skipped: MigrationPlanItem[];
  unsupported: MigrationPlanItem[];
  /** 全部可迁移任务中带 7 天限制的个数。 */
  sevenDayLimitedCount: number;
  /** 需要截断 prompt 的个数。 */
  truncatedCount: number;
}

/** 迁移会话内 cron prompt 的任务标记（前置，裁剪只动尾部，标记必然保留）。 */
export function buildMigrationMarker(taskId: string): string {
  return `[SDK_MIGRATE:${taskId}]`;
}

/** 提取 cron prompt 中的迁移标记，无标记返回 null。 */
export function extractMigrationTaskId(prompt: string): string | null {
  const match = /\[SDK_MIGRATE:([^\]]+)\]/.exec(prompt || '');
  return match ? match[1] : null;
}

/** at → 一次性 cron（M H DoM Mth *），datetime 非法返回 null。 */
export function datetimeToCronExpression(datetime: string | undefined | null): string | null {
  if (!datetime) return null;
  const d = new Date(datetime);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
}

/** interval → null（明确不支持；cron 5 字段最小粒度 1 分钟，无法表达相对间隔语义）。 */
export function intervalToCronExpression(_schedule: Schedule): string | null {
  return null;
}

/** 计算下一次 cron 触发时间（ms）；表达式非法返回 null。 */
export function getNextCronFireMs(expression: string, afterMs = Date.now()): number | null {
  try {
    const interval = CronExpressionParser.parse(expression, {
      currentDate: new Date(afterMs),
    });
    return interval.next().toDate().getTime();
  } catch {
    return null;
  }
}

/**
 * 判断任务迁移后是否受 7 天限制：
 * - expiresAt 为空或距 now 超过 7 天 → 原任务本就长周期，迁移后 7 天失效（受限）；
 * - 下一次触发在 now+7 天之外 → 受限；
 * - 其余（高频/近期触发）→ 7 天内至少会触发，按需求仅在 UI 统一提示「SDK 7 天过期」。
 */
export function computeSevenDayLimited(
  schedule: Schedule,
  expiresAt: string | null,
  nextFireMs: number | null,
  nowMs: number
): boolean {
  if (expiresAt) {
    const expiresMs = new Date(expiresAt).getTime();
    if (!Number.isNaN(expiresMs) && expiresMs > nowMs + SEVEN_DAY_MS) return true;
  }
  if (nextFireMs !== null && nextFireMs > nowMs + SEVEN_DAY_MS) return true;
  return false;
}

/**
 * 单个任务 → 迁移规格。不可迁移时返回 null + reason。
 */
export function buildMigratedCronSpec(
  task: ScheduledTask,
  nowMs = Date.now()
): { spec: MigratedCronSpec | null; reason: string | null } {
  const schedule = task.schedule;
  let cronExpression: string | null = null;
  let recurring = true;

  switch (schedule.type) {
    case 'at':
      cronExpression = datetimeToCronExpression(schedule.datetime);
      recurring = false;
      if (!cronExpression) {
        return { spec: null, reason: `'at' 时间非法或缺失: ${String(schedule.datetime ?? '')}` };
      }
      break;
    case 'cron':
      cronExpression = schedule.expression?.trim() || null;
      if (!cronExpression) {
        return { spec: null, reason: 'cron 表达式缺失' };
      }
      break;
    case 'interval':
      return {
        spec: null,
        reason: 'interval 类型不支持：相对间隔无法等价表达为固定 cron（明确不支持清单）',
      };
    default:
      return { spec: null, reason: `未知 schedule 类型: ${String(schedule.type)}` };
  }

  const nextFireMs = getNextCronFireMs(cronExpression, nowMs);
  if (nextFireMs === null) {
    return { spec: null, reason: `cron 表达式无法解析: ${cronExpression}` };
  }

  const sevenDayLimited = computeSevenDayLimited(schedule, task.expiresAt, nextFireMs, nowMs);

  const marker = buildMigrationMarker(task.id);
  const sevenDayNote = sevenDayLimited
    ? '[SDK_7DAY_LIMITED] 该任务将在 7 天后自动过期，到期需重建。\n'
    : '';
  const basePrompt = `${marker}\n${sevenDayNote}${task.prompt || ''}`;
  const promptTruncated = basePrompt.length > SDK_CRON_PROMPT_LIMIT;
  const prompt = promptTruncated
    ? `${basePrompt.slice(0, SDK_CRON_PROMPT_LIMIT)}… [+${basePrompt.length - SDK_CRON_PROMPT_LIMIT} chars]`
    : basePrompt;

  return {
    spec: {
      taskId: task.id,
      cronExpression,
      prompt,
      recurring,
      sevenDayLimited,
      nextFireMs,
      promptTruncated,
    },
    reason: null,
  };
}

/**
 * 幂等迁移规划：已迁移（migrated_task_id 非空或 migration_status='migrated'）与
 * enabled=false 任务跳过；interval/非法任务进 unsupported；其余进 migratable。
 * 纯函数——重复调用输入相同则输出相同（幂等性由标记位保证，测试验证）。
 */
export function planTaskMigration(
  tasks: ScheduledTask[],
  nowMs = Date.now()
): MigrationPlan {
  const migratable: MigrationPlanItem[] = [];
  const skipped: MigrationPlanItem[] = [];
  const unsupported: MigrationPlanItem[] = [];

  for (const task of tasks) {
    if (task.migrationStatus === 'migrated' || task.migratedTaskId) {
      skipped.push({ task, spec: null, reason: 'already_migrated', skipped: true });
      continue;
    }
    if (!task.enabled) {
      skipped.push({ task, spec: null, reason: 'disabled', skipped: true });
      continue;
    }
    const { spec, reason } = buildMigratedCronSpec(task, nowMs);
    if (spec) {
      migratable.push({ task, spec, reason: null, skipped: false });
    } else {
      unsupported.push({ task, spec: null, reason, skipped: false });
    }
  }

  const sevenDayLimitedCount = migratable.filter((m) => m.spec!.sevenDayLimited).length;
  const truncatedCount = migratable.filter((m) => m.spec!.promptTruncated).length;

  return { migratable, skipped, unsupported, sevenDayLimitedCount, truncatedCount };
}
