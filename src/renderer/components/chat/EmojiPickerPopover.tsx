import React, { useState, useRef, useLayoutEffect, useCallback, useEffect, useMemo } from 'react';
import { FaceSmileIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { placePopoverAbove, useAnchorMoveWatcher } from '../../utils/anchoredPopover';
import { i18nService } from '../../services/i18n';
import {
  EMOJI_CATEGORIES,
  searchEmoji,
  type EmojiEntry,
} from './emojiData';

/**
 * Chat emoji picker: a toolbar trigger + a popover panel with category tabs,
 * a search box, and a Unicode emoji grid. Pure-Unicode catalog (see
 * emojiData.ts) — no bundled artwork, no third-party assets.
 *
 * Placement follows the composer's '+' menu: the panel floats with
 * position:fixed ABOVE the trigger (chat composers sit at the bottom of the
 * window) so it escapes overflow-hidden ancestors, and it re-places when the
 * anchor moves without window events (sidebar drag, textarea auto-grow).
 *
 * The panel intentionally STAYS OPEN after a pick (chat muscle memory:
 * several emoji in a row); Escape, outside click, or the trigger closes it.
 */

const EMOJI_PANEL_WIDTH = 344;
const EMOJI_PANEL_HEIGHT = 288;

/** In-memory recents (session-only; nothing is persisted to disk). */
const RECENT_LIMIT = 16;
const recentChars: string[] = [];
const rememberRecent = (char: string) => {
  const next = [char, ...recentChars.filter((c) => c !== char)];
  recentChars.length = 0;
  recentChars.push(...next.slice(0, RECENT_LIMIT));
};

export interface EmojiPickerPanelProps {
  /** Rendered inside the popover shell; shared by the tabbed and search views. */
  onSelect: (emoji: string) => void;
}

const EmojiGrid: React.FC<{
  emojis: EmojiEntry[];
  'aria-label'?: string;
  onSelect: (emoji: string) => void;
}> = ({ emojis, 'aria-label': ariaLabel, onSelect }) => (
  <div
    role="listbox"
    aria-label={ariaLabel}
    className="grid grid-cols-8 gap-0.5 p-1 overflow-y-auto flex-1 min-h-0"
  >
    {emojis.map((emoji) => (
      <button
        key={emoji.char}
        type="button"
        role="option"
        aria-label={emoji.char}
        title={emoji.keywords}
        onClick={() => onSelect(emoji.char)}
        className="h-8 w-8 flex items-center justify-center rounded-lg text-[19px] leading-none transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover focus:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/60"
      >
        {emoji.char}
      </button>
    ))}
  </div>
);

const EmojiPickerPanel: React.FC<EmojiPickerPanelProps> = ({ onSelect }) => {
  const [activeCategory, setActiveCategory] = useState<string>(EMOJI_CATEGORIES[0].id);
  const [query, setQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  const handleSelect = useCallback((emoji: string) => {
    rememberRecent(emoji);
    onSelect(emoji);
  }, [onSelect]);

  // Autofocus the search box when the panel opens.
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  const results = useMemo(() => searchEmoji(query), [query]);
  const searching = query.trim().length > 0;

  const tabs = useMemo(() => {
    const base = EMOJI_CATEGORIES.map((category) => ({
      id: category.id,
      labelKey: category.labelKey,
      sample: category.emojis[0]?.char ?? '',
    }));
    if (recentChars.length === 0) return base;
    return [{ id: 'recent', labelKey: 'emojiCategoryRecent', sample: recentChars[0] }, ...base];
  }, []);

  const activeEmojis = useMemo<EmojiEntry[]>(() => {
    if (searching) return results;
    if (activeCategory === 'recent') {
      return recentChars.map((char) => ({ char, keywords: '' }));
    }
    return EMOJI_CATEGORIES.find((category) => category.id === activeCategory)?.emojis ?? [];
  }, [activeCategory, results, searching]);

  return (
    <div className="flex h-full flex-col">
      {/* Search row */}
      <div className="px-2 pt-2 pb-1">
        <div className="flex items-center gap-1.5 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset px-2 py-1">
          <MagnifyingGlassIcon className="h-3.5 w-3.5 flex-shrink-0 opacity-60" />
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                // Clear the query first; a second Escape closes the panel
                // (the panel-level handler only fires when not swallowed).
                if (query) {
                  e.stopPropagation();
                  setQuery('');
                }
              }
            }}
            placeholder={i18nService.t('emojiPickerSearchPlaceholder')}
            className="w-full bg-transparent text-xs dark:text-claude-darkText text-claude-text placeholder:opacity-50 focus:outline-none"
            aria-label={i18nService.t('emojiPickerSearchPlaceholder')}
          />
        </div>
      </div>
      {/* Category tabs */}
      {!searching && (
        <div
          role="tablist"
          aria-label={i18nService.t('composerEmojiTitle')}
          className="flex items-center gap-0.5 px-2 pb-1 overflow-x-auto flex-shrink-0"
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeCategory === tab.id}
              title={i18nService.t(tab.labelKey)}
              onClick={() => setActiveCategory(tab.id)}
              className={`h-7 w-7 flex-shrink-0 flex items-center justify-center rounded-lg text-[15px] leading-none transition-colors ${
                activeCategory === tab.id
                  ? 'bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover ring-1 ring-claude-accent/50'
                  : 'hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
              }`}
            >
              {tab.sample}
            </button>
          ))}
        </div>
      )}
      {/* Grid */}
      {activeEmojis.length > 0 ? (
        <EmojiGrid emojis={activeEmojis} onSelect={handleSelect} aria-label={i18nService.t('composerEmojiTitle')} />
      ) : (
        <div className="flex flex-1 items-center justify-center px-4 pb-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('emojiPickerNoResults')}
        </div>
      )}
    </div>
  );
};

