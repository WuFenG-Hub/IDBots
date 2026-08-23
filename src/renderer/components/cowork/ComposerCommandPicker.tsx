import React from 'react';
import { i18nService } from '../../services/i18n';
import type { ComposerCommand } from './composerCommands';

interface ComposerCommandPickerProps {
  /** Filtered commands to list (host ranks/filters before rendering). */
  commands: ComposerCommand[];
  /** Highlighted (keyboard-active) row index, or -1 for none. */
  highlightIndex: number;
  /** id of the element owning the listbox (aria-activedescendant wiring). */
  listboxId: string;
  onHighlight: (index: number) => void;
  onPick: (command: ComposerCommand) => void;
}

/**
 * Slash-command listbox for the composer, ported from the DSH web UI's
 * command menu: rows of `/name` + description, keyboard-highlighted, picked
 * by mouse without stealing the textarea's focus (combobox pattern).
 */
const ComposerCommandPicker: React.FC<ComposerCommandPickerProps> = ({
  commands,
  highlightIndex,
  listboxId,
  onHighlight,
  onPick,
}) => {
  if (commands.length === 0) return null;
  return (
    <div
      className="absolute left-0 bottom-full mb-2 z-50 w-80 max-w-full rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg shadow-lg overflow-hidden py-1"
      role="listbox"
      id={listboxId}
      aria-label={i18nService.t('composerCommandsTitle')}
    >
      <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
        {i18nService.t('composerCommandsTitle')}
      </div>
      {commands.map((command, index) => (
        <button
          key={command.name}
          id={`${listboxId}-option-${command.name}`}
          type="button"
          role="option"
          aria-selected={index === highlightIndex}
          onMouseDown={(event) => {
            // Keep the caret in the textarea (combobox pattern).
            event.preventDefault();
          }}
          onMouseEnter={() => onHighlight(index)}
          onClick={() => onPick(command)}
          className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
            index === highlightIndex
              ? 'dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset'
              : 'hover:dark:bg-claude-darkSurfaceInset/60 hover:bg-claude-surfaceInset/60'
          }`}
        >
          <span className="font-medium text-amber-600 dark:text-amber-400 flex-shrink-0">
            /{command.name}
          </span>
          <span className="truncate dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {command.description}
          </span>
        </button>
      ))}
    </div>
  );
};

export default ComposerCommandPicker;
