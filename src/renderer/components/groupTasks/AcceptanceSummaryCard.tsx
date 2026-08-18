import React, { useState } from 'react';
import { i18nService } from '../../services/i18n';
import type {
  GroupTaskAcceptanceSummary,
  GroupTaskAcceptanceSummaryDeliverable,
} from '../../types/groupTask';
import { deliverableKindBadge, isBotBrowserUri, openGroupTaskUri } from './groupTaskUtils';
import { ClipboardDocumentIcon, CheckIcon } from '@heroicons/react/24/outline';

/**
 * R1: renders the host-generated acceptance summary ("把菜端上桌") — the single
 * source of truth that also backs the group's last review message and the owner
 * private report. Shown in the detail panel once the task has entered review.
 *
 * P12 (v1.1): the card lives in the detail view's FIXED header block, which is
 * not part of the scrollable transcript. With 10+ deliverables the old
 * always-expanded card consumed the whole viewport and pushed the group
 * history off-screen (Boss feedback 2026-08-17). The card therefore renders
 * COLLAPSED by default (a single header row); expanding opens a
 * max-height-capped, internally scrollable body so the transcript below stays
 * visible no matter how large the checklist is.
 *
 * Deliverable URIs are shown as plain text with a copy button here; making
 * metaweb URIs clickable everywhere is R3 (P1). The card is read-only: the
 * owner accepts/reworks via the header buttons, not from this card.
 */
