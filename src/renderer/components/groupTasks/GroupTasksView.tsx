import React, { useEffect, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../../store';
import { selectTask } from '../../store/slices/groupTasksSlice';
import { groupTaskService } from '../../services/groupTaskService';
import { i18nService } from '../../services/i18n';
import type { GroupTaskListTab, GroupTaskSummary } from '../../types/groupTask';
import type { OpenTeamCollabSummary } from '../../types/openTeamCollab';
import GroupTaskDetailView from './GroupTaskDetailView';
import OpenTeamCollabsSection from './OpenTeamCollabsSection';
import OpenTeamCollabDetailView from './OpenTeamCollabDetailView';
import {
  filterGroupTasksByTab,
  formatGroupTaskRelativeTime,
  groupTaskStatusBadgeClass,
  groupTaskStatusLabelKey,
  shortGroupId,
} from './groupTaskUtils';
import GroupTaskItemMenu, { PushPinIcon } from './GroupTaskItemMenu';
import {
  GroupTaskHoverCard,
  GroupTaskMemberAvatarRow,
  groupTaskMemberPreviews,
  relativeTimeTitle,
} from './GroupTaskListMeta';
import { UserGroupIcon, EllipsisHorizontalIcon } from '@heroicons/react/24/outline';
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

const FILTER_TABS: Array<{ id: GroupTaskListTab; labelKey: string }> = [
  { id: 'active', labelKey: 'groupTasksFilterActive' },
  { id: 'done', labelKey: 'groupTasksFilterDone' },
  { id: 'cancelled', labelKey: 'groupTasksFilterCancelled' },
  { id: 'all', labelKey: 'groupTasksFilterAll' },
];

export { groupTaskStatusLabelKey } from './groupTaskUtils';

interface GroupTaskListItemProps {
  task: GroupTaskSummary;
  onClick: () => void;
  onTogglePin: (pinned: boolean) => void;
  onRename: (title: string) => void;
  onArchive: () => void;
}

const GroupTaskListItem: React.FC<GroupTaskListItemProps> = ({
  task,
  onClick,
  onTogglePin,
  onRename,
  onArchive,
}) => {
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const displayTitle = task.displayName?.trim() || task.title;
  const actionLabel = i18nService.t('coworkSessionActions');
  const members = groupTaskMemberPreviews(task);
  const relative = formatGroupTaskRelativeTime(task.updatedAt ?? task.createdAt);

  const handleCopyGroupId = () => {
    const value = task.groupId?.trim() || `#${task.id}`;
    try {
      const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null;
      if (clipboard) void clipboard.writeText(value);
    } catch {
      // Ignore clipboard failures; the menu should still close.
    }
  };

  return (
    <GroupTaskItemMenu
      task={task}
      onTogglePin={onTogglePin}
      onRename={onRename}
      onArchive={onArchive}
      onCopyGroupId={handleCopyGroupId}
    >
      {(api) => (
        <div
          className="group relative px-4 py-3 border-b dark:border-claude-darkBorder/50 border-claude-border/50 hover:bg-claude-surfaceHover/50 dark:hover:bg-claude-darkSurfaceHover/50 cursor-pointer transition-colors"
          onClick={() => {
            if (api.isRenaming) return;
            api.closeMenu();
            onClick();
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            api.openMenuAt(event.clientX, event.clientY);
          }}
          onMouseEnter={(event) => {
            if (api.isRenaming) return;
            setHoverRect(event.currentTarget.getBoundingClientRect());
          }}
          onMouseLeave={() => setHoverRect(null)}
        >
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  #{task.id}
                </span>
                {api.isRenaming ? (
                  <input
                    ref={api.renameInputRef}
                    value={api.renameValue}
                    onChange={(event) => api.onRenameInputChange(event.target.value)}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={api.onRenameInputKeyDown}
                    onBlur={api.onRenameInputBlur}
                    className="flex-1 min-w-0 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg px-2 py-1 text-sm font-medium dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent"
                  />
                ) : (
                  <span className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">
                    {displayTitle}
                  </span>
                )}
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${groupTaskStatusBadgeClass(task.status)}`}>
                  {i18nService.t(groupTaskStatusLabelKey(task.status))}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                <GroupTaskMemberAvatarRow members={members} />
                {task.groupId ? (
                  <span className="shrink-0 truncate">{shortGroupId(task.groupId)}</span>
                ) : null}
              </div>
            </div>
            <div className="shrink-0 text-right text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {relative.compact ? (
                <div title={relativeTimeTitle(relative.unit, relative.count)}>
                  {relative.compact}
                </div>
              ) : null}
            </div>
          </div>

          {/* Actions - absolutely positioned overlay */}
          <div
            className={`absolute right-3 top-3 transition-opacity ${
              api.isRenaming
                ? 'opacity-0 pointer-events-none'
                : task.pinned
                  ? 'opacity-100'
                  : 'opacity-0 group-hover:opacity-100'
            }`}
          >
            <button
              ref={api.actionButtonRef}
              onClick={api.openMenu}
              className="p-1.5 rounded-lg bg-claude-surfaceMuted dark:bg-claude-darkSurfaceMuted dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurface hover:bg-claude-surface transition-colors"
              aria-label={actionLabel}
            >
              {task.pinned ? (
                <span className="relative block h-4 w-4">
                  <PushPinIcon className="h-4 w-4 transition-opacity duration-150 group-hover:opacity-0" />
                  <EllipsisHorizontalIcon className="absolute inset-0 h-4 w-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
                </span>
              ) : (
                <EllipsisHorizontalIcon className="h-4 w-4" />
              )}
            </button>
          </div>

          {api.renderMenu()}
          {api.renderArchiveConfirm()}
          {!api.isRenaming ? <GroupTaskHoverCard task={task} anchorRect={hoverRect} /> : null}
        </div>
      )}
    </GroupTaskItemMenu>
  );
};

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
  const [selectedCollab, setSelectedCollab] = useState<OpenTeamCollabSummary | null>(null);

  useEffect(() => {
    void groupTaskService.loadTasks();
  }, []);

  const filteredTasks = filterGroupTasksByTab(tasks, activeTab);

  if (selectedCollab) {
    return (
      <OpenTeamCollabDetailView
        key={selectedCollab.id}
        collab={selectedCollab}
        isSidebarCollapsed={isSidebarCollapsed}
        onToggleSidebar={onToggleSidebar}
        onNewChat={onNewChat}
        updateBadge={updateBadge}
        onBack={() => setSelectedCollab(null)}
      />
    );
  }

  if (selectedTaskId != null) {
    return (
      <GroupTaskDetailView
        key={selectedTaskId}
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
              onTogglePin={(pinned) => void groupTaskService.setTaskPinned(task.id, pinned)}
              onRename={(title) => void groupTaskService.renameTask(task.id, title)}
              onArchive={() => void groupTaskService.archiveTask(task.id)}
            />
          ))
        )}
        {/* OpenTeam invitee-side traceability: external group tasks our bots joined */}
        <OpenTeamCollabsSection onOpenCollab={setSelectedCollab} />
      </div>
    </div>
  );
};

export default GroupTasksView;
