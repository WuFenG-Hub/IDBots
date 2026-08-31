import React, { useEffect, useRef, useState } from 'react';
import {
  CheckCircleIcon,
  CheckIcon,
  ClockIcon,
  FolderIcon,
  PlusCircleIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { SessionSortMode, SessionViewMode } from '../../utils/sessionViewGrouping';

interface SessionViewOptionsMenuProps {
  /** The toolbar button the menu drops down from. */
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  open: boolean;
  onClose: () => void;
  viewMode: SessionViewMode;
  sortMode: SessionSortMode;
  onViewModeChange: (mode: SessionViewMode) => void;
  onSortModeChange: (mode: SessionSortMode) => void;
}

const MENU_WIDTH = 232;
const VIEWPORT_MARGIN = 8;

interface MenuOptionProps {
  icon: React.ReactNode;
  label: string;
  selected: boolean;
  onClick: () => void;
}

const MenuOption: React.FC<MenuOptionProps> = ({ icon, label, selected, onClick }) => (
  <button
    type="button"
    role="menuitemradio"
    aria-checked={selected}
    onClick={(event) => {
      event.stopPropagation();
      onClick();
    }}
    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
  >
    <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center dark:text-claude-darkTextSecondary text-claude-textSecondary">
      {icon}
    </span>
    <span className="flex-1 truncate">{label}</span>
    {selected && <CheckIcon className="h-4 w-4 flex-shrink-0 text-claude-accent" aria-hidden />}
  </button>
);

const sectionHeaderClass =
  'px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary';

/**
 * "Filter & sort" dropdown for the bot-home session list: a View section
 * (by project / timeline) and a Sort-by section (update time / creation
 * time). Rendered as a fixed element so the sidebar's overflow containers
 * cannot clip it; stays open across selections and closes on outside click,
 * Escape, or viewport resize.
 */
const SessionViewOptionsMenu: React.FC<SessionViewOptionsMenuProps> = ({
  anchorRef,
  open,
  onClose,
  viewMode,
  sortMode,
  onViewModeChange,
  onSortModeChange,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  // Estimated height keeps the first paint near the anchor; the effect below
  // re-clamps once the real height is known.
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const height = menuRef.current?.offsetHeight ?? 216;
    const left = Math.min(
      Math.max(rect.right - MENU_WIDTH, VIEWPORT_MARGIN),
      window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN,
    );
    const top = Math.min(rect.bottom + 6, window.innerHeight - height - VIEWPORT_MARGIN);
    setPosition({ top: Math.max(VIEWPORT_MARGIN, top), left });
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open || !position) return;
    // Second pass once the real menu height is known: keep it inside the
    // viewport even when the initial 216px estimate was too small.
    const height = menuRef.current?.offsetHeight;
    if (!height) return;
    const maxTop = window.innerHeight - height - VIEWPORT_MARGIN;
    if (position.top > maxTop) {
      setPosition({ ...position, top: Math.max(VIEWPORT_MARGIN, maxTop) });
    }
  }, [open, position, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !anchorRef.current?.contains(target)) {
        onClose();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const handleViewportChange = () => onClose();
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleViewportChange);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleViewportChange);
    };
  }, [open, anchorRef, onClose]);

  if (!open || !position) return null;

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={i18nService.t('sessionViewFilterSort')}
      className="fixed z-50 rounded-xl border border-claude-border p-1 shadow-lg dark:border-claude-darkBorder dark:bg-claude-darkSurface bg-claude-surface"
      style={{ top: position.top, left: position.left, width: MENU_WIDTH }}
    >
      <div className={sectionHeaderClass}>{i18nService.t('sessionViewSectionView')}</div>
      <MenuOption
        icon={<FolderIcon className="h-4 w-4" />}
        label={i18nService.t('sessionViewByProject')}
        selected={viewMode === 'project'}
        onClick={() => onViewModeChange('project')}
      />
      <MenuOption
        icon={<ClockIcon className="h-4 w-4" />}
        label={i18nService.t('sessionViewTimeline')}
        selected={viewMode === 'timeline'}
        onClick={() => onViewModeChange('timeline')}
      />
      <div className="my-1 border-t border-claude-border dark:border-claude-darkBorder" />
      <div className={sectionHeaderClass}>{i18nService.t('sessionViewSectionSort')}</div>
      <MenuOption
        icon={<CheckCircleIcon className="h-4 w-4" />}
        label={i18nService.t('sessionSortByUpdatedAt')}
        selected={sortMode === 'updatedAt'}
        onClick={() => onSortModeChange('updatedAt')}
      />
      <MenuOption
        icon={<PlusCircleIcon className="h-4 w-4" />}
        label={i18nService.t('sessionSortByCreatedAt')}
        selected={sortMode === 'createdAt'}
        onClick={() => onSortModeChange('createdAt')}
      />
    </div>
  );
};

export default SessionViewOptionsMenu;
