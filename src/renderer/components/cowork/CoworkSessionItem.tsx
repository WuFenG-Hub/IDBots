import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CoworkSessionSummary, CoworkSessionStatus } from '../../types/cowork';
import { ArchiveBoxIcon, ClipboardDocumentIcon, EllipsisHorizontalIcon, PencilSquareIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { getCoworkSessionTitleClassName, shouldShowCoworkA2ADot } from './coworkSessionPresentation.js';
import { copyCoworkSessionLinkToClipboard } from './coworkSessionLink.js';
import { isRenderableAvatarSource } from '../../utils/avatarSource';

interface CoworkSessionItemProps {
  session: CoworkSessionSummary;
  hasUnread: boolean;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onTogglePin: (pinned: boolean) => void;
  onRename: (title: string) => void;
}

const statusLabels: Record<CoworkSessionStatus, string> = {
  idle: 'coworkStatusIdle',
  running: 'coworkStatusRunning',
  completed: 'coworkStatusCompleted',
  error: 'coworkStatusError',
};

const PushPinIcon: React.FC<React.SVGProps<SVGSVGElement> & { slashed?: boolean }> = ({
  slashed,
  ...props
}) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <g transform="rotate(45 12 12)">
      <path d="M9 3h6l-1 5 2 2v2H8v-2l2-2-1-5z" />
      <path d="M12 12v9" />
    </g>
    {slashed && <path d="M5 5L19 19" />}
  </svg>
);

const formatRelativeTime = (timestamp: number): { compact: string; full: string } => {
  const now = Date.now();
  const diff = now - timestamp;

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) {
    return {
      compact: 'now',
      full: i18nService.t('justNow'),
    };
  } else if (minutes < 60) {
    return {
      compact: `${minutes}m`,
      full: `${minutes} ${i18nService.t('minutesAgo')}`,
    };
  } else if (hours < 24) {
    return {
      compact: `${hours}h`,
      full: `${hours} ${i18nService.t('hoursAgo')}`,
    };
  } else if (days === 1) {
    return {
      compact: '1d',
      full: i18nService.t('yesterday'),
    };
  } else {
    return {
      compact: `${days}d`,
      full: `${days} ${i18nService.t('daysAgo')}`,
    };
  }
};

const isRenderableSessionAvatarSource = (src?: string | null): src is string =>
  isRenderableAvatarSource(src);

const avatarInitial = (name?: string | null): string => {
  const trimmed = name?.trim() ?? '';
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : '?';
};

/** Small circular avatar with an initial-letter fallback. */
const SessionAvatarCircle: React.FC<{
  src?: string | null;
  name?: string | null;
  className?: string;
}> = ({ src, name, className = '' }) => {
  const initiallyRenderable = isRenderableSessionAvatarSource(src);
  // Track image-load failures so a broken/404 avatar URL falls back to the
  // initial letter instead of showing a broken-image icon. Reset if the src
  // changes back to a (different) renderable value.
  const [imageFailed, setImageFailed] = React.useState(false);
  React.useEffect(() => {
    setImageFailed(false);
  }, [src]);
  const showImage = initiallyRenderable && !imageFailed;
  return (
    <span
      className={`flex h-6 w-6 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-claude-surfaceHover text-[11px] font-semibold text-claude-textSecondary dark:bg-claude-darkSurfaceHover dark:text-claude-darkTextSecondary ${className}`}
      title={name?.trim() || undefined}
    >
      {showImage ? (
        <img
          src={src}
          alt={name?.trim() || ''}
          className="h-full w-full object-cover"
          onError={() => setImageFailed(true)}
        />
      ) : (
        avatarInitial(name)
      )}
    </span>
  );
};

/**
 * Sidebar avatar(s) identifying which MetaBot(s) a session belongs to:
 * the executing MetaBot for standard cowork sessions, and both the local
 * MetaBot and the remote peer (overlapping) for A2A sessions. For A2A
 * sessions the peer avatar is clickable to force-refresh the peer's latest
 * name/avatar from the chain (GlobalMetaID is immutable; name/avatar can
 * change), since the background refresh is TTL-gated and may be stale.
 */
