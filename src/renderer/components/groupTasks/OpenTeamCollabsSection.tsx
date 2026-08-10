import React, { useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { openTeamCollabService } from '../../services/openTeamCollabService';
import type { OpenTeamCollabSummary, OpenTeamGuestInvite, OpenTeamGuestInviteStatus } from '../../types/openTeamCollab';
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

/**
 * Tailwind classes for a received-invite status badge (P0-1): waiting shows
 * amber, accepted green, everything terminal gray.
 */
export function openTeamGuestInviteStatusBadgeClass(status: OpenTeamGuestInviteStatus): string {
  if (status === 'invited') {
    return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
  }
  if (status === 'accepted') {
    return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300';
  }
  return 'bg-gray-200 text-gray-600 dark:bg-gray-700/50 dark:text-gray-300';
}

/** i18n label for a received-invite status (P0-1). */
export function openTeamGuestInviteStatusLabel(status: OpenTeamGuestInviteStatus): string {
  switch (status) {
    case 'invited': return i18nService.t('openTeamGuestInviteStatusInvited');
    case 'accepted': return i18nService.t('openTeamGuestInviteStatusAccepted');
    case 'declined': return i18nService.t('openTeamGuestInviteStatusDeclined');
    case 'skipped': return i18nService.t('openTeamGuestInviteStatusSkipped');
    case 'expired': return i18nService.t('openTeamGuestInviteStatusExpired');
    default: return status;
  }
}

/**
 * Pure presentational card for one received invite (exported for node:test
 * markup assertions). Shows who invited the machine's bots into which task and
 * how the invite ended up — visible even when the bot declined or never joined.
 */
export const OpenTeamGuestInviteCard: React.FC<{ invite: OpenTeamGuestInvite }> = ({ invite }) => {
  const inviter = shortGlobalMetaId(invite.inviterName || invite.inviterGlobalmetaid);
  const title = invite.taskTitle?.trim()
    || i18nService.t('openTeamCollabUntitled').replace('{id}', shortGlobalMetaId(invite.groupId) || invite.groupId);
  const receivedAt = formatGroupTaskTime(invite.createdAt);
  const goal = invite.goalSummary?.trim();

  return (
    <div className="px-4 py-3 border-b dark:border-claude-darkBorder/50 border-claude-border/50">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">
              {title}
            </span>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${openTeamGuestInviteStatusBadgeClass(invite.status)}`}>
              {openTeamGuestInviteStatusLabel(invite.status)}
            </span>
          </div>
          <div className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
            {inviter ? `${i18nService.t('openTeamGuestInviteFrom')} ${inviter}` : ''}
            {receivedAt ? ` · ${i18nService.t('openTeamGuestInviteReceivedAt')} ${receivedAt}` : ''}
          </div>
          {goal && (
            <div className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
              {i18nService.t('openTeamGuestInviteGoal')}: {goal}
            </div>
          )}
          {invite.requiredSkills.length > 0 && (
            <div className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
              {i18nService.t('openTeamGuestInviteSkills')}: {invite.requiredSkills.join(', ')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

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

/** Poll cadence for the collab list (new invites/kicks surface without a reload). */
export const OPEN_TEAM_COLLAB_POLL_INTERVAL_MS = 15_000;

/**
 * "External collaborations (OpenTeam)" block under the Group Tasks list: every
 * external group task this machine's bots auto-joined (or left). Hidden when
 * there is nothing to show — the block is pure traceability, not an entry point.
 * Loaded on mount and re-polled every OPEN_TEAM_COLLAB_POLL_INTERVAL_MS so new
 * collaborations and kick/leave transitions surface without revisiting the view;
 * the interval is cleared on unmount.
 */
const OpenTeamCollabsSection: React.FC<OpenTeamCollabsSectionProps> = ({ onOpenCollab }) => {
  const [items, setItems] = useState<OpenTeamCollabSummary[]>([]);
  const [guestInvites, setGuestInvites] = useState<OpenTeamGuestInvite[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      openTeamCollabService
        .list()
        .then((list) => {
          if (!cancelled) setItems(list);
        })
        .catch(() => {
          // Traceability data must never break the Group Tasks view.
        });
      // P0-1: received-invite history rides the same poll so new invites and
      // accept/decline/expiry transitions surface without a reload.
      openTeamCollabService
        .listGuestInvites()
        .then((list) => {
          if (!cancelled) setGuestInvites(list);
        })
        .catch(() => {
          // Traceability data must never break the Group Tasks view.
        });
    };
    load();
    const timer = setInterval(load, OPEN_TEAM_COLLAB_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (items.length === 0 && guestInvites.length === 0) return null;

  return (
    <div className="shrink-0">
      {items.length > 0 && (
        <>
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
        </>
      )}
      {guestInvites.length > 0 && (
        <>
          <div className="px-4 pt-4 pb-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('openTeamGuestInvitesSectionTitle')}
            </h2>
          </div>
          {guestInvites.map((invite) => (
            <OpenTeamGuestInviteCard key={invite.id} invite={invite} />
          ))}
        </>
      )}
    </div>
  );
};

export default OpenTeamCollabsSection;
