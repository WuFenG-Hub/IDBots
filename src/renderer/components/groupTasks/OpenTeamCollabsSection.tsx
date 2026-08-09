import React, { useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { openTeamCollabService } from '../../services/openTeamCollabService';
import type { OpenTeamCollabSummary } from '../../types/openTeamCollab';
import { formatGroupTaskTime } from './groupTaskUtils';

/** Short display form of a GlobalMetaID / group id (same style as the task detail rail). */
export function shortGlobalMetaId(value: string | null | undefined): string {
  const text = value?.trim() ?? '';
  if (!text) return '';
  return text.length > 12 ? `${text.slice(0, 10)}…` : text;
}

/** Card title: the task title carried by the invite, else a short group id. */
export function openTeamCollabTitle(collab: Pick<OpenTeamCollabSummary, 'taskTitle' | 'groupId'>): string {
  const title = collab.taskTitle?.trim();
  if (title) return title;
  return i18nService.t('openTeamCollabUntitled').replace('{id}', shortGlobalMetaId(collab.groupId) || collab.groupId);
}

/** Tailwind classes for the Active/Left status badge. */
export function openTeamCollabStatusBadgeClass(status: string): string {
  return status === 'active'
    ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
    : 'bg-gray-200 text-gray-600 dark:bg-gray-700/50 dark:text-gray-300';
}

/** Pure presentational card (exported for node:test markup assertions). */
export const OpenTeamCollabCard: React.FC<{ collab: OpenTeamCollabSummary; onClick: () => void }> = ({
  collab,
  onClick,
}) => {
  const inviter = shortGlobalMetaId(collab.inviterGlobalmetaid);
  const botLabel = collab.botName?.trim() || `bot-${collab.metabotId}`;
  const joinedAt = formatGroupTaskTime(collab.createdAt);
  const lastActivity = formatGroupTaskTime(collab.lastMessageAt);

  return (
    <div
      className="px-4 py-3 border-b dark:border-claude-darkBorder/50 border-claude-border/50 hover:bg-claude-surfaceHover/50 dark:hover:bg-claude-darkSurfaceHover/50 cursor-pointer transition-colors"
      onClick={onClick}
    >
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">
              {openTeamCollabTitle(collab)}
            </span>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${openTeamCollabStatusBadgeClass(collab.status)}`}>
              {i18nService.t(collab.status === 'active' ? 'openTeamCollabStatusActive' : 'openTeamCollabStatusLeft')}
            </span>
          </div>
          <div className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
            {i18nService.t('openTeamCollabYourBot')}: {botLabel}
            {inviter ? ` · ${i18nService.t('openTeamCollabInvitedBy')} ${inviter}` : ''}
            {joinedAt ? ` · ${i18nService.t('openTeamCollabJoined')} ${joinedAt}` : ''}
          </div>
        </div>
        <div className="shrink-0 text-right text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          <div>
            {i18nService.t('openTeamCollabMessageCount').replace('{count}', String(collab.messageCount))}
          </div>
          {lastActivity && <div className="mt-0.5">{lastActivity}</div>}
        </div>
      </div>
    </div>
  );
};

interface OpenTeamCollabsSectionProps {
  onOpenCollab: (collab: OpenTeamCollabSummary) => void;
}

/**
 * "External collaborations (OpenTeam)" block under the Group Tasks list: every
 * external group task this machine's bots auto-joined (or left). Hidden when
 * there is nothing to show — the block is pure traceability, not an entry point.
 * Loaded on mount, matching GroupTasksView's own refresh strategy.
 */
const OpenTeamCollabsSection: React.FC<OpenTeamCollabsSectionProps> = ({ onOpenCollab }) => {
  const [items, setItems] = useState<OpenTeamCollabSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    openTeamCollabService
      .list()
      .then((list) => {
        if (!cancelled) setItems(list);
      })
      .catch(() => {
        // Traceability data must never break the Group Tasks view.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="shrink-0">
      <div className="px-4 pt-4 pb-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('openTeamCollabSectionTitle')}
        </h2>
      </div>
      {items.map((collab) => (
        <OpenTeamCollabCard
          key={collab.id}
          collab={collab}
          onClick={() => onOpenCollab(collab)}
        />
      ))}
    </div>
  );
};

export default OpenTeamCollabsSection;
