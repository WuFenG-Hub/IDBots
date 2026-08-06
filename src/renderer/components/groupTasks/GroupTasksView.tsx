import React, { useEffect, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../../store';
import { selectTask } from '../../store/slices/groupTasksSlice';
import { groupTaskService } from '../../services/groupTaskService';
import { i18nService } from '../../services/i18n';
import type { GroupTaskListTab, GroupTaskSummary } from '../../types/groupTask';
import GroupTaskDetailView from './GroupTaskDetailView';
import {
  filterGroupTasksByTab,
  formatGroupTaskTime,
  groupTaskStatusBadgeClass,
} from './groupTaskUtils';
import { UserGroupIcon } from '@heroicons/react/24/outline';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';

interface GroupTasksViewProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  onNewGroupTask?: () => void;
  updateBadge?: React.ReactNode;
}

const STATUS_LABEL_KEYS: Record<string, string> = {
  planning: 'groupTasksStatusPlanning',
  executing: 'groupTasksStatusExecuting',
  review: 'groupTasksStatusReview',
  done: 'groupTasksStatusDone',
  cancelled: 'groupTasksStatusCancelled',
};

export function groupTaskStatusLabelKey(status: string): string {
  return STATUS_LABEL_KEYS[status] ?? 'groupTasksStatusPlanning';
}

const FILTER_TABS: Array<{ id: GroupTaskListTab; labelKey: string }> = [
  { id: 'active', labelKey: 'groupTasksFilterActive' },
  { id: 'done', labelKey: 'groupTasksFilterDone' },
  { id: 'cancelled', labelKey: 'groupTasksFilterCancelled' },
  { id: 'all', labelKey: 'groupTasksFilterAll' },
];

const GroupTaskListItem: React.FC<{ task: GroupTaskSummary; onClick: () => void }> = ({ task, onClick }) => (
  <div
    className="px-4 py-3 border-b dark:border-claude-darkBorder/50 border-claude-border/50 hover:bg-claude-surfaceHover/50 dark:hover:bg-claude-darkSurfaceHover/50 cursor-pointer transition-colors"
    onClick={onClick}
  >
    <div className="flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">
            {task.title}
          </span>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${groupTaskStatusBadgeClass(task.status)}`}>
            {i18nService.t(groupTaskStatusLabelKey(task.status))}
          </span>
        </div>
        <div className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
          {task.chairName ? `${task.chairName} (${i18nService.t('groupTasksChairBadge')})` : ''}
          {task.memberNames.length > 0 ? ` · ${task.memberNames.join(', ')}` : ''}
        </div>
      </div>
      <div className="shrink-0 text-right text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
        <div>{task.memberCount} {i18nService.t('groupTasksMembers')}</div>
        <div className="mt-0.5">{formatGroupTaskTime(task.updatedAt ?? task.createdAt)}</div>
      </div>
    </div>
  </div>
);

const GroupTasksView: React.FC<GroupTasksViewProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  onNewGroupTask,
  updateBadge,
}) => {
  const dispatch = useDispatch();
  const isMac = window.electron.platform === 'darwin';
  const tasks = useSelector((state: RootState) => state.groupTasks.tasks);
  const loading = useSelector((state: RootState) => state.groupTasks.loading);
  const selectedTaskId = useSelector((state: RootState) => state.groupTasks.selectedTaskId);
  const [activeTab, setActiveTab] = useState<GroupTaskListTab>('active');

  useEffect(() => {
    void groupTaskService.loadTasks();
  }, []);

  const filteredTasks = filterGroupTasksByTab(tasks, activeTab);

  if (selectedTaskId != null) {
    return (
      <GroupTaskDetailView
        taskId={selectedTaskId}
        isSidebarCollapsed={isSidebarCollapsed}
        onToggleSidebar={onToggleSidebar}
        onNewChat={onNewChat}
        updateBadge={updateBadge}
        onBack={() => dispatch(selectTask(null))}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="draggable flex h-12 items-center justify-between px-4 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
        <div className="flex items-center space-x-3 h-8">
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
          <h1 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
            {i18nService.t('groupTasksTitle')}
          </h1>
        </div>
        <WindowTitleBar inline />
      </div>

      {/* Filter tabs + New Group Task button */}
      <div className="flex items-center justify-between border-b dark:border-claude-darkBorder border-claude-border px-4 shrink-0">
        <div className="flex">
          {FILTER_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
                activeTab === tab.id
                  ? 'dark:text-claude-darkText text-claude-text'
                  : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
              }`}
            >
              {i18nService.t(tab.labelKey)}
              {activeTab === tab.id && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand rounded-t" />
              )}
            </button>
          ))}
        </div>
        {onNewGroupTask && (
          <button
            type="button"
            onClick={onNewGroupTask}
            className="btn-idchat-primary-filled px-3 py-1 text-sm font-medium"
          >
            {i18nService.t('groupTasksNewTask')}
          </button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {loading && tasks.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <div className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('loading')}
            </div>
          </div>
        ) : filteredTasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-6">
            <UserGroupIcon className="h-12 w-12 dark:text-claude-darkTextSecondary/40 text-claude-textSecondary/40 mb-4" />
            <p className="text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
              {i18nService.t('groupTasksEmptyState')}
            </p>
            <p className="text-xs dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70 text-center">
              {i18nService.t('groupTasksEmptyHint')}
            </p>
          </div>
        ) : (
          filteredTasks.map((task) => (
            <GroupTaskListItem
              key={task.id}
              task={task}
              onClick={() => dispatch(selectTask(task.id))}
            />
          ))
        )}
      </div>
    </div>
  );
};

export default GroupTasksView;
