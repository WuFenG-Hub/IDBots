import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../store';
import { coworkService } from '../services/cowork';
import { i18nService } from '../services/i18n';
import CoworkSessionList from './cowork/CoworkSessionList';
import CoworkSearchModal from './cowork/CoworkSearchModal';
import { MagnifyingGlassIcon, PlusIcon, ClockIcon, CpuChipIcon, ShoppingBagIcon } from '@heroicons/react/24/outline';
import ComposeIcon from './icons/ComposeIcon';
import SidebarToggleIcon from './icons/SidebarToggleIcon';
import { P2PStatusBadge } from './p2p/P2PStatusBadge';
import { getSidebarPrimaryNavModel } from './sidebar/sidebarNavigation.js';
import BotBrowserModeSwitch from '../features/botBrowser/BotBrowserModeSwitch';
import BotBrowserCoworkPanel from '../features/botBrowser/BotBrowserCoworkPanel';
import { defaultSidebarWidth } from '../utils/sidebarWidth';
import type { BotBrowserSurfaceMode } from '../features/botBrowser/types';

interface SidebarProps {
  onShowSettings: () => void;
  onShowLogin?: () => void;
  activeView: 'cowork' | 'metaapps' | 'skills' | 'scheduledTasks' | 'metabots' | 'gigSquare';
  onShowMetaApps: () => void;
  onShowSkills: () => void;
  onShowCowork: () => void;
  onShowScheduledTasks: () => void;
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

const Sidebar: React.FC<SidebarProps> = ({
  onShowSettings,
  activeView,
  onShowMetaApps,
  onShowSkills,
  onShowCowork,
  onShowScheduledTasks,
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
  const homeSessions = sessions.filter((session) => session.sessionType !== 'browser');
  const currentSessionId = useSelector((state: RootState) => state.cowork.currentSessionId);
  const scheduledTasks = useSelector((state: RootState) => state.scheduledTask.tasks);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const isMac = window.electron.platform === 'darwin';
  const hasRunningScheduledTask = scheduledTasks.some(
    (task) => task.enabled && task.state.runningAtMs !== null && task.state.lastStatus === 'running'
  );
  const primaryNavItems = getSidebarPrimaryNavModel({
    t: (key) => i18nService.t(key),
    hasRunningScheduledTask,
  });

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

  const handlePrimaryNavClick = (itemId: string) => {
    setIsSearchOpen(false);
    if (itemId === 'scheduledTasks') {
      onShowScheduledTasks();
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
        <div className="flex-1 overflow-y-auto px-2.5 pb-4 pt-2 mt-1">
          <div className="px-3 pb-2 text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('coworkHistory')}
          </div>
          <CoworkSessionList
            sessions={homeSessions}
            currentSessionId={currentSessionId}
            onSelectSession={handleSelectSession}
            onDeleteSession={handleDeleteSession}
            onTogglePin={handleTogglePin}
            onRenameSession={handleRenameSession}
          />
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
          <P2PStatusBadge />
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
