import React, { useCallback, useEffect, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../../store';
import { setViewMode, selectTask } from '../../store/slices/scheduledTaskSlice';
import { scheduledTaskService } from '../../services/scheduledTask';
import { i18nService } from '../../services/i18n';
import TaskList from './TaskList';
import TaskForm from './TaskForm';
import TaskDetail from './TaskDetail';
import AllRunsHistory from './AllRunsHistory';
import DeleteConfirmModal from './DeleteConfirmModal';
import SdkCronMirrorList from './SdkCronMirrorList';
import SdkCronTaskForm from './SdkCronTaskForm';
import type { SdkCronMirror } from '../../types/scheduledTask';
import { ArrowLeftIcon } from '@heroicons/react/24/outline';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';

interface ScheduledTasksViewProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

type TabType = 'tasks' | 'history' | 'sdk';

const ScheduledTasksView: React.FC<ScheduledTasksViewProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
}) => {
  const dispatch = useDispatch();
  const isMac = window.electron.platform === 'darwin';
  const viewMode = useSelector((state: RootState) => state.scheduledTask.viewMode);
  const selectedTaskId = useSelector((state: RootState) => state.scheduledTask.selectedTaskId);
  const tasks = useSelector((state: RootState) => state.scheduledTask.tasks);
  const selectedTask = selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) ?? null : null;
  const [activeTab, setActiveTab] = useState<TabType>('tasks');
  const [deleteTaskInfo, setDeleteTaskInfo] = useState<{ id: string; name: string } | null>(null);
  // SDK 定时任务的列表/新建/编辑子视图（独立于旧任务 viewMode）。
  const [sdkView, setSdkView] = useState<'list' | 'create' | 'edit'>('list');
  const [editingMirror, setEditingMirror] = useState<SdkCronMirror | null>(null);

  const handleRequestDelete = useCallback((taskId: string, taskName: string) => {
    setDeleteTaskInfo({ id: taskId, name: taskName });
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTaskInfo) return;
    const taskId = deleteTaskInfo.id;
    setDeleteTaskInfo(null);
    await scheduledTaskService.deleteTask(taskId);
    // If we were viewing this task's detail, go back to list
    if (selectedTaskId === taskId) {
      dispatch(selectTask(null));
      dispatch(setViewMode('list'));
    }
  }, [deleteTaskInfo, selectedTaskId, dispatch]);

  const handleCancelDelete = useCallback(() => {
    setDeleteTaskInfo(null);
  }, []);

  useEffect(() => {
    scheduledTaskService.loadTasks();
  }, []);

  const handleBackToList = () => {
    dispatch(selectTask(null));
    dispatch(setViewMode('list'));
  };

  const handleTabChange = (tab: TabType) => {
    setActiveTab(tab);
    if (tab === 'tasks') {
      dispatch(selectTask(null));
      dispatch(setViewMode('list'));
    } else if (tab === 'sdk') {
      // 切到 SDK tab 时回到列表态（退出新建/编辑子视图）。
      setSdkView('list');
      setEditingMirror(null);
    }
  };

  const handleSdkEdit = (m: SdkCronMirror) => {
    setEditingMirror(m);
    setSdkView('edit');
  };

  const handleSdkBackToList = () => {
    setSdkView('list');
    setEditingMirror(null);
  };

  // Show tabs only in list view (not in create/edit/detail sub-views, including sdk sub-views).
  const showTabs =
    viewMode === 'list' &&
    !selectedTaskId &&
    !(activeTab === 'sdk' && (sdkView === 'create' || sdkView === 'edit'));

  // 任意子视图（旧任务 detail/edit/create，或 SDK 新建/编辑）都显示返回按钮。
  const showBackButton = !showTabs;

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
          {showBackButton && (
            <button
              onClick={() => {
                if (activeTab === 'sdk') handleSdkBackToList();
                else handleBackToList();
              }}
              className="non-draggable p-2 rounded-lg dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary transition-colors"
              aria-label={i18nService.t('back')}
            >
              <ArrowLeftIcon className="h-5 w-5" />
            </button>
          )}
          <h1 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
            {i18nService.t('scheduledTasksTitle')}
          </h1>
        </div>
        <WindowTitleBar inline />
      </div>

      {/* Tabs + New Task button */}
      {showTabs && (
        <div className="flex items-center justify-between border-b dark:border-claude-darkBorder border-claude-border px-4 shrink-0">
          <div className="flex">
            <button
              type="button"
              onClick={() => handleTabChange('tasks')}
              className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
                activeTab === 'tasks'
                  ? 'dark:text-claude-darkText text-claude-text'
                  : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
              }`}
            >
              {i18nService.t('scheduledTasksTabTasks')}
              {activeTab === 'tasks' && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand rounded-t" />
              )}
            </button>
            <button
              type="button"
              onClick={() => handleTabChange('sdk')}
              className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
                activeTab === 'sdk'
                  ? 'dark:text-claude-darkText text-claude-text'
                  : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
              }`}
            >
              {i18nService.t('scheduledTasksSdkTitle')}
              {activeTab === 'sdk' && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand rounded-t" />
              )}
            </button>
            <button
              type="button"
              onClick={() => handleTabChange('history')}
              className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
                activeTab === 'history'
                  ? 'dark:text-claude-darkText text-claude-text'
                  : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
              }`}
            >
              {i18nService.t('scheduledTasksTabHistory')}
              {activeTab === 'history' && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand rounded-t" />
              )}
            </button>
          </div>
          {activeTab === 'tasks' && (
            <button
              type="button"
              onClick={() => dispatch(setViewMode('create'))}
              className="btn-idchat-primary-filled px-3 py-1 text-sm font-medium"
            >
              {i18nService.t('scheduledTasksNewTask')}
            </button>
          )}
          {activeTab === 'sdk' && (
            <button
              type="button"
              onClick={() => {
                setEditingMirror(null);
                setSdkView('create');
              }}
              className="btn-idchat-primary-filled px-3 py-1 text-sm font-medium"
            >
              {i18nService.t('scheduledTasksNewTask')}
            </button>
          )}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {showTabs && activeTab === 'history' ? (
          <AllRunsHistory />
        ) : showTabs && activeTab === 'sdk' ? (
          <SdkCronMirrorList onEdit={handleSdkEdit} />
        ) : activeTab === 'sdk' && (sdkView === 'create' || sdkView === 'edit') ? (
          <SdkCronTaskForm
            mode={sdkView === 'edit' ? 'edit' : 'create'}
            mirror={sdkView === 'edit' ? editingMirror ?? undefined : undefined}
            onCancel={handleSdkBackToList}
            onSaved={handleSdkBackToList}
          />
        ) : (
          <>
            {viewMode === 'list' && <TaskList onRequestDelete={handleRequestDelete} />}
            {viewMode === 'create' && (
              <TaskForm
                mode="create"
                onCancel={handleBackToList}
                onSaved={handleBackToList}
              />
            )}
            {viewMode === 'edit' && selectedTask && (
              <TaskForm
                mode="edit"
                task={selectedTask}
                onCancel={() => dispatch(setViewMode('detail'))}
                onSaved={() => dispatch(setViewMode('detail'))}
              />
            )}
            {viewMode === 'detail' && selectedTask && (
              <TaskDetail task={selectedTask} onRequestDelete={handleRequestDelete} />
            )}
          </>
        )}
      </div>

      {/* Delete confirmation modal */}
      {deleteTaskInfo && (
        <DeleteConfirmModal
          taskName={deleteTaskInfo.name}
          onConfirm={handleConfirmDelete}
          onCancel={handleCancelDelete}
        />
      )}
    </div>
  );
};

export default ScheduledTasksView;
