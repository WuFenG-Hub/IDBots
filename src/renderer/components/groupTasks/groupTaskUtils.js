/**
 * Pure helpers for the Group Task UI (status filters, badges, transcript
 * handling). Plain JS (like sidebarNavigation.js) so it can be unit-tested
 * directly with node --test.
 */

export const ACTIVE_GROUP_TASK_STATUSES = ['planning', 'executing', 'review'];

export function isActiveGroupTaskStatus(status) {
  return ACTIVE_GROUP_TASK_STATUSES.includes(status);
}

/** Owner acceptance is available only after the Twin has moved work to review. */
export function canAcceptGroupTask(status) {
  return status === 'review';
}

/**
 * P0-1: a review task can be pulled back to executing (Back to work) — the
 * owner/chair reopens it to assign supplementary subtasks.
 */
export function canReopenGroupTask(status) {
  return status === 'review';
}

/** P1-4: i18n label key for a member workStatus. */
export function groupTaskWorkStatusLabelKey(status) {
  switch (status) {
    case 'working':
      return 'groupTasksWorkStatusWorking';
    case 'error':
      return 'groupTasksWorkStatusError';
    case 'idle':
      return 'groupTasksWorkStatusIdle';
    case 'unknown':
      return 'groupTasksWorkStatusUnknown';
    default:
      return 'groupTasksWorkStatusUnknown';
  }
}

/** Client-side status filter for the list tabs: active | done | cancelled | all. */
export function filterGroupTasksByTab(tasks, tab) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (tab === 'done') return list.filter((task) => task.status === 'done');
  if (tab === 'cancelled') return list.filter((task) => task.status === 'cancelled');
  if (tab === 'all') return list;
  return list.filter((task) => isActiveGroupTaskStatus(task.status));
}

/** Tailwind classes for the colored status badge. */
export function groupTaskStatusBadgeClass(status) {
  switch (status) {
    case 'planning':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300';
    case 'executing':
      // Breathing blue gradient (defined in index.css) so the in-progress
      // state reads as alive and distinct from the green "done" badge.
      return 'group-task-badge-executing';
    case 'review':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
    case 'done':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300';
    case 'cancelled':
      return 'bg-gray-200 text-gray-600 dark:bg-gray-700/50 dark:text-gray-300';
    default:
      return 'bg-gray-200 text-gray-600 dark:bg-gray-700/50 dark:text-gray-300';
  }
}

/**
 * Format a group-task timestamp for display. Accepts sqlite datetime('now')
 * text ('YYYY-MM-DD HH:MM:SS', UTC), epoch numbers, or null. On-chain
 * chain_timestamp is in SECONDS; smaller numbers (< 1e12) are treated as
 * seconds, larger ones as milliseconds.
 */
export function formatGroupTaskTime(value) {
  if (value == null || value === '') return '';
  let date;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    date = new Date(ms);
  } else {
    const text = String(value).trim();
    if (!text) return '';
    // sqlite datetime('now') is UTC without a timezone marker.
    const normalized = text.includes('T') ? text : `${text.replace(' ', 'T')}Z`;
    date = new Date(normalized);
  }
  if (Number.isNaN(date.getTime())) return '';
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * Merge transcript pages by id (ascending). Used when polling: the incoming
 * page replaces rows it overlaps and appends genuinely new ones.
 */
export function mergeTranscriptMessages(existing, incoming) {
  const byId = new Map();
  for (const message of Array.isArray(existing) ? existing : []) {
    if (message && typeof message.id === 'number') byId.set(message.id, message);
  }
  for (const message of Array.isArray(incoming) ? incoming : []) {
    if (message && typeof message.id === 'number') byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** Whether the transcript view should stick to the bottom on new messages. */
export function shouldStickToBottom(scrollTop, clientHeight, scrollHeight, threshold = 80) {
  return scrollHeight - (scrollTop + clientHeight) <= threshold;
}