export interface EmojiMenuButtonProps {
  open: boolean;
  buttonRef: React.RefObject<HTMLButtonElement>;
  /** Follows the textarea's own gate (disabled composer = disabled picker). */
  disabled?: boolean;
  onToggle: () => void;
  /** Insert the picked emoji at the composer caret. */
  onPick: (emoji: string) => void;
}

/**
 * The emoji trigger + popover. Self-contained (no redux, no store) so any
 * composer can mount it next to its other toolbar buttons, and so tests can
 * render it standalone.
 */
const EmojiMenuButton: React.FC<EmojiMenuButtonProps> = ({
  open,
  buttonRef,
  disabled = false,
  onToggle,
  onPick,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties | null>(null);

  const updatePanelPlacement = useCallback(() => {
    const anchorRect = buttonRef.current?.getBoundingClientRect() ?? null;
    const placement = placePopoverAbove(anchorRect, { width: EMOJI_PANEL_WIDTH, height: EMOJI_PANEL_HEIGHT }, EMOJI_PANEL_WIDTH);
    setPanelStyle({ position: 'fixed', top: placement.top, left: placement.left, width: placement.width, height: EMOJI_PANEL_HEIGHT });
  }, [buttonRef]);

  useLayoutEffect(() => {
    if (!open) {
      setPanelStyle(null);
      return;
    }
    updatePanelPlacement();
    window.addEventListener('resize', updatePanelPlacement);
    window.addEventListener('scroll', updatePanelPlacement, true);
    return () => {
      window.removeEventListener('resize', updatePanelPlacement);
      window.removeEventListener('scroll', updatePanelPlacement, true);
    };
  }, [open, updatePanelPlacement]);

  useAnchorMoveWatcher(buttonRef, open, updatePanelPlacement);

  // Outside click / Escape close (same dismissal pattern as the skills and
  // folder popovers).
  useEffect(() => {
    if (!open) return;
    const handleMouseDownOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !panelRef.current?.contains(target)
        && !buttonRef.current?.contains(target)
      ) {
        onToggle();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onToggle();
    };
    document.addEventListener('mousedown', handleMouseDownOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDownOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onToggle, buttonRef]);

  return (
    <div className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center justify-center p-1.5 rounded-lg text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:hover:text-claude-darkText hover:text-claude-text transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:dark:hover:bg-transparent"
        title={i18nService.t('composerEmojiTitle')}
        aria-label={i18nService.t('composerEmojiTitle')}
      >
        <FaceSmileIcon className="h-4 w-4" />
      </button>
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label={i18nService.t('composerEmojiTitle')}
          className="fixed z-50 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg shadow-lg overflow-hidden flex flex-col"
          style={panelStyle ?? { visibility: 'hidden' }}
        >
          <EmojiPickerPanel onSelect={onPick} />
        </div>
      )}
    </div>
  );
};

export default EmojiMenuButton;
