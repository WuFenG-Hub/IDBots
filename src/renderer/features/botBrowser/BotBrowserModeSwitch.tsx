import React from 'react';
import type { BotBrowserSurfaceMode } from './types';

interface BotBrowserModeSwitchProps {
  mode: BotBrowserSurfaceMode;
  onSelectHome: () => void;
  onSelectBrowser: () => void;
}

const tabClass = (active: boolean) => [
  'non-draggable inline-flex h-8 min-w-0 items-center justify-center rounded-md px-2 text-xs font-medium leading-none transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40',
  active
    ? 'btn-idchat-primary-filled still'
    : 'text-claude-textSecondary hover:bg-claude-surfaceHover/70 hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover/70 dark:hover:text-claude-darkText',
].join(' ');

const BotBrowserModeSwitch: React.FC<BotBrowserModeSwitchProps> = ({
  mode,
  onSelectHome,
  onSelectBrowser,
}) => {
  return (
    <div
      data-slot="bot-browser-mode-bar"
      className="w-full"
    >
      <div
        data-slot="bot-browser-mode-segments"
        role="group"
        aria-label="Bot Internet display mode"
        className="non-draggable grid w-full grid-cols-2 gap-1 rounded-lg border border-claude-border/70 bg-claude-bg/80 p-1 dark:border-claude-darkBorder/70 dark:bg-claude-darkBg/80"
      >
        <button
          type="button"
          aria-pressed={mode === 'browser'}
          className={tabClass(mode === 'browser')}
          onClick={onSelectBrowser}
        >
          Bot Internet
        </button>
        <button
          type="button"
          aria-pressed={mode === 'home'}
          className={tabClass(mode === 'home')}
          onClick={onSelectHome}
        >
          Bot Home
        </button>
      </div>
    </div>
  );
};

export default BotBrowserModeSwitch;
