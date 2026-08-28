import React, { useMemo } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import type { CoworkSessionSummary } from '../../types/cowork';
import CoworkSessionItem from './CoworkSessionItem';
import { i18nService } from '../../services/i18n';

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
}

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
}) => {
  const unreadSessionIds = useSelector((state: RootState) => state.cowork.unreadSessionIds);
  const unreadSessionIdSet = useMemo(() => new Set(unreadSessionIds), [unreadSessionIds]);
  const selectedSessionIdSet = useMemo(() => new Set(selectedSessionIds ?? []), [selectedSessionIds]);

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

  if (sessions.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {emptyText ?? i18nService.t('coworkNoSessions')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {sortedSessions.map((session) => (
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
      ))}
    </div>
  );
};

export default CoworkSessionList;
