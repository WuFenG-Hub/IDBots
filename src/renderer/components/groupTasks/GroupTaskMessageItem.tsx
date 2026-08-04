import React from 'react';
import { i18nService } from '../../services/i18n';
import MarkdownContent from '../MarkdownContent';
import type { GroupChatTranscriptMessage } from '../../types/groupTask';
import { formatGroupTaskTime } from './groupTaskUtils';

interface GroupTaskMessageItemProps {
  message: GroupChatTranscriptMessage;
  isChairSender: boolean;
  isOwnerSender: boolean;
}

const GroupTaskMessageItem: React.FC<GroupTaskMessageItemProps> = ({
  message,
  isChairSender,
  isOwnerSender,
}) => {
  const senderName = message.senderName?.trim() || 'Unknown';
  const initial = senderName.slice(0, 1).toUpperCase();
  const timestamp = formatGroupTaskTime(message.chainTimestamp);

  return (
    <div className="flex items-start gap-2.5 px-4 py-2.5">
      {/* Avatar */}
      {message.senderAvatar ? (
        <img
          src={message.senderAvatar}
          alt={senderName}
          className="h-8 w-8 shrink-0 rounded-full object-cover dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover"
        />
      ) : (
        <div className="h-8 w-8 shrink-0 rounded-full flex items-center justify-center text-xs font-semibold dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {initial}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">
            {senderName}
          </span>
          {isChairSender && (
            <span className="shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight bg-claude-accent/15 text-claude-accent">
              {i18nService.t('groupTasksChairBadge')}
            </span>
          )}
          {isOwnerSender && (
            <span className="shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
              {i18nService.t('groupTasksOwnerBadge')}
            </span>
          )}
          {timestamp && (
            <span className="shrink-0 text-[11px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
              {timestamp}
            </span>
          )}
        </div>
        <div
          className={`mt-1 rounded-lg px-3 py-2 text-sm ${
            isOwnerSender
              ? 'dark:bg-emerald-900/20 bg-emerald-50 dark:text-claude-darkText text-claude-text'
              : 'dark:bg-claude-darkSurfaceHover/60 bg-claude-surfaceHover/60 dark:text-claude-darkText text-claude-text'
          }`}
        >
          <MarkdownContent content={message.content ?? ''} className="text-sm" />
        </div>
      </div>
    </div>
  );
};

export default GroupTaskMessageItem;
