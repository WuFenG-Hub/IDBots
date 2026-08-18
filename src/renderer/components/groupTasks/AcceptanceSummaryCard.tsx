import React, { useState } from 'react';
import { i18nService } from '../../services/i18n';
import type {
  GroupTaskAcceptanceSummary,
  GroupTaskAcceptanceSummaryDeliverable,
} from '../../types/groupTask';
import { deliverableKindBadge, isBotBrowserUri, openGroupTaskUri } from './groupTaskUtils';
import { ClipboardDocumentIcon, CheckIcon } from '@heroicons/react/24/outline';

/**
 * Improvement #1 (single-card acceptance): the card is the ONE place the owner
 * reads the verdict and acts. It leads with the chair's one-line conclusion
 * (the same authoritative string stored on the summary record that heads the
 * group 📦 summary and the origin-session [GROUP_TASK_REVIEW] notice — when no
 * 【结论】 verdict was captured, a deterministic deliverable-count line from the
 * same record stands in). The Accept & Close / Rework buttons live INSIDE the
 * card (expanded); goal/criteria render as capped previews with inline expand.
 *
 * P12 (v1.1): the card lives in the detail view's FIXED header block, which is
 * not part of the scrollable transcript. With 10+ deliverables the old
 * always-expanded card consumed the whole viewport and pushed the group
 * history off-screen (Boss feedback 2026-08-17). The card therefore renders
 * COLLAPSED by default (header + conclusion headline); expanding opens a
 * max-height-capped, internally scrollable body so the transcript below stays
 * visible no matter how large the checklist is.
 *
 * R3: metaweb (metaapp://, metafile://, …) and http(s) deliverable URIs are
 * clickable and open in the right surface (Bot Browser vs external browser);
 * the copy button always yields the full URI.
 */
export interface AcceptanceSummaryCardActions {
  onAccept: () => void;
  onRework: () => void;
  reworking: boolean;
}

/** Improvement #1: cap for the goal/criteria in-card previews (full text behind the inline toggle). */
const FIELD_PREVIEW_MAX_CHARS = 160;

const AcceptanceSummaryCard: React.FC<{
  summary: GroupTaskAcceptanceSummary;
  /** Decision actions rendered inside the card; pass only while the task is in review. */
  actions?: AcceptanceSummaryCardActions;
}> = ({ summary, actions }) => {
  const [expanded, setExpanded] = useState(false);
  // Improvement #1 fallback headline: deterministic facts computed from the
  // same record (no second prose voice) when the chair's verdict is absent.
  const conclusion = (summary.conclusion ?? '').trim();
  const confirmedCount = summary.deliverables.filter(
    (deliverable) => deliverable.confirmation === 'confirmed' || deliverable.status === 'delivered',
  ).length;
  const headline = conclusion
    || i18nService.t('groupTasksAcceptanceConclusionFallback')
      .replace('{total}', String(summary.deliverables.length))
      .replace('{confirmed}', String(confirmedCount));
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

      {/* Conclusion headline — always visible, truncated to one line while collapsed. */}
      <p
        title={headline}
        className={`mt-1 text-xs leading-relaxed dark:text-claude-darkTextSecondary text-claude-textSecondary ${
          expanded ? 'whitespace-pre-wrap break-words' : 'truncate'
        }`}
      >
        <span className="font-medium dark:text-claude-darkText text-claude-text">
          {i18nService.t('groupTasksAcceptanceConclusion')}:
        </span>{' '}
        {headline}
      </p>

      {expanded && (
        <div className="mt-2 max-h-64 overflow-y-auto space-y-2">
          {actions && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={actions.onAccept}
                className="px-3 py-1.5 text-sm font-medium rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 transition-colors"
              >
                {i18nService.t('groupTasksAcceptClose')}
              </button>
              <button
                type="button"
                onClick={actions.onRework}
                disabled={actions.reworking}
                className="px-3 py-1.5 text-sm font-medium rounded-lg text-amber-600 dark:text-amber-400 border border-amber-300 dark:border-amber-500/40 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors disabled:opacity-50"
              >
                {actions.reworking
                  ? i18nService.t('groupTasksReopening')
                  : i18nService.t('groupTasksBackToWork')}
              </button>
            </div>
          )}

          <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary space-y-1">
            <PreviewableField
              label={i18nService.t('groupTasksAcceptanceGoal')}
              text={summary.goal.trim()}
            />
            <PreviewableField
              label={i18nService.t('groupTasksAcceptanceCriteria')}
              text={(summary.acceptanceCriteria ?? '').trim()}
              emptyText={i18nService.t('groupTasksAcceptanceCriteriaEmpty')}
            />
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

/**
 * Improvement #1: goal/criteria render as a capped preview so the card stays
 * scannable; the full text is behind an inline expand toggle (mirrors the
 * backend's 160-char group-message preview cap).
 */
const PreviewableField: React.FC<{ label: string; text: string; emptyText?: string }> = ({
  label,
  text,
  emptyText,
}) => {
  const [showFull, setShowFull] = useState(false);
  const trimmed = (text ?? '').trim();
  const isLong = trimmed.length > FIELD_PREVIEW_MAX_CHARS;
  const shown = !trimmed && emptyText
    ? emptyText
    : isLong && !showFull
      ? `${trimmed.slice(0, FIELD_PREVIEW_MAX_CHARS).trimEnd()}…`
      : trimmed;
  return (
    <p className="whitespace-pre-wrap break-words">
      <span className="font-medium dark:text-claude-darkText text-claude-text">
        {label}:
      </span>{' '}
      {shown}
      {isLong && (
        <button
          type="button"
          onClick={() => setShowFull((value) => !value)}
          className="ml-1 text-claude-accent hover:underline"
        >
          {i18nService.t(showFull ? 'groupTasksAcceptanceCollapse' : 'groupTasksAcceptanceExpand')}
        </button>
      )}
    </p>
  );
};

/** One deliverable row in the summary card: kind badge + uri (openable/copyable) + verification + author. */
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
        {(() => {
          // deliverableKindBadge returns { labelKey, className } — the rail
          // path already localizes the label; do the same here (previously the
          // object itself leaked into the className).
          const kindBadge = deliverableKindBadge(deliverable.kind ?? 'text');
          return (
            <span
              className={`shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight ${kindBadge.className}`}
            >
              {i18nService.t(kindBadge.labelKey)}
            </span>
          );
        })()}
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
