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
  'non-draggable inline-flex h-7 min-w-[96px] items-center justify-center rounded-full px-3 text-[12px] font-medium leading-none transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40',
  active
    ? 'bg-claude-accentMuted text-claude-accent shadow-sm'
    : 'text-claude-textSecondary hover:bg-claude-surfaceHover/70 hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover/70 dark:hover:text-claude-darkText',
].join(' ');

const BotBrowserModeSwitch: React.FC<BotBrowserModeSwitchProps> = ({
  mode,
  isBrowserVisible,
  onSelectHome,
  onSelectBrowser,
}) => {
  return (
    <div
      data-slot="bot-browser-mode-bar"
      className="draggable relative flex h-11 shrink-0 items-center justify-center border-b border-claude-border/60 bg-claude-surfaceMuted/85 px-3 dark:border-claude-darkBorder/60 dark:bg-claude-darkSurfaceMuted/85"
    >
      <div
        data-slot="bot-browser-mode-segments"
        role="group"
        aria-label="Bot Browser display mode"
        className="non-draggable inline-flex items-center gap-0.5 rounded-full border border-claude-border/70 bg-claude-bg/80 p-0.5 shadow-sm dark:border-claude-darkBorder/70 dark:bg-claude-darkBg/80"
      >
        <button
          type="button"
          aria-pressed={mode === 'home'}
          className={tabClass(mode === 'home')}
          onClick={onSelectHome}
        >
          Bot Home
        </button>
        <button
          type="button"
          aria-pressed={mode === 'browser'}
          className={tabClass(mode === 'browser')}
          onClick={onSelectBrowser}
        >
          Bot Browser
        </button>
      </div>
      <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center">
        {isBrowserVisible ? <WindowTitleBar inline /> : <div aria-hidden="true" className="h-8 w-0" />}
      </div>
    </div>
  );
};

export default BotBrowserModeSwitch;
