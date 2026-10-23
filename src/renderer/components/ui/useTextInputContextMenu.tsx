/**
 * Right-click Cut/Copy/Paste/Select-All menu for plain text inputs.
 *
 * Electron ships no default editing context menu, so a keyboard with broken
 * copy/paste shortcuts leaves form fields (e.g. the API-key and Base URL
 * inputs in Settings > Models) unusable for paste. This hook gives any
 * <input>/<textarea> the same menu the cowork composer already had: attach
 * the returned `onContextMenu` to the element and render `menu` anywhere
 * (it is position:fixed).
 *
 * Paste/cut write through `setRangeText` + a bubbled `input` event so React's
 * controlled-input onChange picks the change up — the same trick the cowork
 * composer's `applyTextareaChange` relies on.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { i18nService } from '../../services/i18n';

type TextInputElement = HTMLInputElement | HTMLTextAreaElement;

// Menu geometry mirrors the cowork composer's context menu.
const TEXT_INPUT_MENU_WIDTH = 176;
const TEXT_INPUT_MENU_HEIGHT = 168;
const TEXT_INPUT_MENU_PADDING = 8;

export interface TextInputContextMenuDerivedState {
  canCut: boolean;
  canCopy: boolean;
  canSelectAll: boolean;
}

export const deriveTextInputContextMenuState = ({
  valueLength,
  selectionStart,
  selectionEnd,
  disabled,
}: {
  valueLength: number;
  selectionStart: number;
  selectionEnd: number;
  disabled: boolean;
}): TextInputContextMenuDerivedState => {
  const hasSelection = selectionStart >= 0 && selectionEnd > selectionStart;
  return {
    canCut: !disabled && hasSelection,
    canCopy: hasSelection,
    canSelectAll: !disabled && valueLength > 0,
  };
};

const TextInputContextMenuItem: React.FC<{
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
}> = ({ label, shortcut, disabled = false, onClick }) => (
  <button
    type="button"
    role="menuitem"
    onClick={onClick}
    disabled={disabled}
    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-40 disabled:hover:bg-transparent disabled:dark:hover:bg-transparent disabled:cursor-not-allowed"
  >
    <span className="flex-1 truncate">{label}</span>
    {shortcut && (
      <span className="flex-shrink-0 text-xs opacity-50 dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {shortcut}
      </span>
    )}
  </button>
);

interface TextInputContextMenuViewProps {
  x: number;
  y: number;
  isMac: boolean;
  derived: TextInputContextMenuDerivedState;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
}

/** Presentational menu, exported for tests; the hook renders it wired up. */
export const TextInputContextMenuView = React.forwardRef<HTMLDivElement, TextInputContextMenuViewProps>(
  ({ x, y, isMac, derived, onCut, onCopy, onPaste, onSelectAll }, ref) => (
  <div
    ref={ref}
    role="menu"
    className="fixed z-50 min-w-[176px] rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-lg overflow-hidden py-1"
    style={{ left: x, top: y }}
    onContextMenu={(event) => event.preventDefault()}
    // Keep focus (and the selection) on the input until the action reads it.
    onMouseDown={(event) => event.preventDefault()}
  >
    <TextInputContextMenuItem
      label={i18nService.t('contextMenuCut')}
      shortcut={isMac ? '⌘X' : 'Ctrl+X'}
      disabled={!derived.canCut}
      onClick={onCut}
    />
    <TextInputContextMenuItem
      label={i18nService.t('contextMenuCopy')}
      shortcut={isMac ? '⌘C' : 'Ctrl+C'}
      disabled={!derived.canCopy}
      onClick={onCopy}
    />
    <TextInputContextMenuItem
      label={i18nService.t('contextMenuPaste')}
      shortcut={isMac ? '⌘V' : 'Ctrl+V'}
      disabled={false}
      onClick={onPaste}
    />
    <div className="my-1 h-px dark:bg-claude-darkBorder bg-claude-border" />
    <TextInputContextMenuItem
      label={i18nService.t('contextMenuSelectAll')}
      shortcut={isMac ? '⌘A' : 'Ctrl+A'}
      disabled={!derived.canSelectAll}
      onClick={onSelectAll}
    />
  </div>
));
TextInputContextMenuView.displayName = 'TextInputContextMenuView';

export interface TextInputContextMenuController {
  /** Attach to the target input/textarea. */
  onContextMenu: (event: React.MouseEvent<TextInputElement>) => void;
  /** Render anywhere — the menu is position:fixed. */
  menu: React.ReactNode;
}

