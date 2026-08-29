import React, { useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import type { CoworkSessionSummary } from '../../types/cowork';
import CoworkSessionItem, { SessionAvatarCircle } from './CoworkSessionItem';
import { i18nService } from '../../services/i18n';
import {
  groupSessionsByProject,
  groupSessionsByTimeline,
  type SessionSortMode,
  type SessionViewMode,
} from '../../utils/sessionViewGrouping';
import { ChevronDownIcon, FolderIcon } from '@heroicons/react/24/outline';

interface CoworkSessionListProps {
  sessions: CoworkSessionSummary[];
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onTogglePin: (sessionId: string, pinned: boolean) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  /** Empty-state message; defaults to the generic "no tasks" text. */
  emptyText?: string;
  /** Batch-selection mode (batch archive): rows render a checkbox and clicking
   * a row toggles its selection instead of opening the session. */
  selectionMode?: boolean;
  selectedSessionIds?: string[];
  onToggleSessionSelected?: (sessionId: string) => void;
  /** Grouping mode for the sidebar's local-chats list. Undefined keeps the
   * historic flat list (search modal, A2A tab). */
  viewMode?: SessionViewMode;
  /** Ordering within the flat list and inside every group. */
  sortMode?: SessionSortMode;
}

const groupHeaderLabelClass =
  'text-[11px] font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary';

const CoworkSessionList: React.FC<CoworkSessionListProps> = ({
  sessions,
  currentSessionId,
  onSelectSession,
  onDeleteSession,
  onTogglePin,
  onRenameSession,
  emptyText,
  selectionMode = false,
  selectedSessionIds,
  onToggleSessionSelected,
  viewMode,
  sortMode = 'updatedAt',
}) => {
  const unreadSessionIds = useSelector((state: RootState) => state.cowork.unreadSessionIds);
  const unreadSessionIdSet = useMemo(() => new Set(unreadSessionIds), [unreadSessionIds]);
  const selectedSessionIdSet = useMemo(() => new Set(selectedSessionIds ?? []), [selectedSessionIds]);
  // Project-group collapse state lives here (not in the parent) so the search
  // modal and A2A tab, which render flat, never see it. Defaults to expanded.
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<Set<string>>(new Set);
  const language = i18nService.getLanguage();

  const sortedSessions = useMemo(() => {
    const sortByRecentActivity = (a: CoworkSessionSummary, b: CoworkSessionSummary) => {
      if (b.updatedAt !== a.updatedAt) {
        return b.updatedAt - a.updatedAt;
      }
      return b.createdAt - a.createdAt;
    };

    const pinnedSessions = sessions
      .filter((session) => session.pinned)
      .sort(sortByRecentActivity);
    const unpinnedSessions = sessions
      .filter((session) => !session.pinned)
      .sort(sortByRecentActivity);
    return [...pinnedSessions, ...unpinnedSessions];
  }, [sessions]);

  const timelineGrouped = useMemo(
    () => (viewMode === 'timeline'
      ? groupSessionsByTimeline(sessions, sortMode, Date.now(), language)
      : null),
    [sessions, viewMode, sortMode, language],
  );

  const projectGrouped = useMemo(
    () => (viewMode === 'project' ? groupSessionsByProject(sessions, sortMode) : null),
    [sessions, viewMode, sortMode],
  );

  const toggleGroupCollapsed = (key: string) => {
    setCollapsedGroupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  if (sessions.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {emptyText ?? i18nService.t('coworkNoSessions')}
        </p>
      </div>
    );
  }

  const renderItem = (session: CoworkSessionSummary) => (
    <CoworkSessionItem
      key={session.id}
      session={session}
      hasUnread={unreadSessionIdSet.has(session.id)}
      isActive={session.id === currentSessionId}
      onSelect={() => onSelectSession(session.id)}
      onDelete={() => onDeleteSession(session.id)}
      onTogglePin={(pinned) => onTogglePin(session.id, pinned)}
      onRename={(title) => onRenameSession(session.id, title)}
      selectionMode={selectionMode}
      isSelected={selectedSessionIdSet.has(session.id)}
      onToggleSelected={
        onToggleSessionSelected ? () => onToggleSessionSelected(session.id) : undefined
      }
    />
  );

  const renderPinnedSection = (pinned: CoworkSessionSummary[]) =>
    pinned.length > 0 && (
      <section key="pinned">
        <div className={`px-2.5 pb-1 pt-2 ${groupHeaderLabelClass}`}>
          {i18nService.t('coworkPinnedGroup')}
        </div>
        {pinned.map(renderItem)}
      </section>
    );

  // Timeline view: static time headers (never collapsible), pinned first.
  if (timelineGrouped) {
    return (
      <div>
        {renderPinnedSection(timelineGrouped.pinned)}
        {timelineGrouped.groups.map((group) => (
          <section key={group.key}>
            <div className={`px-2.5 pb-1 pt-2.5 ${groupHeaderLabelClass}`}>
              {group.labelKey ? i18nService.t(group.labelKey) : group.monthLabel}
            </div>
            {group.sessions.map(renderItem)}
          </section>
        ))}
      </div>
    );
  }

  // Project view: collapsible per-project / per-bot groups, pinned first.
  if (projectGrouped) {
    return (
      <div>
        {renderPinnedSection(projectGrouped.pinned)}
        {projectGrouped.groups.map((group) => {
          const collapsed = collapsedGroupKeys.has(group.key);
          let headerLabel: React.ReactNode;
          if (group.kind === 'bot' && group.bot) {
            headerLabel = (
              <>
                <SessionAvatarCircle
                  src={group.bot.avatar}
                  name={group.bot.name}
                  sizeClass="h-4 w-4"
                />
                <span className="truncate">{group.bot.name || `Bot ${group.bot.id}`}</span>
              </>
            );
          } else if (group.kind === 'directory') {
            headerLabel = (
              <>
                <FolderIcon className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate" title={group.directoryPath}>
                  {group.directoryName}
                </span>
              </>
            );
          } else {
            headerLabel = (
              <>
                <FolderIcon className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate">{i18nService.t('sessionGroupOther')}</span>
              </>
            );
          }
          return (
            <section key={group.key}>
              <button
                type="button"
                aria-expanded={!collapsed}
                onClick={() => toggleGroupCollapsed(group.key)}
                className={`flex w-full items-center gap-1.5 px-2.5 pb-1 pt-2.5 text-left transition-colors hover:text-claude-text dark:hover:text-claude-darkText ${groupHeaderLabelClass}`}
              >
                <ChevronDownIcon
                  className={`h-3 w-3 flex-shrink-0 transition-transform duration-150 ${collapsed ? '-rotate-90' : ''}`}
                />
                {headerLabel}
              </button>
              {!collapsed && group.sessions.map(renderItem)}
            </section>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {sortedSessions.map(renderItem)}
    </div>
  );
};

export default CoworkSessionList;
