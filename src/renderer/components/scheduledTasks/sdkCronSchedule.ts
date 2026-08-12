import { i18nService } from '../../services/i18n';
import type { SdkCronMirror, SdkCronScheduleSpec } from '../../types/scheduledTask';
import {
  parseScheduleToFormState,
  type ScheduleFormState,
  type IntervalUnit,
  type ScheduleMode,
} from './taskFormSchedule';

/**
 * SDK cron 调度语义层——把「表单 spec」与「5 字段 cron 表达式」互相转换，并给出人类可读标签。
 *
 * 与旧版 TaskForm/taskFormSchedule 的区别：SDK 底层只认 5 字段 cron 表达式（recurring=true）
 * 或一次性 cron（recurring=false，到点触发一次即删）。因此：
 * - interval mode → 映射为 星号/N 分钟 / 每 N 小时 / 每 N 天 的 cron 表达式；
 * - once mode → 一次性 cron（M H DoM Month 星，recurring=false）；
 * - daily/weekly/monthly/cron mode → 与旧版完全一致。
 *
 * 语义标签与旧版 TaskList.formatScheduleLabel 对齐（不重复/每天 HH:MM/每周X HH:MM/每月N日/每 N 分钟）。
 */

const UNIT_TO_INTERVAL_CRON: Record<IntervalUnit, (value: number) => string> = {
  minutes: (value) => `*/${value} * * * *`,
  hours: (value) => `0 */${value} * * *`,
  days: (value) => `0 0 */${value} * *`,
};

export const WEEKDAY_KEYS: Record<number, string> = {
  0: 'scheduledTasksFormWeekSun',
  1: 'scheduledTasksFormWeekMon',
  2: 'scheduledTasksFormWeekTue',
  3: 'scheduledTasksFormWeekWed',
  4: 'scheduledTasksFormWeekThu',
  5: 'scheduledTasksFormWeekFri',
  6: 'scheduledTasksFormWeekSat',
};

export type { ScheduleMode, IntervalUnit, ScheduleFormState };

/**
 * spec → 5 字段 cron 表达式 + recurring 标记（SDK CronCreate 的两个核心参数）。
 * @returns 表达式非法时 expression 为 null（调用方应阻止提交）。
 */
export function specToSdkCron(spec: SdkCronScheduleSpec): { expression: string | null; recurring: boolean } {
  const [hourStr, minuteStr] = (spec.time || '09:00').split(':').map(Number);
  const hour = Number.isFinite(hourStr) ? hourStr : 9;
  const minute = Number.isFinite(minuteStr) ? minuteStr : 0;

  switch (spec.mode) {
    case 'once': {
      const dt = new Date(`${spec.date}T${spec.time || '09:00'}`);
      if (Number.isNaN(dt.getTime())) return { expression: null, recurring: false };
      // 一次性：M H DoM Month *（recurring=false，到点触发一次即删）。
      return {
        expression: `${dt.getMinutes()} ${dt.getHours()} ${dt.getDate()} ${dt.getMonth() + 1} *`,
        recurring: false,
      };
    }
    case 'interval': {
      const value = Math.max(1, Math.floor(spec.intervalValue || 1));
      const builder = UNIT_TO_INTERVAL_CRON[spec.intervalUnit] ?? UNIT_TO_INTERVAL_CRON.minutes;
      return { expression: builder(value), recurring: true };
    }
    case 'daily':
      return { expression: `${minute} ${hour} * * *`, recurring: true };
    case 'weekly':
      return { expression: `${minute} ${hour} * * ${spec.weekday}`, recurring: true };
    case 'monthly':
      return { expression: `${minute} ${hour} ${spec.monthDay} * *`, recurring: true };
    case 'cron': {
      const expr = (spec.cronExpression || '').trim();
      const parts = expr.split(/\s+/).filter(Boolean);
      return { expression: parts.length === 5 ? expr : null, recurring: true };
    }
    default:
      return { expression: null, recurring: true };
  }
}

/** 表单状态（旧版 TaskForm 用的同构形态）→ SdkCronScheduleSpec（含 name/prompt/metabotId）。 */
export function formStateToSpec(
  state: ScheduleFormState,
  meta: { name: string; prompt: string; metabotId: number | null }
): SdkCronScheduleSpec {
  return {
    mode: state.mode,
    date: state.date,
    time: state.time,
    weekday: state.weekday,
    monthDay: state.monthDay,
    intervalValue: state.intervalValue,
    intervalUnit: state.intervalUnit,
    cronExpression: state.cronExpression,
    name: meta.name,
    prompt: meta.prompt,
    metabotId: meta.metabotId,
  };
}

