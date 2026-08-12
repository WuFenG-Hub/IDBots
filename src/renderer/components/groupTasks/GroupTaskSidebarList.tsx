import React from 'react';
import { i18nService } from '../../services/i18n';
import { groupTaskStatusBadgeClass, formatGroupTaskTime } from './groupTaskUtils';
import { groupTaskStatusLabelKey } from './GroupTasksView';
import type { GroupTaskSummary } from '../../types/groupTask';

interface GroupTaskSidebarListProps {
  tasks: GroupTaskSummary[];
  onSelectTask: (taskId: number) => void;
  /** Empty-state message; defaults to the group-task empty text. */
  emptyText?: string;
}

/**
 * Group-task entity list for the sidebar "Group Tasks" tab. Unlike the
 * co-work/A2A tabs (which show cowork sessions), this tab shows the real
 * group-task records — title, status badge, chair/members, update time —
 * and opens the full Group Tasks detail view on click.
 */
const GroupTaskSidebarList: React.FC<GroupTaskSidebarListProps> = ({
  tasks,
  onSelectTask,
  emptyText,
}) => {
  if (tasks.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {emptyText ?? i18nService.t('coworkEmptyGroup')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {tasks.map((task) => (
        <div
          key={task.id}
          role="button"
          tabIndex={0}
          onClick={() => onSelectTask(task.id)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onSelectTask(task.id);
            }
          }}
          className="group relative px-2.5 py-1.5 rounded-lg cursor-pointer transition-all duration-150 hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
        >
          <div className="flex items-center gap-2 mb-0.5">
            <span className="flex-1 min-w-0 truncate text-sm font-medium dark:text-claude-darkText text-claude-text">
              {task.title}
            </span>
            <span
              className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${groupTaskStatusBadgeClass(task.status)}`}
            >
              {i18nService.t(groupTaskStatusLabelKey(task.status))}
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary leading-tight">
            <span className="flex-1 min-w-0 truncate">
              {task.chairName ? `${task.chairName} (${i18nService.t('groupTasksChairBadge')})` : ''}
              {task.memberNames.length > 0 ? ` · ${task.memberNames.join(', ')}` : ''}
            </span>
            <span className="shrink-0 whitespace-nowrap">
              {formatGroupTaskTime(task.updatedAt ?? task.createdAt)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
};

export default GroupTaskSidebarList;
