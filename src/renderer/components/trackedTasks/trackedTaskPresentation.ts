import { i18nService } from '../../services/i18n';
import {
  TRACKED_SESSION_ROLE_LABEL_KEYS,
  TRACKED_SOURCE_KIND_LABEL_KEYS,
} from '../../types/trackedTask';
import type { TrackedCardSessionRole, TrackedCardSourceKind, TrackedCardState } from '../../types/trackedTask';

/**
 * 卡面呈现层的共用映射。列名 i18n key 由主进程给出（TrackedCardSummary.stateLabelKey），
 * 这里只负责「key → 文案」，不维护第二份列定义。
 */
export const TRACKED_COLUMN_FALLBACK_LABEL_KEY: Record<TrackedCardState, string> = {
  waiting_decision: 'trackedTask.column.waitingDecision',
  in_progress: 'trackedTask.column.inProgress',
  blocked_external: 'trackedTask.column.blockedExternal',
  closed: 'trackedTask.column.closed',
};

/** 卡面态 chip 的视觉分级：四态互斥、颜色不重复，扫一眼就能分辨所在列。 */
export const STATE_CHIP_CLASS: Record<TrackedCardState, string> = {
  waiting_decision: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  in_progress: 'border-blue-500/40 bg-blue-500/10 text-blue-500',
  blocked_external:
    'border-slate-400/40 bg-slate-400/10 dark:text-claude-darkTextSecondary text-claude-textSecondary',
  closed: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500',
};

/** 看板列头左侧的竖条色，与 chip 同源，避免出现两套色板。 */
export const STATE_ACCENT_BAR_CLASS: Record<TrackedCardState, string> = {
  waiting_decision: 'bg-amber-500',
  in_progress: 'bg-blue-500',
  blocked_external: 'bg-slate-400',
  closed: 'bg-emerald-500',
};

export function columnLabel(labelKey: string, state: TrackedCardState): string {
  return i18nService.t(labelKey || TRACKED_COLUMN_FALLBACK_LABEL_KEY[state]);
}

export function sessionRoleLabel(role: TrackedCardSessionRole | string): string {
  const key = TRACKED_SESSION_ROLE_LABEL_KEYS[role as TrackedCardSessionRole];
  return key ? i18nService.t(key) : role;
}

export function sourceKindLabel(kind: TrackedCardSourceKind | string): string {
  const key = TRACKED_SOURCE_KIND_LABEL_KEYS[kind as TrackedCardSourceKind];
  return key ? i18nService.t(key) : kind;
}

/** epoch ms → 本地短格式；null / 非法值显示短横线，不臆造时间。 */
export function formatEpochShort(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** ISO 字符串 → 本地短格式。 */
export function formatIsoShort(value: string | null | undefined): string {
  if (!value) return '—';
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? formatEpochShort(ms) : '—';
}

/**
 * 闲置时长 → 「N.Nd」；null（未知活动）显示短横线。
 * 后端 §3 已用严格大于判定预警/僵尸，这里只做显示，不参与判定。
 */
export function formatIdleDays(idleMs: number | null | undefined): string {
  if (typeof idleMs !== 'number' || !Number.isFinite(idleMs)) return '—';
  return `${(idleMs / 86_400_000).toFixed(1)}d`;
}