/**
 * 镜像 → 表单状态。优先用存档的 schedule_spec（有 spec 才可编辑/重建）；
 * 无 spec 时回退解析 mirror.schedule（5 字段 cron），用于只读展示语义。
 */
export function mirrorToFormState(mirror: SdkCronMirror): ScheduleFormState {
  const spec = mirror.scheduleSpec;
  if (spec) {
    return {
      mode: spec.mode,
      date: spec.date,
      time: spec.time,
      weekday: spec.weekday,
      monthDay: spec.monthDay,
      intervalValue: spec.intervalValue,
      intervalUnit: spec.intervalUnit,
      cronExpression: spec.cronExpression,
    };
  }
  // 无 spec：回退解析裸 cron 表达式（复用旧版解析逻辑，尽量还原 once/daily/weekly/monthly/interval）。
  return parseScheduleToFormState({ type: 'cron', expression: mirror.schedule });
}

function intervalLabel(value: number, unit: IntervalUnit): string {
  const unitKey =
    unit === 'minutes'
      ? 'scheduledTasksFormIntervalMinutes'
      : unit === 'hours'
        ? 'scheduledTasksFormIntervalHours'
        : 'scheduledTasksFormIntervalDays';
  return `${i18nService.t('scheduledTasksScheduleEvery')} ${value} ${i18nService.t(unitKey)}`;
}

/**
 * 镜像 → 人类可读调度标签。完全对标旧版 TaskList.formatScheduleLabel 的语义。
 * 有 spec 时直接用 spec（最准，正常情况 list IPC 已回填派生 spec）；
 * 无 spec 时统一走 mirrorToFormState 解析（已正确分类），不再自己重算裸字段——
 * 那会因 hour='*' / 多值分钟（如 7,22,37,52）产出「每天 · 0*:7,22,37,52」乱码。
 */
export function formatSdkCronScheduleLabel(mirror: SdkCronMirror): string {
  // SDK 自带的 humanSchedule 最准（若 SDK 提供），优先于一切。
  if (mirror.humanSchedule) return mirror.humanSchedule;

  const spec = mirror.scheduleSpec;
  const form = spec
    ? {
        mode: spec.mode,
        date: spec.date,
        time: spec.time,
        weekday: spec.weekday,
        monthDay: spec.monthDay,
        intervalValue: spec.intervalValue,
        intervalUnit: spec.intervalUnit,
        cronExpression: spec.cronExpression,
      }
    : mirrorToFormState(mirror);

  if (form.mode === 'interval') return intervalLabel(form.intervalValue, form.intervalUnit);
  if (form.mode === 'once') {
    const dtStr = form.date ? `${form.date}T${form.time || '09:00'}` : '';
    if (dtStr) {
      const date = new Date(dtStr);
      if (!Number.isNaN(date.getTime())) {
        return `${i18nService.t('scheduledTasksFormScheduleModeOnce')} · ${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      }
    }
    return i18nService.t('scheduledTasksFormScheduleModeOnce');
  }
  if (form.mode === 'daily') {
    return `${i18nService.t('scheduledTasksFormScheduleModeDaily')} · ${form.time || '09:00'}`;
  }
  if (form.mode === 'weekly') {
    return `${i18nService.t('scheduledTasksFormScheduleModeWeekly')} · ${i18nService.t(WEEKDAY_KEYS[form.weekday] ?? 'scheduledTasksFormWeekSun')} ${form.time || '09:00'}`;
  }
  if (form.mode === 'monthly') {
    return `${i18nService.t('scheduledTasksFormScheduleModeMonthly')} · ${form.monthDay}${i18nService.t('scheduledTasksFormMonthDaySuffix')} ${form.time || '09:00'}`;
  }
  // cron（含无法还原成具体语义的复杂表达式，如 7,22,37,52 * * * *）：显示「Cron · 原表达式」，清晰不造假。
  const cronLabel = i18nService.t('scheduledTasksFormScheduleModeCron');
  const expr = form.cronExpression || mirror.schedule || '';
  return expr ? `${cronLabel} · ${expr}` : cronLabel;
}

/** 默认表单状态（新建时），与旧版 TaskForm 默认值对齐（once / 09:00）。 */
export function defaultSdkCronFormState(): ScheduleFormState {
  return {
    mode: 'once',
    date: '',
    time: '09:00',
    weekday: 1,
    monthDay: 1,
    intervalValue: 5,
    intervalUnit: 'minutes',
    cronExpression: '',
  };
}
