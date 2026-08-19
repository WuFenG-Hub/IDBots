import React, { useEffect, useMemo, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../store';
import { coworkService } from '../services/cowork';
import { groupTaskService } from '../services/groupTaskService';
import { i18nService } from '../services/i18n';
import CoworkSessionList from './cowork/CoworkSessionList';
import CoworkSearchModal from './cowork/CoworkSearchModal';
import GroupTaskSidebarList from './groupTasks/GroupTaskSidebarList';
import { selectTask as selectGroupTask } from '../store/slices/groupTasksSlice';
import { MagnifyingGlassIcon, PlusIcon, ClockIcon, CpuChipIcon, ShoppingBagIcon, UserGroupIcon } from '@heroicons/react/24/outline';
import ComposeIcon from './icons/ComposeIcon';
import SidebarToggleIcon from './icons/SidebarToggleIcon';
import { P2PStatusBadge } from './p2p/P2PStatusBadge';
import BackgroundTasksBadge from './cowork/BackgroundTasksBadge';
import { getSidebarPrimaryNavModel } from './sidebar/sidebarNavigation.js';
import BotBrowserModeSwitch from '../features/botBrowser/BotBrowserModeSwitch';
import BotBrowserCoworkPanel from '../features/botBrowser/BotBrowserCoworkPanel';
import { defaultSidebarWidth } from '../utils/sidebarWidth';
import type { BotBrowserSurfaceMode } from '../features/botBrowser/types';
import type { CoworkSessionSummary } from '../types/cowork';

interface SidebarProps {
  onShowSettings: () => void;
  onShowLogin?: () => void;
  activeView: 'cowork' | 'metaapps' | 'skills' | 'scheduledTasks' | 'groupTasks' | 'metabots' | 'gigSquare';
  onShowMetaApps: () => void;
  onShowSkills: () => void;
  onShowCowork: () => void;
  onShowScheduledTasks: () => void;
  onShowGroupTasks: () => void;
  onShowGigSquare: () => void;
  onShowMetabots: () => void;
  onNewChat: () => void;
  mode: BotBrowserSurfaceMode;
  onSelectHome: () => void;
  onSelectBrowser: () => void;
  onNewBrowserTab: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  /** Expanded sidebar width in px (resizable by the user). */
  width?: number;
  /** True while the user is dragging the resize handle; disables the width transition for lag-free dragging. */
  isResizing?: boolean;
  updateBadge?: React.ReactNode;
}

/**
 * Task-record list categories: standard human↔MetaBot chats, A2A MetaBot↔MetaBot
 * chats, and group-task chat channels (session_type = 'group_task', created by
 * the Group Task daemon). The sidebar keeps them in separate tabs so the
 * history list does not mix unrelated conversation kinds.
 */
type TaskRecordTab = 'local' | 'a2a' | 'group';

const TASK_RECORD_TABS: Array<{ id: TaskRecordTab; labelKey: string; emptyKey: string }> = [
  { id: 'local', labelKey: 'coworkTabLocal', emptyKey: 'coworkEmptyLocal' },
  { id: 'a2a', labelKey: 'coworkTabA2A', emptyKey: 'coworkEmptyA2A' },
  { id: 'group', labelKey: 'coworkTabGroup', emptyKey: 'coworkEmptyGroup' },
];

/** localStorage key for the remembered task-record tab. */
const TASK_RECORD_TAB_STORAGE_KEY = 'taskRecordTab';

const loadTaskRecordTab = (): TaskRecordTab => {
  try {
    const stored = window.localStorage.getItem(TASK_RECORD_TAB_STORAGE_KEY);
    if (stored === 'a2a' || stored === 'group') return stored;
  } catch {
    // localStorage unavailable; fall through to the default tab.
  }
  return 'local';
};

const Sidebar: React.FC<SidebarProps> = ({
  onShowSettings,
  activeView,
  onShowMetaApps,
  onShowSkills,
  onShowCowork,
  onShowScheduledTasks,
  onShowGroupTasks,
  onShowGigSquare,
  onShowMetabots,
  onNewChat,
  mode,
  onSelectHome,
  onSelectBrowser,
  onNewBrowserTab,
  isCollapsed,
  onToggleCollapse,
  width = defaultSidebarWidth('home'),
  isResizing = false,
  updateBadge,
}) => {
  const sessions = useSelector((state: RootState) => state.cowork.sessions);
  // Bot Browser panel sessions live in their own surface; keep them out of the
  // home history list and the search modal.
  const homeSessions = useMemo(
    () => sessions.filter((session) => session.sessionType !== 'browser'),
    [sessions],
  );
  const currentSessionId = useSelector((state: RootState) => state.cowork.currentSessionId);
  const unreadSessionIds = useSelector((state: RootState) => state.cowork.unreadSessionIds);
  const groupTasks = useSelector((state: RootState) => state.groupTasks.tasks);
  const selectedGroupTaskId = useSelector((state: RootState) => state.groupTasks.selectedTaskId);
  const scheduledTasks = useSelector((state: RootState) => state.scheduledTask.tasks);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const dispatch = useDispatch();
  // Which task-record category the home history list shows. Persisted across
  // app restarts; the header + tabs stay fixed while only the list scrolls.
  const [taskRecordTab, setTaskRecordTab] = useState<TaskRecordTab>(loadTaskRecordTab);
  const activeTaskRecordTab = TASK_RECORD_TABS.find((tab) => tab.id === taskRecordTab) ?? TASK_RECORD_TABS[0];
  const handleSetTaskRecordTab = (tab: TaskRecordTab) => {
    setTaskRecordTab(tab);
    try {
      window.localStorage.setItem(TASK_RECORD_TAB_STORAGE_KEY, tab);
    } catch {
      // localStorage unavailable; the tab still switches for this session.
    }
  };
  // Sessions grouped by category: local (human↔MetaBot), a2a (MetaBot↔MetaBot),
  // group (group-task chat channels).
  const sessionGroups = useMemo(() => {
    const isLocal = (session: CoworkSessionSummary) =>
      session.sessionType !== 'a2a' && session.sessionType !== 'group_task';
    return {
      local: homeSessions.filter(isLocal),
      a2a: homeSessions.filter((session) => session.sessionType === 'a2a'),
      group: homeSessions.filter((session) => session.sessionType === 'group_task'),
    };
  }, [homeSessions]);
  const tabbedSessions = sessionGroups[taskRecordTab];
  // Per-tab totals and unread counts, shown on the tab buttons.
  const tabStats = useMemo(() => {
    const unreadSet = new Set(unreadSessionIds);
    const unreadOf = (list: CoworkSessionSummary[]) => list.filter((session) => unreadSet.has(session.id)).length;
    return {
      local: { count: sessionGroups.local.length, unread: unreadOf(sessionGroups.local) },
      a2a: { count: sessionGroups.a2a.length, unread: unreadOf(sessionGroups.a2a) },
      group: { count: groupTasks.length, unread: unreadOf(sessionGroups.group) },
    };
  }, [sessionGroups, unreadSessionIds, groupTasks]);
  const isMac = window.electron.platform === 'darwin';
  const hasRunningScheduledTask = scheduledTasks.some(
    (task) => task.enabled && task.state.runningAtMs !== null && task.state.lastStatus === 'running'
  );
  const primaryNavItems = getSidebarPrimaryNavModel({
    t: (key) => i18nService.t(key),
    hasRunningScheduledTask,
  }).filter((item) => !item.hidden);

  useEffect(() => {
    const handleSearch = () => {
      onShowCowork();
      setIsSearchOpen(true);
    };
    window.addEventListener('cowork:shortcut:search', handleSearch);
    return () => {
      window.removeEventListener('cowork:shortcut:search', handleSearch);
    };
  }, [onShowCowork]);

  useEffect(() => {
    if (taskRecordTab !== 'group') return;
    void groupTaskService.loadTasks();
  }, [taskRecordTab]);

  useEffect(() => {
    if (!isCollapsed) return;
    setIsSearchOpen(false);
  }, [isCollapsed]);

  useEffect(() => {
    if (mode === 'browser') {
      setIsSearchOpen(false);
    }
  }, [mode]);

  const handleSelectSession = async (sessionId: string) => {
    onShowCowork();
    await coworkService.loadSession(sessionId);
  };

  const handleDeleteSession = async (sessionId: string) => {
    await coworkService.archiveSession(sessionId);
  };

  const handleTogglePin = async (sessionId: string, pinned: boolean) => {
    await coworkService.setSessionPinned(sessionId, pinned);
  };

  const handleRenameSession = async (sessionId: string, title: string) => {
    await coworkService.renameSession(sessionId, title);
  };

  /** Open a group task from the sidebar: switch to the Group Tasks view and select the task. */
  const handleSelectGroupTask = (taskId: number) => {
    onShowGroupTasks();
    dispatch(selectGroupTask(taskId));
  };

  const handleToggleGroupTaskPin = async (taskId: number, pinned: boolean) => {
    await groupTaskService.setTaskPinned(taskId, pinned);
  };

  const handleRenameGroupTask = async (taskId: number, title: string) => {
    await groupTaskService.renameTask(taskId, title);
  };

  const handleArchiveGroupTask = async (taskId: number) => {
    await groupTaskService.archiveTask(taskId);
  };

  const handlePrimaryNavClick = (itemId: string) => {
    setIsSearchOpen(false);
    if (itemId === 'scheduledTasks') {
      onShowScheduledTasks();
      return;
    }
    if (itemId === 'groupTasks') {
      onShowGroupTasks();
      return;
    }
    if (itemId === 'gigSquare') {
      onShowGigSquare();
      return;
    }
    if (itemId === 'metaapps') {
      onShowMetaApps();
      return;
    }
    if (itemId === 'metabots') {
      onShowMetabots();
    }
  };

  const renderNavIcon = (icon: string) => {
    if (icon === 'clock') return <ClockIcon className="h-4 w-4" />;
    if (icon === 'userGroup') return <UserGroupIcon className="h-4 w-4" />;
    if (icon === 'shoppingBag') return <ShoppingBagIcon className="h-4 w-4 shrink-0" />;
    if (icon === 'squares2x2') return <MagnifyingGlassIcon className="h-4 w-4 opacity-0 absolute pointer-events-none" />;
    return <CpuChipIcon className="h-4 w-4" />;
  };

  const renderNavContent = (item: ReturnType<typeof getSidebarPrimaryNavModel>[number]) => {
    if (item.id === 'scheduledTasks') {
      return (
        <span className="inline-flex min-w-0 items-center gap-2">
          {item.hasIndicator ? (
            <span
              aria-hidden
              className="scheduled-task-running-indicator shrink-0"
            />
          ) : null}
          <span className="truncate">{item.label}</span>
        </span>
      );
    }

    if (item.id === 'gigSquare') {
      return (
        <span className="inline-flex items-center gap-1 min-w-0">
          <span className="truncate">{item.label}</span>
          <span
            className="shrink-0 rounded px-0.5 py-px text-[9px] font-medium leading-none text-claude-textSecondary dark:text-claude-darkTextSecondary border border-claude-border dark:border-claude-darkBorder bg-claude-surfaceMuted dark:bg-claude-darkSurfaceMuted"
            aria-hidden
          >
            {item.badge}
          </span>
        </span>
      );
    }

    return <span className="truncate">{item.label}</span>;
  };

  const renderPrimaryNavIcon = (item: ReturnType<typeof getSidebarPrimaryNavModel>[number]) => {
    if (item.icon === 'squares2x2') {
      return (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
        >
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
      );
    }

    return renderNavIcon(item.icon);
  };

  return (
    <aside
      className={`shrink-0 dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted flex flex-col overflow-hidden ${
        isResizing ? '' : 'sidebar-transition'
      }`}
      style={{ width: isCollapsed ? 0 : width }}
    >
      <div className="pt-3 pb-3">
        <div className="draggable sidebar-header-drag h-8 flex items-center px-3">
          <button
            type="button"
            onClick={onToggleCollapse}
            className={`non-draggable h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors ${isMac ? 'ml-[68px]' : ''}`}
            aria-label={isCollapsed ? i18nService.t('expand') : i18nService.t('collapse')}
          >
            <SidebarToggleIcon className="h-4 w-4" isCollapsed={isCollapsed} />
          </button>
          <div className="ml-auto">
            {updateBadge}
          </div>
        </div>
        <div className="mt-3 px-3">
          <BotBrowserModeSwitch
            mode={mode}
            onSelectHome={onSelectHome}
            onSelectBrowser={onSelectBrowser}
          />
        </div>
        {mode === 'browser' ? (
          <nav aria-label="Bot Browser" className="mt-3 space-y-1 px-3">
            <button
              type="button"
              onClick={onNewBrowserTab}
              className="w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            >
              <PlusIcon className="h-4 w-4" />
              <span>New Tab</span>
            </button>
          </nav>
        ) : (
          <nav aria-label="Bot Home" className="mt-3 space-y-1 px-3">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={onNewChat}
                className="flex-1 inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <ComposeIcon className="h-4 w-4" />
                {i18nService.t('newChat')}
              </button>
              <button
                type="button"
                onClick={() => {
                  onShowCowork();
                  setIsSearchOpen(true);
                }}
                className="shrink-0 h-[36px] w-[36px] inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
                aria-label={i18nService.t('search')}
              >
                <MagnifyingGlassIcon className="h-4 w-4" />
              </button>
            </div>
            {primaryNavItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => handlePrimaryNavClick(item.id)}
                className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                  activeView === item.id
                    ? 'dark:text-claude-darkText text-claude-text dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover'
                    : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                }`}
              >
                {renderPrimaryNavIcon(item)}
                {renderNavContent(item)}
              </button>
            ))}
          </nav>
        )}
      </div>
      {mode === 'home' ? (
        <div className="flex-1 min-h-0 flex flex-col px-2.5 pt-2 mt-1">
          {/* Fixed header + tabs; only the list below scrolls. */}
          <div className="px-3 pb-2 shrink-0">
            <div className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('coworkHistory')}
            </div>
            <div
              role="group"
              aria-label={i18nService.t('coworkHistory')}
              className="grid w-full grid-cols-3 gap-1 rounded-lg border border-claude-border/70 bg-claude-bg/80 p-1 mt-2 dark:border-claude-darkBorder/70 dark:bg-claude-darkBg/80"
            >
              {TASK_RECORD_TABS.map((tab, index) => {
                const isActive = taskRecordTab === tab.id;
                const stats = tabStats[tab.id];
                // Per-tab item count is only shown on hover, as a tip under the
                // tab; the label itself stays clean. Edge tabs align the tip to
                // the outer edge so it never clips at the sidebar boundary.
                const countTipKey = tab.id === 'group' ? 'coworkTabCountGroup' : 'coworkTabCountChats';
                const countTip = i18nService.t(countTipKey).replace('{count}', String(stats.count));
                const tooltipAlign = index === 0
                  ? 'left-0'
                  : index === TASK_RECORD_TABS.length - 1
                    ? 'right-0'
                    : 'left-1/2 -translate-x-1/2';
                return (
                  <button
                    key={tab.id}
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => handleSetTaskRecordTab(tab.id)}
                    className={`non-draggable group relative inline-flex h-7 min-w-0 items-center justify-center gap-1 rounded-md px-1 text-xs font-medium leading-none transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 ${
                      isActive
                        ? 'btn-idchat-primary-filled still'
                        : 'text-claude-textSecondary hover:bg-claude-surfaceHover/70 hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover/70 dark:hover:text-claude-darkText'
                    }`}
                  >
                    {stats.unread > 0 && (
                      <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" aria-hidden />
                    )}
                    <span className="truncate">{i18nService.t(tab.labelKey)}</span>
                    <span
                      className={`pointer-events-none absolute top-full mt-1.5 z-50 ${tooltipAlign} whitespace-nowrap rounded-md border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface px-2 py-1 text-[11px] font-normal leading-none dark:text-claude-darkText text-claude-text shadow-lg opacity-0 transition-opacity duration-150 group-hover:opacity-100`}
                      aria-hidden
                    >
                      {countTip}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          {/* Scrollable list area */}
          <div className="flex-1 min-h-0 overflow-y-auto pb-4">
            {taskRecordTab === 'group' ? (
              <GroupTaskSidebarList
                tasks={groupTasks}
                selectedTaskId={selectedGroupTaskId}
                onSelectTask={handleSelectGroupTask}
                onTogglePin={handleToggleGroupTaskPin}
                onRename={handleRenameGroupTask}
                onArchive={handleArchiveGroupTask}
                emptyText={i18nService.t(activeTaskRecordTab.emptyKey)}
              />
            ) : (
              <CoworkSessionList
                sessions={tabbedSessions}
                currentSessionId={currentSessionId}
                onSelectSession={handleSelectSession}
                onDeleteSession={handleDeleteSession}
                onTogglePin={handleTogglePin}
                onRenameSession={handleRenameSession}
                emptyText={i18nService.t(activeTaskRecordTab.emptyKey)}
              />
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 px-2.5 pb-3 pt-2 mt-1 flex flex-col">
          <BotBrowserCoworkPanel onShowSkills={onShowSkills} />
        </div>
      )}
      <CoworkSearchModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        sessions={homeSessions}
        scopedSessions={tabbedSessions}
        scopeLabel={i18nService.t(activeTaskRecordTab.labelKey)}
        currentSessionId={currentSessionId}
        onSelectSession={handleSelectSession}
        onDeleteSession={handleDeleteSession}
        onTogglePin={handleTogglePin}
        onRenameSession={handleRenameSession}
      />
      <div className="px-3 pb-3 pt-1">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => onShowSettings()}
            className="inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            aria-label={i18nService.t('settings')}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
              <path d="M14 17H5" />
              <path d="M19 7h-9" />
              <circle cx="17" cy="17" r="3" />
              <circle cx="7" cy="7" r="3" />
            </svg>
            {i18nService.t('settings')}
          </button>
          <BackgroundTasksBadge />
          <P2PStatusBadge />
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
