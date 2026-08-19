import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { i18nService } from '../../services/i18n';
import { isRenderableAvatarSource } from '../../utils/avatarSource';
import type { GroupTaskMemberPreview, GroupTaskSummary } from '../../types/groupTask';
import {
  formatGroupTaskRelativeTime,
  groupTaskStatusBadgeClass,
  groupTaskStatusLabelKey,
} from './groupTaskUtils';

const avatarInitial = (name?: string | null): string => {
  const trimmed = name?.trim() ?? '';
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : '?';
};

export const groupTaskMemberPreviews = (task: GroupTaskSummary): GroupTaskMemberPreview[] => {
  if (Array.isArray(task.members) && task.members.length > 0) {
    return [...task.members].sort((a, b) => {
      if (a.role === 'chair' && b.role !== 'chair') return -1;
      if (b.role === 'chair' && a.role !== 'chair') return 1;
      return 0;
    });
  }
  return (task.memberNames ?? []).map((name) => ({
    name,
    avatar: null,
    role: name === task.chairName ? 'chair' : 'worker',
    metabotId: null,
  }));
};

export const relativeTimeTitle = (unit: string, count: number): string => {
  if (unit === 'now') return i18nService.t('justNow');
  if (unit === 'minutes') return `${count} ${i18nService.t('minutesAgo')}`;
  if (unit === 'hours') return `${count} ${i18nService.t('hoursAgo')}`;
  if (unit === 'yesterday') return i18nService.t('yesterday');
  if (unit === 'days') return `${count} ${i18nService.t('daysAgo')}`;
  return '';
};

/** Tiny circular avatar sized to sit on the same row as `text-xs` member names. */
export const GroupTaskTinyAvatar: React.FC<{
  src?: string | null;
  name?: string | null;
  size?: 'list' | 'hover';
}> = ({ src, name, size = 'list' }) => {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => {
    setImageFailed(false);
  }, [src]);
  const showImage = isRenderableAvatarSource(src) && !imageFailed;
  const box = size === 'hover' ? 'h-5 w-5 text-[10px]' : 'h-4 w-4 text-[9px]';
  return (
    <span
      className={`flex ${box} flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-claude-surfaceHover font-semibold text-claude-textSecondary dark:bg-claude-darkSurfaceHover dark:text-claude-darkTextSecondary`}
      title={name?.trim() || undefined}
    >
      {showImage ? (
        <img
          src={src ?? undefined}
          alt={name?.trim() || ''}
          className="h-full w-full object-cover"
          onError={() => setImageFailed(true)}
        />
      ) : (
        avatarInitial(name)
      )}
    </span>
  );
};

export const GroupTaskMemberAvatarRow: React.FC<{ members: GroupTaskMemberPreview[] }> = ({
  members,
}) => {
  if (members.length === 0) return null;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
      {members.map((member, index) => (
        <GroupTaskTinyAvatar
          key={`${member.metabotId ?? member.name}-${index}`}
          src={member.avatar}
          name={member.name}
        />
      ))}
    </span>
  );
};

export const GroupTaskHoverCard: React.FC<{
  task: GroupTaskSummary;
  anchorRect: DOMRect | null;
}> = ({ task, anchorRect }) => {
  if (!anchorRect || typeof document === 'undefined') return null;

  const members = groupTaskMemberPreviews(task);
  const displayTitle = task.displayName?.trim() || task.title;
  const relative = formatGroupTaskRelativeTime(task.updatedAt ?? task.createdAt);
  const panelWidth = 260;
  const padding = 8;
  let left = anchorRect.right + 8;
  if (left + panelWidth > window.innerWidth - padding) {
    left = Math.max(padding, anchorRect.left - panelWidth - 8);
  }
  const top = Math.min(anchorRect.top, window.innerHeight - 240);

  return createPortal(
    <div
      role="tooltip"
      style={{ top, left, width: panelWidth }}
      className="pointer-events-none fixed z-[80] max-h-[70vh] overflow-y-auto rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface px-3 py-2.5 shadow-popover"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">
            {displayTitle}
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${groupTaskStatusBadgeClass(task.status)}`}>
              {i18nService.t(groupTaskStatusLabelKey(task.status))}
            </span>
            {relative.compact ? (
              <span className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {relative.compact}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      {task.goal?.trim() ? (
        <div className="mt-2">
          <div className="text-[10px] font-medium uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('groupTasksFormGoal')}
          </div>
          <p className="mt-0.5 text-xs leading-snug dark:text-claude-darkText text-claude-text line-clamp-3">
            {task.goal.trim()}
          </p>
        </div>
      ) : null}
      <div className="mt-2">
        <div className="text-[10px] font-medium uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('groupTasksMembers')}
        </div>
        <div className="mt-1 space-y-1">
          {members.length === 0 ? (
            <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">—</div>
          ) : (
            members.map((member, index) => (
              <div
                key={`${member.metabotId ?? member.name}-${index}`}
                className="flex items-center gap-2 min-w-0"
              >
                <GroupTaskTinyAvatar src={member.avatar} name={member.name} size="hover" />
                <span className="min-w-0 flex-1 truncate text-xs dark:text-claude-darkText text-claude-text">
                  {member.name || '?'}
                </span>
                {member.role === 'chair' ? (
                  <span className="shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight bg-claude-accent/15 text-claude-accent">
                    {i18nService.t('groupTasksChairBadge')}
                  </span>
                ) : null}
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};
