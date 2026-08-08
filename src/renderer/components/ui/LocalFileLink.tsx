import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckIcon,
  ChevronRightIcon,
  ClipboardDocumentIcon,
  ComputerDesktopIcon,
  DocumentDuplicateIcon,
  DocumentIcon,
  FolderIcon,
  FolderOpenIcon,
  Squares2X2Icon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';

const MENU_WIDTH = 208;
const MENU_ITEM_HEIGHT = 34;
const SUBMENU_WIDTH = 220;
const SUBMENU_OPEN_DELAY_MS = 120;

interface LocalFileLinkProps {
  /** Resolved absolute path of the local file or directory. */
  filePath: string;
  isDirectory?: boolean;
  children: React.ReactNode;
  className?: string;
  title?: string;
  href?: string;
  /** Custom open handler (left click). Defaults to shell.openPath. */
  onOpen?: (filePath: string, event: React.MouseEvent) => Promise<void> | void;
  /** Show the document/folder type icon after children (default true). */
  showTypeIcon?: boolean;
}

const showToast = (message: string): void => {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

/**
 * Renders a local file link with a right-click menu:
 *   Open with (system default / detected apps / choose another app),
 *   Copy path, Copy file content, Reveal in Finder (Explorer on Windows).
 * Platform details (app detection, native "choose app" dialog) live in the
 * main process; this component only talks to the exposed IPC surface.
 */
const LocalFileLink: React.FC<LocalFileLinkProps> = ({
  filePath,
  isDirectory = false,
  children,
  className = '',
  title,
  href,
  onOpen,
  showTypeIcon = true,
}) => {
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [openWithOpen, setOpenWithOpen] = useState(false);
  const [apps, setApps] = useState<OpenWithAppInfo[] | null>(null);
  const [appsLoading, setAppsLoading] = useState(false);
  const [copiedKind, setCopiedKind] = useState<'path' | 'content' | null>(null);
  const [submenuPosition, setSubmenuPosition] = useState<{ x: number; y: number } | null>(null);

  const menuRef = useRef<HTMLDivElement>(null);
  const openWithButtonRef = useRef<HTMLButtonElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const closeSubmenuTimerRef = useRef<number | null>(null);
  const copiedTimerRef = useRef<number | null>(null);

  const platform = useMemo(() => (window as any)?.electron?.platform ?? '', []);
  const isMac = platform === 'darwin';
  const isWindows = platform === 'win32';

  const revealLabel = useMemo(() => {
    if (isMac) return i18nService.t('fileRevealInFinder');
    if (isWindows) return i18nService.t('fileShowInExplorer');
    return i18nService.t('showInFolder');
  }, [isMac, isWindows]);

  const closeMenu = useCallback(() => {
    setMenuPosition(null);
    setOpenWithOpen(false);
    setSubmenuPosition(null);
  }, []);

  const closeSubmenu = useCallback(() => {
    setOpenWithOpen(false);
    setSubmenuPosition(null);
  }, []);

  useEffect(() => () => {
    if (closeSubmenuTimerRef.current != null) {
      window.clearTimeout(closeSubmenuTimerRef.current);
    }
    if (copiedTimerRef.current != null) {
      window.clearTimeout(copiedTimerRef.current);
    }
  }, []);

  const handleOpenClick = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    if (onOpen) {
      void onOpen(filePath, event);
      return;
    }
    void (async () => {
      try {
        const result = await window.electron.shell.openPath(filePath);
        if (!result?.success) {
          console.error('Failed to open file:', filePath, result?.error);
          showToast(i18nService.t('openFileFailed'));
        }
      } catch (error) {
        console.error('Failed to open file:', filePath, error);
        showToast(i18nService.t('openFileFailed'));
      }
    })();
  }, [filePath, onOpen]);

  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const padding = 8;
    const x = Math.min(Math.max(padding, event.clientX), window.innerWidth - MENU_WIDTH - padding);
    const y = Math.min(Math.max(padding, event.clientY), window.innerHeight - 4 * MENU_ITEM_HEIGHT - padding);
    setMenuPosition({ x, y });
    setOpenWithOpen(false);
    setSubmenuPosition(null);
  }, []);

  const loadApps = useCallback(async () => {
    if (apps !== null || appsLoading) return;
    setAppsLoading(true);
    try {
      const result = await window.electron.shell.getOpenWithApps(filePath);
      setApps(result?.success ? result.apps ?? [] : []);
    } catch (error) {
      console.error('Failed to load open-with apps:', filePath, error);
      setApps([]);
    } finally {
      setAppsLoading(false);
    }
  }, [apps, appsLoading, filePath]);

  const positionSubmenu = useCallback(() => {
    const itemRect = openWithButtonRef.current?.getBoundingClientRect();
    if (!itemRect) return;
    const padding = 8;
    const x = itemRect.right + SUBMENU_WIDTH + 8 > window.innerWidth
      ? itemRect.left - SUBMENU_WIDTH
      : itemRect.right + 4;
    const clampedX = Math.max(padding, x);
    const y = Math.min(
      Math.max(padding, itemRect.top - 8),
      window.innerHeight - 5 * MENU_ITEM_HEIGHT - padding
    );
    setSubmenuPosition({ x: clampedX, y });
  }, []);

  const openSubmenu = useCallback(() => {
    if (closeSubmenuTimerRef.current != null) {
      window.clearTimeout(closeSubmenuTimerRef.current);
      closeSubmenuTimerRef.current = null;
    }
    setOpenWithOpen(true);
    void loadApps();
    // Position after the next paint so the anchor rect is stable.
    window.requestAnimationFrame(positionSubmenu);
  }, [loadApps, positionSubmenu]);

  const scheduleCloseSubmenu = useCallback(() => {
    if (closeSubmenuTimerRef.current != null) {
      window.clearTimeout(closeSubmenuTimerRef.current);
    }
    closeSubmenuTimerRef.current = window.setTimeout(() => {
      closeSubmenu();
    }, SUBMENU_OPEN_DELAY_MS);
  }, [closeSubmenu]);

  const openWithDefault = useCallback(() => {
    closeMenu();
    void (async () => {
      try {
        const result = await window.electron.shell.openPath(filePath);
        if (!result?.success) {
          console.error('Failed to open file:', filePath, result?.error);
          showToast(i18nService.t('openFileFailed'));
        }
      } catch (error) {
        console.error('Failed to open file:', filePath, error);
        showToast(i18nService.t('openFileFailed'));
      }
    })();
  }, [closeMenu, filePath]);

  const openWithApp = useCallback((appId: string) => {
    closeMenu();
    void (async () => {
      try {
        const result = await window.electron.shell.openWith(filePath, appId);
        if (!result?.success) {
          console.error('Failed to open with app:', filePath, appId, result?.error);
          showToast(i18nService.t('fileOpenWithFailed'));
        }
      } catch (error) {
        console.error('Failed to open with app:', filePath, appId, error);
        showToast(i18nService.t('fileOpenWithFailed'));
      }
    })();
  }, [closeMenu, filePath]);

  const chooseOtherApp = useCallback(() => {
    closeMenu();
    void (async () => {
      try {
        const result = await window.electron.shell.chooseOpenWithApp(filePath);
        if (!result?.success && result?.error !== 'cancelled') {
          showToast(i18nService.t('fileOpenWithFailed'));
        }
      } catch (error) {
        console.error('Failed to choose app:', filePath, error);
        showToast(i18nService.t('fileOpenWithFailed'));
      }
    })();
  }, [closeMenu, filePath]);

  const copyPath = useCallback(() => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(filePath);
        setCopiedKind('path');
        if (copiedTimerRef.current != null) {
          window.clearTimeout(copiedTimerRef.current);
        }
        copiedTimerRef.current = window.setTimeout(() => setCopiedKind(null), 1500);
      } catch (error) {
        console.error('Failed to copy path:', filePath, error);
        showToast(i18nService.t('fileCopyFailed'));
      }
    })();
  }, [filePath]);

  const copyContent = useCallback(() => {
    void (async () => {
      try {
        const result = await window.electron.fs.readTextFile(filePath);
        if (!result?.success) {
          if (result?.error === 'file_too_large' && typeof result.size === 'number' && typeof result.limit === 'number') {
            const template = i18nService.t('fileCopyContentTooLarge');
            showToast(template.replace('{limit}', formatBytes(result.limit)));
          } else {
            showToast(i18nService.t('fileCopyFailed'));
          }
          return;
        }
        const content = result.content ?? '';
        // NUL byte marks binary content that must not be dumped into the clipboard as text.
        if (content.includes(' ')) {
          showToast(i18nService.t('fileCopyFailed'));
          return;
        }
        await navigator.clipboard.writeText(content);
        setCopiedKind('content');
        if (copiedTimerRef.current != null) {
          window.clearTimeout(copiedTimerRef.current);
        }
        copiedTimerRef.current = window.setTimeout(() => setCopiedKind(null), 1500);
      } catch (error) {
        console.error('Failed to copy content:', filePath, error);
        showToast(i18nService.t('fileCopyFailed'));
      }
    })();
  }, [filePath]);

  const revealInFolder = useCallback(() => {
    closeMenu();
    void (async () => {
      try {
        const result = await window.electron.shell.showItemInFolder(filePath);
        if (!result?.success) {
          console.error('Failed to reveal file:', filePath, result?.error);
        }
      } catch (error) {
        console.error('Failed to reveal file:', filePath, error);
      }
    })();
  }, [closeMenu, filePath]);

  useEffect(() => {
    if (!menuPosition) return;
    const handleMouseDownOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !submenuRef.current?.contains(target)) {
        closeMenu();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu();
      }
    };
    const handleScroll = () => closeMenu();
    document.addEventListener('mousedown', handleMouseDownOutside);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);
    return () => {
      document.removeEventListener('mousedown', handleMouseDownOutside);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [menuPosition, closeMenu]);

  const openWithLabel = i18nService.t('fileOpenWith');
  const copyPathLabel = i18nService.t('fileCopyPath');
  const copyContentLabel = i18nService.t('fileCopyContent');
  const openWithDefaultLabel = i18nService.t('fileOpenWithDefault');
  const chooseOtherAppLabel = i18nService.t('fileChooseOtherApp');
  const noAppsLabel = i18nService.t('fileOpenWithNoApps');
  const copiedLabel = i18nService.t('fileCopied');

  return (
    <span
      className="inline-flex items-center"
      onContextMenu={handleContextMenu}
    >
      <a
        href={href ?? filePath}
        onClick={handleOpenClick}
        className={className}
        title={title ?? filePath}
        style={{ cursor: 'pointer' }}
      >
        {children}
        {showTypeIcon && (isDirectory ? (
          <FolderIcon className="h-3.5 w-3.5 inline" />
        ) : (
          <DocumentIcon className="h-3.5 w-3.5 inline" />
        ))}
      </a>

      {menuPosition && (
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-50 min-w-[208px] rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-lg overflow-hidden"
          style={{ left: menuPosition.x, top: menuPosition.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div
            className="relative"
            onMouseEnter={openSubmenu}
            onMouseLeave={scheduleCloseSubmenu}
          >
            <button
              ref={openWithButtonRef}
              type="button"
              role="menuitem"
              onClick={(event) => event.preventDefault()}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
            >
              <Squares2X2Icon className="h-4 w-4 flex-shrink-0" />
              <span className="flex-1">{openWithLabel}</span>
              <ChevronRightIcon className="h-3.5 w-3.5 flex-shrink-0 opacity-60" />
            </button>

            {openWithOpen && submenuPosition && (
              <div
                ref={submenuRef}
                role="menu"
                className="fixed z-50 min-w-[220px] rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-lg overflow-hidden py-1"
                style={{ left: submenuPosition.x, top: submenuPosition.y }}
                onContextMenu={(event) => event.preventDefault()}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={openWithDefault}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                >
                  <ComputerDesktopIcon className="h-4 w-4 flex-shrink-0" />
                  {openWithDefaultLabel}
                </button>

                {apps?.map((app) => (
                  <button
                    key={app.id}
                    type="button"
                    role="menuitem"
                    onClick={() => openWithApp(app.id)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                  >
                    <DocumentIcon className="h-4 w-4 flex-shrink-0" />
                    <span className="truncate">{app.name}</span>
                  </button>
                ))}

                {!appsLoading && apps !== null && apps.length === 0 && (
                  <div className="px-3 py-2 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {noAppsLabel}
                  </div>
                )}

                <div className="my-1 h-px dark:bg-claude-darkBorder bg-claude-border" />

                <button
                  type="button"
                  role="menuitem"
                  onClick={chooseOtherApp}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                >
                  <FolderOpenIcon className="h-4 w-4 flex-shrink-0" />
                  {chooseOtherAppLabel}
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            role="menuitem"
            onClick={copyPath}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
          >
            {copiedKind === 'path' ? (
              <CheckIcon className="h-4 w-4 flex-shrink-0 text-green-500" />
            ) : (
              <ClipboardDocumentIcon className="h-4 w-4 flex-shrink-0" />
            )}
            {copiedKind === 'path' ? copiedLabel : copyPathLabel}
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={copyContent}
            disabled={isDirectory}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-40 disabled:hover:bg-transparent disabled:dark:hover:bg-transparent disabled:cursor-not-allowed"
          >
            {copiedKind === 'content' ? (
              <CheckIcon className="h-4 w-4 flex-shrink-0 text-green-500" />
            ) : (
              <DocumentDuplicateIcon className="h-4 w-4 flex-shrink-0" />
            )}
            {copiedKind === 'content' ? copiedLabel : copyContentLabel}
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={revealInFolder}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
          >
            <FolderOpenIcon className="h-4 w-4 flex-shrink-0" />
            {revealLabel}
          </button>
        </div>
      )}
    </span>
  );
};

const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
};

export default LocalFileLink;
