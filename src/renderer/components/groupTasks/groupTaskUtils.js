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
      return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300';
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

/** P0-2: Tailwind classes for the member state-machine status badge. */
export function groupTaskMemberStatusBadgeClass(status) {
  switch (status) {
    case 'working':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300';
    case 'standby':
      return 'bg-slate-100 text-slate-600 dark:bg-slate-800/50 dark:text-slate-300';
    case 'done':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300';
    case 'unreachable':
      return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300';
    case 'assigned':
    default:
      return 'bg-gray-100 text-gray-600 dark:bg-gray-800/50 dark:text-gray-300';
  }
}

/** P0-2: human label for the member state-machine status. */
export function groupTaskMemberStatusLabel(status) {
  switch (status) {
    case 'working': return 'working';
    case 'standby': return 'standby';
    case 'done': return 'done';
    case 'unreachable': return 'unreachable';
    case 'assigned':
    default: return 'assigned';
  }
}

/**
 * P0-4: summarize a deliverable's stored verification report (JSON string).
 * Returns one of 'verified' | 'pending-sync' | 'unverified' | 'unknown'.
 */
export function deliverableVerificationState(verification) {
  if (!verification) return 'unknown';
  let report;
  try {
    report = typeof verification === 'string' ? JSON.parse(verification) : verification;
  } catch {
    return 'unknown';
  }
  const sources = Array.isArray(report?.sources) ? report.sources : [];
  if (report?.verified === true) return 'verified';
  if (sources.some((entry) => entry?.outcome === 'not_found')
    && sources.some((entry) => entry?.outcome === 'found')) {
    return 'pending-sync';
  }
  if (sources.some((entry) => entry?.outcome === 'not_found')) return 'unverified';
  return 'unverified';
}

/** Tailwind classes for the verification badge. */
export function deliverableVerificationBadgeClass(state) {
  switch (state) {
    case 'verified':
      return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400';
    case 'pending-sync':
      return 'bg-amber-500/15 text-amber-600 dark:text-amber-400';
    case 'unverified':
      return 'bg-red-500/15 text-red-600 dark:text-red-400';
    default:
      return 'bg-gray-500/15 text-gray-600 dark:text-gray-400';
  }
}
