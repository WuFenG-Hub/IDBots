import React, { useCallback, useEffect, useRef, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { openTeamCollabService } from '../../services/openTeamCollabService';
import type { GroupChatTranscriptMessage } from '../../types/groupTask';
import type { OpenTeamCollabSummary } from '../../types/openTeamCollab';
import GroupTaskMessageItem from './GroupTaskMessageItem';
import {
  formatGroupTaskTime,
  mergeTranscriptMessages,
  shouldStickToBottom,
} from './groupTaskUtils';
import {
  openTeamCollabStatusBadgeClass,
  openTeamCollabTitle,
  shortGlobalMetaId,
} from './OpenTeamCollabsSection';
import { ArrowLeftIcon, ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';

const MESSAGE_PAGE_LIMIT = 50;

interface OpenTeamCollabDetailViewProps {
  collab: OpenTeamCollabSummary;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
  onBack: () => void;
}

/**
 * Read-only transcript of one external OpenTeam group this machine's bot
 * joined. No composer and no controls — the task is hosted on the inviter's
 * machine; this view only proves what our bot saw and said. Polls on the same
 * 5s cadence as the group-task detail transcript.
 */
const OpenTeamCollabDetailView: React.FC<OpenTeamCollabDetailViewProps> = ({
  collab,
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
  onBack,
}) => {
  const isMac = window.electron.platform === 'darwin';
  const [messages, setMessages] = useState<GroupChatTranscriptMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(true);
  const [messagesError, setMessagesError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  const loadMessages = useCallback(async () => {
    try {
      const page = await openTeamCollabService.listMessages(collab.groupId, { limit: MESSAGE_PAGE_LIMIT });
      setMessages((current) => mergeTranscriptMessages(current, page));
      setMessagesError(null);
    } catch (err) {
      setMessagesError(err instanceof Error ? err.message : String(err));
    }
  }, [collab.groupId]);

  // Transcript: initial load + 5s poll while mounted.
  useEffect(() => {
    let cancelled = false;
    setLoadingMessages(true);
    void loadMessages().finally(() => {
      if (!cancelled) setLoadingMessages(false);
    });
    const timer = window.setInterval(() => {
      void loadMessages();
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loadMessages]);

  // Auto-scroll to bottom on new messages unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const handleTranscriptScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = shouldStickToBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
  };

  const title = openTeamCollabTitle(collab);
  const inviter = shortGlobalMetaId(collab.inviterGlobalmetaid);
  const botLabel = collab.botName?.trim() || `bot-${collab.metabotId}`;
  const ownBotGlobalMetaId = collab.globalmetaid?.trim() || null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="draggable flex h-12 items-center justify-between px-4 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
        <div className="flex items-center space-x-3 h-8 min-w-0">
          {isSidebarCollapsed && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
              <button
                type="button"
                onClick={onToggleSidebar}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
              <button
                type="button"
                onClick={onNewChat}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
              {updateBadge}
            </div>
          )}
          <button
            onClick={onBack}
            className="non-draggable p-2 rounded-lg dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary transition-colors"
            aria-label={i18nService.t('back')}
          >
            <ArrowLeftIcon className="h-5 w-5" />
          </button>
          <h1 className="text-lg font-semibold dark:text-claude-darkText text-claude-text truncate">
            {title}
          </h1>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${openTeamCollabStatusBadgeClass(collab.status)}`}>
            {i18nService.t(collab.status === 'active' ? 'openTeamCollabStatusActive' : 'openTeamCollabStatusLeft')}
          </span>
        </div>
        <WindowTitleBar inline />
      </div>

      {/* Meta strip: who invited us, which bot joined, when */}
      <div className="px-4 py-3 border-b dark:border-claude-darkBorder/50 border-claude-border/50 shrink-0">
        <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('openTeamCollabYourBot')}: {botLabel}
          {inviter ? ` · ${i18nService.t('openTeamCollabInvitedBy')} ${inviter}` : ''}
          {collab.createdAt ? ` · ${i18nService.t('openTeamCollabJoined')} ${formatGroupTaskTime(collab.createdAt)}` : ''}
        </p>
        <p className="mt-1 text-xs dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
          {i18nService.t('openTeamCollabReadOnlyHint')}
        </p>
      </div>

      {/* Transcript */}
      <div
        ref={scrollRef}
        onScroll={handleTranscriptScroll}
        className="flex-1 overflow-y-auto pt-3"
      >
        {loadingMessages && messages.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <div className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('loading')}
            </div>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-6">
            <ChatBubbleLeftRightIcon className="h-10 w-10 dark:text-claude-darkTextSecondary/40 text-claude-textSecondary/40 mb-3" />
            <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {messagesError ?? i18nService.t('groupTasksTranscriptEmpty')}
            </p>
          </div>
        ) : (
          messages.map((message) => (
            <GroupTaskMessageItem
              key={message.id}
              message={message}
              isChairSender={false}
              isOwnerSender={false}
              isOwnBotSender={Boolean(
                ownBotGlobalMetaId && message.senderGlobalMetaId === ownBotGlobalMetaId,
              )}
            />
          ))
        )}
      </div>
    </div>
  );
};

export default OpenTeamCollabDetailView;