export const CoworkSessionAvatars: React.FC<{ session: CoworkSessionSummary }> = ({ session }) => {
  const [isRefreshingPeer, setIsRefreshingPeer] = React.useState(false);

  const handleRefreshPeer = React.useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isRefreshingPeer) return;
    const sessionId = session.id;
    if (!sessionId) return;
    setIsRefreshingPeer(true);
    try {
      await window.electron?.cowork?.refreshPeerProfile({ sessionId, force: true });
    } catch {
      /* best-effort; the profileRefreshed event drives the UI update */
    } finally {
      // Brief delay so the spinner is perceptible even on a fast refresh.
      window.setTimeout(() => setIsRefreshingPeer(false), 400);
    }
  }, [isRefreshingPeer, session.id]);

  if (session.sessionType === 'a2a') {
    const refreshLabel = isRefreshingPeer
      ? i18nService.t('coworkPeerProfileRefreshing')
      : i18nService.t('coworkPeerProfileRefresh');
    return (
      <span className="mr-2 flex flex-shrink-0 items-center">
        <SessionAvatarCircle
          src={session.metabotAvatar}
          name={session.metabotName}
          className="relative z-10 ring-2 ring-claude-surfaceMuted dark:ring-claude-darkSurfaceMuted"
        />
        <button
          type="button"
          onClick={handleRefreshPeer}
          disabled={isRefreshingPeer}
          aria-label={refreshLabel}
          title={refreshLabel}
          className={`-ml-2 rounded-full ring-2 ring-claude-surfaceMuted dark:ring-claude-darkSurfaceMuted transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-claude-accent ${
            isRefreshingPeer ? 'cursor-wait opacity-60' : 'cursor-pointer'
          }`}
        >
          <SessionAvatarCircle
            src={session.peerAvatar}
            name={session.peerName}
          />
        </button>
      </span>
    );
  }
  if (session.metabotId == null && !session.metabotName && !session.metabotAvatar) {
    return null;
  }
  return (
    <SessionAvatarCircle
      src={session.metabotAvatar}
      name={session.metabotName || session.title}
      className="mr-2"
    />
  );
};

