/**
 * The "⋯" message action trigger and the menu it opens.
 *
 * Interaction (owner's call, 2026-10-19): hovering a message reveals a single
 * "⋯" beside the bubble; the menu behind it carries the conversation-level
 * actions — quote / copy / branch. The turn-end line keeps the timestamp and
 * the feedback thumbs, so "did I react to this?" stays visible at a glance
 * instead of hiding behind a menu. The user bubble additionally got its old
 * below-the-bubble hover pair back (owner's call, 2026-10-28): the sent time
 * and a direct copy button ride the metadata row beside the "⋯" — the menu
 * and the direct copy coexist.
 *
 * Two existing visual families are reused so this looks like something the app
 * already had:
 *  - the trigger started as an inline action (`CoworkMessageReplyAction`, the
 *    branch button in `CoworkSessionDetail`); per owner request (2026-10-23)
 *    it now runs one size up with the solid ellipsis in primary text color,
 *    because the original small gray glyph was too easy to miss
 *  - the panel is the session-list context menu (`CoworkSessionItem`)
 * No new colour, shadow, radius or font token is introduced.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRightOnRectangleIcon,
  ChatBubbleBottomCenterTextIcon,
  ClipboardDocumentIcon,
} from '@heroicons/react/24/outline';
// Solid ellipsis: the trigger was hard to spot beside the bubble, so it runs
// one size up in the filled variant (owner request 2026-10-23).
import { EllipsisHorizontalIcon } from '@heroicons/react/24/solid';
import { i18nService } from '../../services/i18n';
import { hasQuotableText } from './coworkQuotedSelections';

/** Menu panel geometry, mirroring CoworkSessionItem.openMenuAt. */
export const MESSAGE_ACTION_MENU_WIDTH = 180;
export const MESSAGE_ACTION_MENU_HEIGHT = 132;
const VIEWPORT_PADDING = 8;

export interface CoworkMessageActionsMenuProps {
  /** Hover state of the owning message. */
  visible: boolean;
  /** Message text: gates "copy" and "quote" (empty text offers neither). */
  text: string;
  onQuote: () => void;
  /** Optional hook after a successful clipboard write. */
  onCopied?: () => void;
  /** Omitted when the message cannot be branched from (e.g. still streaming). */
  onBranch?: () => void;
}

const CoworkMessageActionsMenu: React.FC<CoworkMessageActionsMenuProps> = ({
  visible,
  text,
  onQuote,
  onCopied,
  onBranch,
}) => {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);

  const quotable = hasQuotableText(text);
  const copyable = text.trim().length > 0;

  const close = useCallback(() => setPosition(null), []);

  const open = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Right-align the panel with the trigger, open downwards, then clamp into
    // the viewport with the same padding the session-list menu uses.
    const x = Math.min(
      Math.max(VIEWPORT_PADDING, rect.right - MESSAGE_ACTION_MENU_WIDTH),
      window.innerWidth - MESSAGE_ACTION_MENU_WIDTH - VIEWPORT_PADDING,
    );
    const y = Math.min(
      Math.max(VIEWPORT_PADDING, rect.bottom + 4),
      window.innerHeight - MESSAGE_ACTION_MENU_HEIGHT - VIEWPORT_PADDING,
    );
    setPosition({ x, y });
  }, []);

  // Close on Escape, and on any pointer press outside the panel or trigger.
  useEffect(() => {
    if (!position) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [position, close]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      onCopied?.();
    } catch (err) {
      console.error('Failed to copy message:', err);
    }
    close();
  }, [text, onCopied, close]);

  const moreLabel = i18nService.t('coworkMessageActionsMore');

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-cowork-message-actions-trigger="true"
        aria-haspopup="menu"
        aria-expanded={position != null}
        aria-label={moreLabel}
        title={moreLabel}
        onClick={(event) => {
          event.stopPropagation();
          if (position) close();
          else open();
        }}
        className={`inline-flex items-center justify-center rounded-md p-1 dark:text-claude-darkText text-claude-text hover:dark:bg-claude-darkSurfaceInset hover:bg-claude-surfaceInset transition-all duration-200 ${
          visible || position ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        <EllipsisHorizontalIcon className="h-5 w-5" />
      </button>

      {position && (
        <div
          ref={menuRef}
          role="menu"
          data-cowork-message-actions-menu="true"
          className="fixed z-50 min-w-[180px] rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-lg overflow-hidden"
          style={{ top: position.y, left: position.x }}
        >
          {quotable && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onQuote();
                close();
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
            >
              <ChatBubbleBottomCenterTextIcon className="h-4 w-4" />
              {i18nService.t('coworkQuoteReplyAction')}
            </button>
          )}
          {copyable && (
            <button
              type="button"
              role="menuitem"
              onClick={() => void handleCopy()}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
            >
              <ClipboardDocumentIcon className="h-4 w-4" />
              {i18nService.t('copyToClipboard')}
            </button>
          )}
          {onBranch && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onBranch();
                close();
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
            >
              <ArrowRightOnRectangleIcon className="h-4 w-4" />
              {i18nService.t('coworkBranchNewChatLabel')}
            </button>
          )}
        </div>
      )}
    </>
  );
};

CoworkMessageActionsMenu.displayName = 'CoworkMessageActionsMenu';

export default CoworkMessageActionsMenu;
