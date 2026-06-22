import React from 'react';
import WindowTitleBar from '../../components/window/WindowTitleBar';
import type { BotBrowserSurfaceMode } from './types';

interface BotBrowserModeSwitchProps {
  mode: BotBrowserSurfaceMode;
  isBrowserVisible: boolean;
  onSelectHome: () => void;
  onSelectBrowser: () => void;
}

const tabClass = (active: boolean) => [
  'non-draggable h-6 rounded-md px-2.5 text-[11px] font-medium transition-colors',
  active
    ? 'bg-claude-accent/10 text-claude-accent'
    : 'text-claude-textSecondary hover:bg-claude-surfaceHover hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover dark:hover:text-claude-darkText',
].join(' ');

const BotBrowserModeSwitch: React.FC<BotBrowserModeSwitchProps> = ({
  mode,
  isBrowserVisible,
  onSelectHome,
  onSelectBrowser,
}) => {
  return (
    <div className="draggable flex h-8 shrink-0 items-center justify-between border-b border-claude-border/60 bg-claude-surfaceMuted/80 px-2 dark:border-claude-darkBorder/60 dark:bg-claude-darkSurfaceMuted/80">
      <div className="non-draggable inline-flex items-center gap-1 rounded-lg border border-claude-border/70 bg-claude-bg/70 p-0.5 dark:border-claude-darkBorder/70 dark:bg-claude-darkBg/70">
        <button
          type="button"
          className={tabClass(mode === 'home')}
          onClick={onSelectHome}
        >
          Bot Home
        </button>
        <button
          type="button"
          className={tabClass(mode === 'browser')}
          onClick={onSelectBrowser}
        >
          Bot Browser
        </button>
      </div>
      {isBrowserVisible ? <WindowTitleBar inline /> : <div className="h-8 w-0" />}
    </div>
  );
};

export default BotBrowserModeSwitch;
