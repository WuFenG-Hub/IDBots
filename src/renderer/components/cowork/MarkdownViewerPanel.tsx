import React, { useEffect, useState } from 'react';
import { ArrowTopRightOnSquareIcon, DocumentIcon, XMarkIcon } from '@heroicons/react/24/outline';
import MarkdownContent from '../MarkdownContent';
import { i18nService } from '../../services/i18n';
import { formatBytes } from '../update/format';

interface MarkdownViewerPanelProps {
  /** Absolute path of the markdown document to render. */
  filePath: string;
  onClose: () => void;
  /** Open another markdown document in this same panel (chained .md links). */
  onOpenFile: (filePath: string) => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; error: string; size?: number; limit?: number }
  | { status: 'loaded'; content: string };

const getFileName = (filePath: string): string => {
  const segments = filePath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? filePath;
};

const showToast = (message: string): void => {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

/**
 * Right-hand sidebar that renders a local markdown document inside the app,
 * so users without a markdown-capable external editor can still read files
 * the Agent produced. Content is loaded through the main process
 * (`fs:readTextFile`, utf8, size-capped) and rendered with the shared
 * MarkdownContent component.
 */
const MarkdownViewerPanel: React.FC<MarkdownViewerPanelProps> = ({ filePath, onClose, onOpenFile }) => {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const result = await window.electron.fs.readTextFile(filePath);
        if (cancelled) return;
        if (result?.success && typeof result.content === 'string') {
          setState({ status: 'loaded', content: result.content });
        } else {
          setState({
            status: 'error',
            error: result?.error ?? 'unknown',
            size: result?.size,
            limit: result?.limit,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setState({ status: 'error', error: error instanceof Error ? error.message : String(error) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const openExternally = () => {
    void (async () => {
      try {
        const result = await window.electron.shell.openPath(filePath);
        if (!result?.success) {
          showToast(i18nService.t('openFileFailed'));
        }
      } catch {
        showToast(i18nService.t('openFileFailed'));
      }
    })();
  };

  const errorMessage = state.status === 'error'
    ? (() => {
        if (state.error === 'file_too_large' && typeof state.limit === 'number') {
          return i18nService.t('markdownViewerTooLarge').replace('{limit}', formatBytes(state.limit));
        }
        if (state.error === 'file_not_found' || state.error === 'not_a_file') {
          return i18nService.t('markdownViewerFileMissing');
        }
        return i18nService.t('markdownViewerLoadFailed');
      })()
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col dark:bg-claude-darkBg bg-claude-bg">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2 dark:border-claude-darkBorder border-claude-border">
        <DocumentIcon className="h-4 w-4 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
        <span
          className="min-w-0 flex-1 truncate text-xs font-medium dark:text-claude-darkText text-claude-text"
          title={filePath}
        >
          {getFileName(filePath)}
        </span>
        <button
          type="button"
          onClick={openExternally}
          className="h-6 w-6 inline-flex shrink-0 items-center justify-center rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          aria-label={i18nService.t('markdownViewerOpenExternal')}
          title={i18nService.t('markdownViewerOpenExternal')}
        >
          <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="h-6 w-6 inline-flex shrink-0 items-center justify-center rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          aria-label={i18nService.t('close')}
          title={i18nService.t('close')}
        >
          <XMarkIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {state.status === 'loading' ? (
        <div className="flex flex-1 items-center justify-center px-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('markdownViewerLoading')}
        </div>
      ) : state.status === 'error' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <p className="text-xs leading-5 dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {errorMessage}
          </p>
          <button
            type="button"
            onClick={openExternally}
            className="rounded-lg border px-2.5 py-1 text-xs dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          >
            {i18nService.t('markdownViewerOpenExternal')}
          </button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-2">
          <MarkdownContent
            content={state.content}
            compact
            onOpenLocalFile={(path) => {
              if (/\.(md|markdown)$/i.test(path)) {
                onOpenFile(path);
                return true;
              }
              return false;
            }}
          />
        </div>
      )}
    </div>
  );
};

export default MarkdownViewerPanel;