const CoworkSessionItem: React.FC<CoworkSessionItemProps> = ({
  session,
  hasUnread,
  isActive,
  onSelect,
  onDelete,
  onTogglePin,
  onRename,
}) => {
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(session.title);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const ignoreNextBlurRef = useRef(false);
  // Right-click opens the menu at the cursor; the reposition effect must not
  // snap it back to the action button.
  const menuPositionFromContextMenuRef = useRef(false);

  useEffect(() => {
    if (!isRenaming) {
      setRenameValue(session.title);
      ignoreNextBlurRef.current = false;
    }
  }, [isRenaming, session.title]);

  const calculateMenuPosition = (height: number) => {
    const rect = actionButtonRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const menuWidth = 180;
    const padding = 8;
    const x = Math.min(
      Math.max(padding, rect.right - menuWidth),
      window.innerWidth - menuWidth - padding
    );
    const y = Math.min(rect.bottom + 8, window.innerHeight - height - padding);
    return { x, y };
  };

  const openMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRenaming) return;
    if (menuPosition) {
      closeMenu();
      return;
    }
    const menuHeight = 160;
    const position = calculateMenuPosition(menuHeight);
    if (position) {
      setMenuPosition(position);
    }
    setShowConfirmDelete(false);
  };

  /** Open the session menu at the mouse position (right-click entry point). */
  const openMenuAt = (clientX: number, clientY: number) => {
    if (isRenaming) return;
    const menuWidth = 180;
    const menuHeight = 160;
    const padding = 8;
    const x = Math.min(
      Math.max(padding, clientX),
      window.innerWidth - menuWidth - padding
    );
    const y = Math.min(
      Math.max(padding, clientY),
      window.innerHeight - menuHeight - padding
    );
    menuPositionFromContextMenuRef.current = true;
    setMenuPosition({ x, y });
    setShowConfirmDelete(false);
  };

  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    openMenuAt(event.clientX, event.clientY);
  };

  const closeMenu = () => {
    setMenuPosition(null);
    setShowConfirmDelete(false);
  };

  const handleTogglePin = (e: React.MouseEvent) => {
    e.stopPropagation();
    onTogglePin(!session.pinned);
    closeMenu();
  };

  const handleRenameClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    ignoreNextBlurRef.current = false;
    setIsRenaming(true);
    setShowConfirmDelete(false);
    setRenameValue(session.title);
    setMenuPosition(null);
  };

  const handleRenameSave = (e?: React.SyntheticEvent) => {
    e?.stopPropagation();
    ignoreNextBlurRef.current = true;
    const nextTitle = renameValue.trim();
    if (nextTitle && nextTitle !== session.title) {
      onRename(nextTitle);
    }
    setIsRenaming(false);
  };

  const handleRenameCancel = (e?: React.MouseEvent | React.KeyboardEvent) => {
    e?.stopPropagation();
    ignoreNextBlurRef.current = true;
    setRenameValue(session.title);
    setIsRenaming(false);
  };

  const handleRenameBlur = (event: React.FocusEvent<HTMLInputElement>) => {
    if (ignoreNextBlurRef.current) {
      ignoreNextBlurRef.current = false;
      return;
    }
    handleRenameSave(event);
  };

  const handleCopySessionIdClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null;
      copyCoworkSessionLinkToClipboard(session.id, clipboard);
    } catch {
      // Ignore clipboard failures; the menu should still close.
    } finally {
      closeMenu();
    }
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowConfirmDelete(true);
    setMenuPosition(null);
  };

  const handleConfirmDelete = () => {
    onDelete();
    setShowConfirmDelete(false);
  };

  const handleCancelDelete = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setShowConfirmDelete(false);
  };

  useEffect(() => {
    if (!menuPosition) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !actionButtonRef.current?.contains(target)) {
        closeMenu();
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu();
      }
    };
    const handleScroll = () => closeMenu();
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [menuPosition]);

  useEffect(() => {
    if (!menuPosition) return;
    // Right-click positioning is anchored to the cursor: keep it as-is.
    if (menuPositionFromContextMenuRef.current) {
      menuPositionFromContextMenuRef.current = false;
      return;
    }
    const menuHeight = showConfirmDelete ? 112 : 160;
    const position = calculateMenuPosition(menuHeight);
    if (position && (position.x !== menuPosition.x || position.y !== menuPosition.y)) {
      setMenuPosition(position);
    }
  }, [menuPosition, showConfirmDelete]);

  useEffect(() => {
    if (!isRenaming) return;
    requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  }, [isRenaming]);

  const pinButtonLabel = session.pinned ? i18nService.t('coworkUnpinSession') : i18nService.t('coworkPinSession');
  const actionLabel = i18nService.t('coworkSessionActions');
  const copySessionIdLabel = i18nService.t('coworkCopySessionId');
  const renameLabel = i18nService.t('renameConversation');
  const archiveLabel = i18nService.t('archiveSession');
  const relativeTime = formatRelativeTime(session.updatedAt);
  const showRunningIndicator = session.status === 'running';
  const showUnreadIndicator = !showRunningIndicator && hasUnread;
  const showStatusIndicator = showRunningIndicator || showUnreadIndicator;
  const isA2A = session.sessionType === 'a2a';
  const showA2ADot = shouldShowCoworkA2ADot({ sessionType: session.sessionType, showStatusIndicator });
  const displayTitle = session.title?.trim()
    || session.peerName
    || i18nService.t('coworkNewSession');
  const menuItems = useMemo(() => {
    return [
      { key: 'copy-session-id', label: copySessionIdLabel, onClick: handleCopySessionIdClick },
      { key: 'rename', label: renameLabel, onClick: handleRenameClick },
      { key: 'pin', label: pinButtonLabel, onClick: handleTogglePin },
      { key: 'archive', label: archiveLabel, onClick: handleDeleteClick },
    ];
  }, [
    copySessionIdLabel,
    archiveLabel,
    handleCopySessionIdClick,
    handleDeleteClick,
    handleRenameClick,
    handleTogglePin,
    pinButtonLabel,
    renameLabel,
  ]);

  return (
    <div
      onClick={() => {
        if (isRenaming) return;
        closeMenu();
        onSelect();
      }}
      onContextMenu={handleContextMenu}
      className={`group relative px-2.5 py-1.5 rounded-lg cursor-pointer transition-all duration-150 ${
        isActive
          ? 'bg-black/[0.06] dark:bg-white/[0.08]'
          : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.05]'
      }`}
    >
      {/* Content area */}
      <div className="flex items-start leading-tight">
        <CoworkSessionAvatars session={session} />
        <div className="flex-1 min-w-0">
          <div className={`flex items-center mb-0.5 ${showStatusIndicator || isA2A ? 'gap-2' : 'gap-0'}`}>
            {/* Status indicator */}
            {showStatusIndicator && (
              <span
                className={`block w-2 h-2 rounded-full bg-claude-accent flex-shrink-0 ${
                  showRunningIndicator ? 'shadow-[0_0_6px_rgba(59,130,246,0.5)] animate-pulse' : ''
                }`}
                title={showRunningIndicator ? i18nService.t(statusLabels[session.status]) : undefined}
              />
            )}
            {/* A2A blue dot (only when not already showing status indicator) */}
            {showA2ADot && (
              <span className="block w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
            )}
            {isRenaming ? (
              <input
                ref={renameInputRef}
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    handleRenameSave(event);
                  }
                  if (event.key === 'Escape') {
                    handleRenameCancel(event);
                  }
                }}
                onBlur={handleRenameBlur}
                className="flex-1 min-w-0 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg px-2 py-1 text-sm font-medium dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent"
              />
            ) : (
              <h3 className={getCoworkSessionTitleClassName({
                sessionType: session.sessionType,
                serviceOrderStatus: session.serviceOrderSummary?.status,
              })}>
                {displayTitle}
              </h3>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary leading-tight">
            <span className="whitespace-nowrap" title={relativeTime.full}>
              {relativeTime.compact}
            </span>
            <span className="text-[10px] uppercase tracking-wider whitespace-nowrap">
              {i18nService.t(statusLabels[session.status])}
            </span>
          </div>
        </div>
      </div>

      {/* Actions - absolutely positioned overlay */}
      <div
        className={`absolute right-1.5 top-1.5 transition-opacity ${
          isRenaming
            ? 'opacity-0 pointer-events-none'
            : session.pinned
              ? 'opacity-100'
              : 'opacity-0 group-hover:opacity-100'
        }`}
      >
        <button
          ref={actionButtonRef}
          onClick={openMenu}
          className="p-1.5 rounded-lg bg-claude-surfaceMuted dark:bg-claude-darkSurfaceMuted dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurface hover:bg-claude-surface transition-colors"
          aria-label={actionLabel}
        >
          {session.pinned ? (
            <span className="relative block h-4 w-4">
              <PushPinIcon className="h-4 w-4 transition-opacity duration-150 group-hover:opacity-0" />
              <EllipsisHorizontalIcon className="absolute inset-0 h-4 w-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
            </span>
          ) : (
            <EllipsisHorizontalIcon className="h-4 w-4" />
          )}
        </button>
      </div>

      {menuPosition && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[180px] rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-lg overflow-hidden"
          style={{ top: menuPosition.y, left: menuPosition.x }}
          role="menu"
        >
          {menuItems.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={item.onClick}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
            >
              {item.key === 'copy-session-id' && <ClipboardDocumentIcon className="h-4 w-4" />}
              {item.key === 'rename' && <PencilSquareIcon className="h-4 w-4" />}
              {item.key === 'pin' && (
                <PushPinIcon
                  slashed={session.pinned}
                  className={`h-4 w-4 ${session.pinned ? 'opacity-60' : ''}`}
                />
              )}
              {item.key === 'archive' && <ArchiveBoxIcon className="h-4 w-4" />}
              {item.label}
            </button>
          ))}
        </div>
      )}

      {/* Archive Confirmation Modal */}
      {showConfirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={handleCancelDelete}
        >
          <div
            className="w-full max-w-sm mx-4 dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center gap-3 px-5 py-4">
              <div className="p-2 rounded-full bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover">
                <ArchiveBoxIcon className="h-5 w-5 text-claude-accent dark:text-claude-darkAccent" />
              </div>
              <h2 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('archiveTaskConfirmTitle')}
              </h2>
            </div>

            {/* Content */}
            <div className="px-5 pb-4">
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('archiveTaskConfirmMessage')}
              </p>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t dark:border-claude-darkBorder border-claude-border">
              <button
                onClick={handleCancelDelete}
                className="px-4 py-2 text-sm font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                onClick={handleConfirmDelete}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-claude-accent hover:opacity-90 text-white transition-colors"
              >
                {i18nService.t('archiveSession')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CoworkSessionItem;
