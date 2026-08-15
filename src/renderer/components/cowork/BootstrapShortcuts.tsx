import React from 'react';
import { ChatBubbleLeftRightIcon, SparklesIcon } from '@heroicons/react/24/outline';

interface BootstrapShortcutsProps {
  greetLabel: string;
  createLabel: string;
  onGreet: () => void;
  onCreateBot: () => void;
}

const BUTTON_CLASS = 'flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-all duration-200 ease-out dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover hover:border-claude-accent/40';
const ICON_CLASS = 'w-4 h-4 dark:text-claude-darkTextSecondary text-claude-textSecondary';

/**
 * First-run (bootstrap) shortcut pair shown instead of the full QuickActionBar
 * while the machine has no Twin Bot yet: greet the Welcome Bot, or ask for the
 * first Bot to be created. Both fill the composer (without sending) so the
 * user can review the text before submitting, matching the quick-action
 * prompt behavior.
 */
const BootstrapShortcuts: React.FC<BootstrapShortcutsProps> = ({
  greetLabel,
  createLabel,
  onGreet,
  onCreateBot,
}) => (
  <div className="flex flex-wrap items-center justify-center gap-2.5">
    <button type="button" onClick={onGreet} className={BUTTON_CLASS}>
      <ChatBubbleLeftRightIcon className={ICON_CLASS} />
      <span>{greetLabel}</span>
    </button>
    <button type="button" onClick={onCreateBot} className={BUTTON_CLASS}>
      <SparklesIcon className={ICON_CLASS} />
      <span>{createLabel}</span>
    </button>
  </div>
);

export default BootstrapShortcuts;
