import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { placePopoverAbove, useAnchorMoveWatcher } from '../../utils/anchoredPopover';
import type { ComposerCommand } from './composerCommands';

const COMMAND_PICKER_WIDTH = 320; // w-80
const PICKER_MIN_LIST_HEIGHT = 96;

interface ComposerCommandPickerProps {
  /** Filtered commands to list (host ranks/filters before rendering). */
  commands: ComposerCommand[];
  /** Highlighted (keyboard-active) row index, or -1 for none. */
  highlightIndex: number;
  /** id of the element owning the listbox (aria-activedescendant wiring). */
  listboxId: string;
  onHighlight: (index: number) => void;
  onPick: (command: ComposerCommand) => void;
  /**
   * Anchor element (usually the composer card). When provided the picker
   * floats with position:fixed above it — escaping the sidebar's
   * overflow-hidden clipping in short panels — with a viewport-clamped
   * placement and a scrollable list capped to the space above the anchor.
   */
  anchorRef?: React.RefObject<HTMLElement | null>;
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
  anchorRef,
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  const [placementStyle, setPlacementStyle] = useState<React.CSSProperties | null>(null);
  const [maxListHeight, setMaxListHeight] = useState<number | null>(null);

  const updatePlacement = useCallback(() => {
    if (!anchorRef?.current || !listRef.current) return;
    const anchorRect = anchorRef.current.getBoundingClientRect();
    const pickerRect = listRef.current.getBoundingClientRect();
    const placement = placePopoverAbove(
      anchorRect,
      { width: pickerRect.width, height: pickerRect.height },
      COMMAND_PICKER_WIDTH,
    );
    // Space above the anchor bounds the list so every row stays reachable
    // even when the picker's top edge is clamped into a short viewport.
    const headerAllowance = 28;
    const gap = 8;
    const margin = 8;
    const available = anchorRect.top - gap - margin - headerAllowance;
    setMaxListHeight(Math.max(PICKER_MIN_LIST_HEIGHT, available));
    setPlacementStyle({ position: 'fixed', top: placement.top, left: placement.left, width: placement.width });
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (commands.length === 0 || !anchorRef) return;
    updatePlacement();
    window.addEventListener('resize', updatePlacement);
    window.addEventListener('scroll', updatePlacement, true);
    return () => {
      window.removeEventListener('resize', updatePlacement);
      window.removeEventListener('scroll', updatePlacement, true);
    };
  }, [commands.length, anchorRef, updatePlacement]);

  // Re-place when the anchor MOVES without any window-level event (sidebar
  // width drag, the composer textarea auto-growing).
  useAnchorMoveWatcher(anchorRef ?? { current: null }, commands.length > 0 && Boolean(anchorRef), updatePlacement);

  if (commands.length === 0) return null;

  // Legacy absolute anchoring for hosts that do not pass an anchor.
  const rootClassName = anchorRef
    ? 'fixed z-50 w-80 max-w-full rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg shadow-lg overflow-hidden py-1'
    : 'absolute left-0 bottom-full mb-2 z-50 w-80 max-w-full rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg shadow-lg overflow-hidden py-1';
  const rootStyle = anchorRef ? (placementStyle ?? { visibility: 'hidden' as const }) : undefined;

  return (
    <div
      ref={listRef}
      className={rootClassName}
      style={rootStyle}
      role="listbox"
      id={listboxId}
      aria-label={i18nService.t('composerCommandsTitle')}
    >
      <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
        {i18nService.t('composerCommandsTitle')}
      </div>
      <div className="overflow-y-auto" style={anchorRef && maxListHeight ? { maxHeight: `${maxListHeight}px` } : undefined}>
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
    </div>
  );
};

export default ComposerCommandPicker;
