import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CheckIcon, ChevronDownIcon, CpuChipIcon, Squares2X2Icon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { type BotSelectorOption } from '../../utils/sessionViewGrouping';

interface BotSelectorPopoverProps {
  /** 全部 first, then one entry per local bot (see buildBotSelectorOptions). */
  options: BotSelectorOption[];
  /** Currently active option key. */
  activeKey: string;
  /** Pick an option; the caller owns the filter state. */
  onPick: (key: string) => void;
  /** Unread sessions the CURRENT selection keeps off screen; 0 renders no badge. */
  unreadElsewhere: number;
}

/** The popover never shrinks below this, so option rows keep room for the
 * name + session count. Wider controls (large fonts) widen it instead. */
const POPOVER_MIN_WIDTH = 208;
const VIEWPORT_MARGIN = 8;
/** Height estimate used before the real popover has been measured. */
const POPOVER_MAX_HEIGHT = 268;

const sectionHeaderClass =
  'px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary';

const optionLabel = (option: BotSelectorOption): string =>
  option.bot
    ? option.bot.name || `Bot ${option.bot.id}`
    : i18nService.t('sessionBotFilterAll');

/**
 * Online-chats (A2A) Bot selector — a self-drawn popover in the app's own
 * design language, replacing the native <select> whose OS menu (blue system
 * highlight) clashed with the rest of the sidebar.
 *
 * Reuses the shell patterns already in this folder:
 *   - MetaBotSelector: avatar + value + ▾ trigger, avatar/name option rows;
 *   - SessionViewOptionsMenu: section header, role=listbox menu, Escape /
 *     outside-click close, and fixed positioning — the sidebar wraps the list
 *     in overflow-hidden + overflow-y-auto (Sidebar.tsx:477 / :686), so an
 *     absolutely positioned menu would be clipped.
 *
 * Keyboard model === the native <select> it replaces: Tab reaches the control,
 * Enter / Space / ArrowDown opens it, ArrowUp / ArrowDown move the active row,
 * Enter commits, Escape closes, Tab closes and moves on. DOM focus deliberately
 * stays on the trigger while open (aria-activedescendant names the active row),
 * so no focus trap can be created and blur order stays identical to the native
 * control's.
 */