export const useTextInputContextMenu = (disabled = false): TextInputContextMenuController => {
  const menuRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<TextInputElement | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  // Snapshot for item availability; actions re-read the live selection.
  const [openedWith, setOpenedWith] = useState<{ start: number; end: number; valueLength: number }>({
    start: 0,
    end: 0,
    valueLength: 0,
  });

  const isMac = (window as { electron?: { platform?: string } }).electron?.platform === 'darwin';
  const close = useCallback(() => setPosition(null), []);

  const onContextMenu = useCallback((event: React.MouseEvent<TextInputElement>) => {
    if (disabled) return;
    const target = event.currentTarget;
    event.preventDefault();
    event.stopPropagation();
    targetRef.current = target;
    target.focus();
    setOpenedWith({
      start: target.selectionStart ?? 0,
      end: target.selectionEnd ?? 0,
      valueLength: target.value.length,
    });
    const x = Math.min(
      Math.max(TEXT_INPUT_MENU_PADDING, event.clientX),
      window.innerWidth - TEXT_INPUT_MENU_WIDTH - TEXT_INPUT_MENU_PADDING,
    );
    const y = Math.min(
      Math.max(TEXT_INPUT_MENU_PADDING, event.clientY),
      window.innerHeight - TEXT_INPUT_MENU_HEIGHT - TEXT_INPUT_MENU_PADDING,
    );
    setPosition({ x, y });
  }, [disabled]);

  useEffect(() => {
    if (!position) return;
    const handleMouseDownOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target)) {
        close();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const handleDismiss = () => close();
    document.addEventListener('mousedown', handleMouseDownOutside);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handleDismiss, true);
    window.addEventListener('resize', handleDismiss);
    return () => {
      document.removeEventListener('mousedown', handleMouseDownOutside);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleDismiss, true);
      window.removeEventListener('resize', handleDismiss);
    };
  }, [position, close]);

  const readLiveSelection = (): { start: number; end: number } => {
    const el = targetRef.current;
    if (!el) return { start: 0, end: 0 };
    return { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 };
  };

  const applyChange = (replaceFrom: number, replaceTo: number, text: string) => {
    const el = targetRef.current;
    if (!el) return;
    el.focus();
    el.setRangeText(text, replaceFrom, replaceTo, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const runCopy = () => {
    close();
    const el = targetRef.current;
    if (!el) return;
    const { start, end } = readLiveSelection();
    const selectedText = el.value.slice(start, end);
    if (!selectedText) return;
    void navigator.clipboard.writeText(selectedText).catch((error) => {
      console.error('Failed to copy from text input:', error);
    });
  };

  const runCut = () => {
    close();
    const el = targetRef.current;
    if (!el || disabled) return;
    const { start, end } = readLiveSelection();
    const selectedText = el.value.slice(start, end);
    if (!selectedText) return;
    void (async () => {
      try {
        // Only remove the text after the clipboard write succeeds, otherwise
        // a failed copy would silently delete the selection.
        await navigator.clipboard.writeText(selectedText);
        applyChange(start, end, '');
      } catch (error) {
        console.error('Failed to cut from text input:', error);
      }
    })();
  };

  const runPaste = () => {
    close();
    if (disabled) return;
    const { start, end } = readLiveSelection();
    void (async () => {
      let text: string;
      try {
        text = await navigator.clipboard.readText();
      } catch (error) {
        console.error('Failed to read clipboard for text input paste:', error);
        return;
      }
      // Clipboard items without text (e.g. copied files) must not replace
      // the current selection with nothing.
      if (!text) return;
      applyChange(start, end, text);
    })();
  };

  const runSelectAll = () => {
    close();
    const el = targetRef.current;
    if (!el || disabled) return;
    el.focus();
    el.select();
  };

  const derived = deriveTextInputContextMenuState({
    valueLength: openedWith.valueLength,
    selectionStart: openedWith.start,
    selectionEnd: openedWith.end,
    disabled,
  });

  return {
    onContextMenu,
    menu: position ? (
      <TextInputContextMenuView
        ref={menuRef}
        x={position.x}
        y={position.y}
        isMac={isMac}
        derived={derived}
        onCut={runCut}
        onCopy={runCopy}
        onPaste={runPaste}
        onSelectAll={runSelectAll}
      />
    ) : null,
  };
};
