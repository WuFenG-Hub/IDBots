const MAX_FAILURE_REASON_CHARS = 160;

function truncateFailureReason(reason) {
  const text = String(reason || '').trim();
  if (text.length <= MAX_FAILURE_REASON_CHARS) return text;
  return `${text.slice(0, MAX_FAILURE_REASON_CHARS)}…`;
}

/**
 * Learn-summary notice for one knowledge-base card. Per-file failures are
 * collected by the learn loop into summary.failed but the run still finishes
 * with state 'done' — before this helper existed the notice rendered only the
 * added/updated/removed counts, so e.g. a Windows PDF parse failure showed up
 * as a green "added 0 / updated 0" success. Any failure now flips the notice
 * to an error styling and names the first failing file and its reason.
 */
export function formatKnowledgeBaseLearnSummary(summary, t) {
  const counts = t('knowledgeBaseLearnSummary')
    .replace('{added}', String(summary?.added ?? 0))
    .replace('{updated}', String(summary?.updated ?? 0))
    .replace('{removed}', String(summary?.removed ?? 0));
  const failed = Array.isArray(summary?.failed) ? summary.failed : [];
  if (!failed.length) {
    return { kind: 'success', text: counts };
  }
  const first = failed[0] || {};
  const errorText = String(first.error || '').trim();
  const prefix = first.relpath ? `${first.relpath}: ` : '';
  const reason = errorText ? `${prefix}${truncateFailureReason(errorText)}` : `${prefix}${t('knowledgeBaseLearnFailed')}`;
  const text = `${counts} · ${t('knowledgeBaseLearnSummaryFailed').replace('{count}', String(failed.length))}${t(
    'knowledgeBaseLearnSummaryFailedReason'
  ).replace('{reason}', reason)}`;
  return { kind: 'error', text };
}