const BotSelectorPopover: React.FC<BotSelectorPopoverProps> = ({
  options,
  activeKey,
  onPick,
  unreadElsewhere,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  // Row the keyboard is on; only meaningful while open.
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  const selectedIndex = useMemo(() => {
    const index = options.findIndex((option) => option.key === activeKey);
    return index < 0 ? 0 : index;
  }, [options, activeKey]);

  const currentLabel = options[selectedIndex] ? optionLabel(options[selectedIndex]) : '';

  const openPopover = (index: number) => {
    setActiveIndex(index);
    setIsOpen(true);
  };
  const closePopover = () => {
    setIsOpen(false);
    // Focus never left the trigger, so this is a no-op in the keyboard path and
    // only pulls focus back when a mouse click landed elsewhere.
    buttonRef.current?.focus();
  };
  const commit = (key: string | undefined) => {
    if (key) onPick(key);
    closePopover();
  };

  // Outside click closes (MetaBotSelector:29-37). The popover is a DOM child of
  // containerRef even though it is positioned fixed, so contains() still covers it.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  // Position the fixed menu under the trigger and keep it inside the viewport
  // (SessionViewOptionsMenu:76-102).
  const computePosition = React.useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const width = Math.max(rect.width, POPOVER_MIN_WIDTH);
    const height = popoverRef.current?.offsetHeight ?? POPOVER_MAX_HEIGHT;
    const left = Math.min(
      Math.max(rect.left, VIEWPORT_MARGIN),
      Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN),
    );
    const below = rect.bottom + 6;
    const top =
      below + height > window.innerHeight - VIEWPORT_MARGIN
        ? Math.max(VIEWPORT_MARGIN, rect.top - height - 6)
        : below;
    return { top, left, width };
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setPosition(null);
      return;
    }
    setPosition(computePosition());
  }, [isOpen, options.length, computePosition]);

  useEffect(() => {
    if (!isOpen || !position) return;
    // Second pass once the real popover height is known.
    const height = popoverRef.current?.offsetHeight;
    if (!height) return;
    const maxTop = window.innerHeight - height - VIEWPORT_MARGIN;
    if (position.top > maxTop) setPosition({ ...position, top: Math.max(VIEWPORT_MARGIN, maxTop) });
  }, [isOpen, position]);

  useEffect(() => {
    if (!isOpen) return;
    // Re-anchor instead of closing: a click that focuses the trigger can make the
    // browser scroll the button into view, and closing on that scroll would make
    // the control un-openable by mouse.
    let frame = 0;
    const reposition = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const next = computePosition();
        if (next) setPosition(next);
      });
    };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [isOpen, computePosition]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!isOpen) openPopover(selectedIndex);
        else setActiveIndex((index) => Math.min(index + 1, options.length - 1));
        return;
      case 'ArrowUp':
        event.preventDefault();
        if (!isOpen) openPopover(selectedIndex);
        else setActiveIndex((index) => Math.max(index - 1, 0));
        return;
      case 'Home':
        if (!isOpen) return;
        event.preventDefault();
        setActiveIndex(0);
        return;
      case 'End':
        if (!isOpen) return;
        event.preventDefault();
        setActiveIndex(options.length - 1);
        return;
      case 'Enter':
      case ' ':
      case 'Spacebar':
        // preventDefault also cancels the native button activation, so Enter /
        // Space cannot both toggle here and fire a click (which would re-close).
        event.preventDefault();
        if (!isOpen) openPopover(selectedIndex);
        else commit(options[activeIndex]?.key);
        return;
      case 'Escape':
        if (!isOpen) return;
        event.preventDefault();
        closePopover();
        return;
      case 'Tab':
        // Native selects close their popup on Tab and let focus move on.
        if (isOpen) setIsOpen(false);
        return;
      default:
        return;
    }
  };

  const renderAvatar = (option: BotSelectorOption, sizeClass: string, iconClass: string) => {
    const avatar = option.bot?.avatar;
    if (avatar && (avatar.startsWith('data:') || avatar.startsWith('http'))) {
      return <img src={avatar} alt="" className={`${sizeClass} rounded object-cover flex-shrink-0`} />;
    }
    if (!option.bot) {
      return (
        <span
          className={`${sizeClass} flex flex-shrink-0 items-center justify-center rounded dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary`}
        >
          <Squares2X2Icon className={iconClass} aria-hidden="true" />
        </span>
      );
    }
    return (
      <span
        className={`${sizeClass} flex flex-shrink-0 items-center justify-center rounded dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary text-[8px] font-semibold uppercase`}
      >
        {option.bot.name ? option.bot.name.slice(0, 2) : <CpuChipIcon className={iconClass} aria-hidden="true" />}
      </span>
    );
  };

  const optionAriaLabel = (option: BotSelectorOption): string => {
    const parts = [optionLabel(option)];
    parts.push(`${option.sessionCount} ${i18nService.t('sessionBotOptionSessions')}`);
    if (option.unreadCount > 0) {
      parts.push(`${option.unreadCount} ${i18nService.t('sessionBotFilterUnread')}`);
    }
    return parts.join(', ');
  };

  // The trigger's accessible name mirrors what the native select announced:
  // the control's purpose + its current value.
  const triggerAriaLabel = `${i18nService.t('sessionBotFilterLabel')}: ${currentLabel}`;

  return (
    <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-0.5" data-testid="bot-selector-row">
      <div ref={containerRef} className="relative min-w-0 max-w-full">
        <button
          ref={buttonRef}
          type="button"
          data-testid="bot-selector"
          data-value={activeKey}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-controls={isOpen ? listboxId : undefined}
          aria-activedescendant={isOpen ? optionId(activeIndex) : undefined}
          aria-label={triggerAriaLabel}
          onClick={() => (isOpen ? closePopover() : openPopover(selectedIndex))}
          onKeyDown={handleKeyDown}
          /* Demoted to the host's own "row above the list" weight (Sidebar.tsx
           * toolbar row / SessionViewOptionsMenu trigger): left aligned, width
           * fitted to its content, no border, no resting background, and the
           * background only on hover. pl-0 keeps the avatar column flush with
           * the session rows' avatars below, so the control reads as the head of
           * the list instead of a full-width form field competing with it. */
          className="flex w-fit max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md bg-transparent py-0.5 pl-0 pr-1.5 text-xs font-medium transition-colors dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover hover:text-claude-text dark:hover:text-claude-darkText focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40"
        >
          {renderAvatar(options[selectedIndex], 'h-4 w-4', 'h-2.5 w-2.5')}
          <span data-testid="bot-selector-value" className="min-w-0 flex-1 truncate text-left">
            {currentLabel}
          </span>
          <ChevronDownIcon
            aria-hidden="true"
            className={`h-3 w-3 flex-shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary transition-transform ${isOpen ? 'rotate-180' : ''}`}
          />
        </button>
        {isOpen && position && (
          <div
            ref={popoverRef}
            id={listboxId}
            role="listbox"
            aria-label={i18nService.t('sessionBotSelectorTitle')}
            data-testid="bot-selector-popover"
            className="fixed z-50 overflow-hidden rounded-xl border border-claude-border p-1 shadow-lg dark:border-claude-darkBorder dark:bg-claude-darkSurface bg-claude-surface"
            style={{ top: position.top, left: position.left, width: position.width }}
          >
            <div className={sectionHeaderClass} data-testid="bot-selector-popover-title">
              {i18nService.t('sessionBotSelectorTitle')}
            </div>
            <div className="max-h-56 overflow-y-auto">
              {options.map((option, index) => {
                const selected = option.key === activeKey;
                const isKeyboardRow = index === activeIndex;
                return (
                  <div
                    key={option.key}
                    id={optionId(index)}
                    role="option"
                    aria-selected={selected}
                    aria-label={optionAriaLabel(option)}
                    data-testid="bot-selector-option"
                    data-key={option.key}
                    data-session-count={option.sessionCount}
                    data-unread-count={option.unreadCount}
                    tabIndex={-1}
                    onClick={() => commit(option.key)}
                    className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover ${
                      isKeyboardRow
                        ? 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover'
                        : ''
                    }`}
                  >
                    {renderAvatar(option, 'h-5 w-5', 'h-3 w-3')}
                    <span className="min-w-0 flex-1 truncate">{optionLabel(option)}</span>
                    <span
                      data-testid="bot-option-count"
                      title={`${option.sessionCount} ${i18nService.t('sessionBotOptionSessions')}`}
                      className="flex-shrink-0 text-[10px] tabular-nums dark:text-claude-darkTextSecondary text-claude-textSecondary"
                    >
                      {option.sessionCount}
                    </span>
                    {option.unreadCount > 0 && (
                      <span
                        data-testid="bot-option-unread"
                        aria-hidden="true"
                        className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-red-500"
                      />
                    )}
                    {/* Selected marker === SessionViewOptionsMenu.tsx:48 — the same
                     * accent CheckIcon the host's own session menu uses, so this
                     * popover marks its selection exactly like its sibling. The row
                     * background stays reserved for the keyboard/hover row. */}
                    {selected && (
                      <CheckIcon className="h-4 w-4 flex-shrink-0 text-claude-accent" aria-hidden />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      {unreadElsewhere > 0 && (
        <span
          data-testid="bot-selector-unread"
          aria-label={`${i18nService.t('sessionBotFilterUnread')} ${unreadElsewhere}`}
          className="inline-flex h-3.5 min-w-[14px] shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-semibold leading-none text-white"
        >
          {unreadElsewhere}
        </span>
      )}
    </div>
  );
};

export default BotSelectorPopover;
