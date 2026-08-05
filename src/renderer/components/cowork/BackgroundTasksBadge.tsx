import React from 'react';
import { useSelector } from 'react-redux';
import { i18nService } from '../../services/i18n';
import { coworkService } from '../../services/cowork';
import { RootState } from '../../store';

/**
 * Global indicator for running/backgrounded tasks across all sessions.
 * Lives in the sidebar status row; clicking jumps to the session that owns
 * the task (if any). Visible on every mainView, not just the session detail.
 */
const BackgroundTasksBadge: React.FC = () => {
  const tasks = useSelector((state: RootState) => state.cowork.subagentTasks);
  const taskList = Object.values(tasks);

  // A task is "active" when running/pending or explicitly backgrounded.
  const activeTasks = taskList.filter(
    (task) => task.isBackgrounded === true
      || task.status === 'running'
      || task.status === 'pending'
  );

  if (activeTasks.length === 0) return null;

  const taskWithSession = activeTasks.find((task) => task.sessionId);
  const targetSessionId = taskWithSession?.sessionId;

  return (
    <button
      type="button"
      onClick={() => {
        if (targetSessionId) {
          void coworkService.loadSession(targetSessionId);
        }
      }}
      className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-medium transition-colors ${
        targetSessionId
          ? 'text-claude-accent dark:text-claude-accent hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
          : 'dark:text-claude-darkTextSecondary text-claude-textSecondary cursor-default'
      }`}
      title={i18nService.t('coworkBackgroundTasksBadgeTitle')}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-claude-accent animate-pulse" />
      {i18nService.t('coworkBackgroundTasksBadge').replace('{count}', String(activeTasks.length))}
    </button>
  );
};

export default BackgroundTasksBadge;