const AcceptanceSummaryCard: React.FC<{ summary: GroupTaskAcceptanceSummary }> = ({
  summary,
}) => {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-xl border border-emerald-300/60 dark:border-emerald-500/30 bg-emerald-50/60 dark:bg-emerald-900/10 p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
          📦 {i18nService.t('groupTasksAcceptanceSummaryTitle')}
        </span>
        <span className="shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
          v{summary.version}
        </span>
        {summary.outcome && (
          <span className="shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium bg-gray-500/15 text-gray-600 dark:text-gray-400">
            {summary.outcome}
            {summary.rating != null ? ` · ${summary.rating}/5` : ''}
          </span>
        )}
        <span className="shrink-0 text-[11px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
          {i18nService.t('groupTasksAcceptanceDeliverables')} · {summary.deliverables.length}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="ml-auto shrink-0 text-xs text-claude-accent hover:underline"
        >
          {i18nService.t(expanded ? 'groupTasksAcceptanceCollapse' : 'groupTasksAcceptanceExpand')}
        </button>
      </div>

      {expanded && (
        <div className="mt-2 max-h-64 overflow-y-auto space-y-2">
          <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary space-y-1">
            <p>
              <span className="font-medium dark:text-claude-darkText text-claude-text">
                {i18nService.t('groupTasksAcceptanceGoal')}:
              </span>{' '}
              {summary.goal.trim()}
            </p>
            <p>
              <span className="font-medium dark:text-claude-darkText text-claude-text">
                {i18nService.t('groupTasksAcceptanceCriteria')}:
              </span>{' '}
              {(summary.acceptanceCriteria ?? '').trim() || i18nService.t('groupTasksAcceptanceCriteriaEmpty')}
            </p>
          </div>

          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide dark:text-claude-darkTextSecondary/80 text-claude-textSecondary/80 mb-1">
              {i18nService.t('groupTasksAcceptanceDeliverables')}
            </div>
            {summary.deliverables.length === 0 ? (
              <p className="text-xs italic dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                {i18nService.t('groupTasksAcceptanceNoDeliverables')}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {summary.deliverables.map((deliverable, index) => (
                  <DeliverableRow key={index} deliverable={deliverable} />
                ))}
              </ul>
            )}
          </div>

          {(summary.planChanges ?? []).length > 0 && (
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wide dark:text-claude-darkTextSecondary/80 text-claude-textSecondary/80 mb-1">
                {i18nService.t('groupTasksAcceptancePlanChanges')}
              </div>
              <ul className="space-y-1">
                {(summary.planChanges ?? []).map((change, index) => (
                  <li
                    key={index}
                    className="text-xs leading-relaxed dark:text-claude-darkTextSecondary text-claude-textSecondary"
                  >
                    {change}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {summary.members.length > 0 && (
            <div className="text-[11px] dark:text-claude-darkTextSecondary/80 text-claude-textSecondary/80">
              <span className="font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('groupTasksAcceptanceMembers')}:
              </span>{' '}
              {summary.members.map((member) => member.name ?? 'unknown').join('、')}
            </div>
          )}

          <pre className="whitespace-pre-wrap text-[11px] leading-relaxed dark:text-claude-darkTextSecondary text-claude-textSecondary font-sans">
            {summary.guidance.trim()}
          </pre>

          {summary.publishedGroupPinId && (
            <div className="text-[10px] dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">
              {i18nService.t('groupTasksAcceptancePublishedPin')}: {summary.publishedGroupPinId}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/** One deliverable row in the summary card: kind badge + uri (copyable) + verification + author. */
const DeliverableRow: React.FC<{ deliverable: GroupTaskAcceptanceSummaryDeliverable }> = ({ deliverable }) => {
  const [copied, setCopied] = useState(false);
  // P3 (v1.1): badge reflects the ledger state — owner verdict first
  // (accepted/rejected), then on-chain verification ('delivered' or
  // confirmation), falling back to 'pending' only while unverified.
  const badgeAccepted = deliverable.status === 'accepted';
  const badgeRejected = deliverable.status === 'rejected';
  const badgeVerified = !badgeAccepted && !badgeRejected
    && (deliverable.confirmation === 'confirmed' || deliverable.status === 'delivered');
  const badgeLabel = badgeAccepted
    ? 'accepted ✓'
    : badgeRejected
      ? 'rejected'
      : badgeVerified
        ? 'on-chain ✓'
        : 'pending';
  const badgeClass = badgeAccepted || badgeVerified
    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
    : badgeRejected
      ? 'bg-red-500/15 text-red-600 dark:text-red-400'
      : 'bg-amber-500/15 text-amber-600 dark:text-amber-400';
  const handleCopy = async () => {
    if (!deliverable.uri) return;
    try {
      await navigator.clipboard.writeText(deliverable.uri);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — silently ignore.
    }
  };
  return (
    <li className="rounded-lg dark:bg-claude-darkSurfaceHover/50 bg-claude-surfaceHover/50 p-2">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span
          className={`shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight ${deliverableKindBadge(deliverable.kind ?? 'text')}`}
        >
          {deliverable.kind ?? 'text'}
        </span>
        <span
          className={`shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight ${badgeClass}`}
        >
          {badgeLabel}
        </span>
        {deliverable.uri && (
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="ml-auto inline-flex items-center gap-1 text-[10px] text-claude-accent hover:underline"
            title={i18nService.t('copy')}
          >
            {copied ? <CheckIcon className="h-3 w-3" /> : <ClipboardDocumentIcon className="h-3 w-3" />}
            {copied ? i18nService.t('copied') : i18nService.t('copy')}
          </button>
        )}
      </div>
      {deliverable.uri ? (
        (() => {
          const clickable = isBotBrowserUri(deliverable.uri) || /^https?:\/\//i.test(deliverable.uri);
          return clickable ? (
            <button
              type="button"
              onClick={() => openGroupTaskUri(deliverable.uri)}
              title={deliverable.uri}
              className="block mt-1 text-left text-xs text-claude-accent hover:underline break-all cursor-pointer"
            >
              {deliverable.uri}
            </button>
          ) : (
            <code className="block mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary break-all">
              {deliverable.uri}
            </code>
          );
        })()
      ) : (
        <span className="block mt-1 text-[11px] italic dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
          {i18nService.t('groupTasksDeliverableNoSource')}
        </span>
      )}
      <div className="mt-1 text-[11px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
        {deliverable.authorName ?? 'unknown'}
      </div>
    </li>
  );
};

export default AcceptanceSummaryCard;
