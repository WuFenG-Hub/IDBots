import React, { useCallback, useMemo } from 'react';
import { useSelector } from 'react-redux';
import type { RootState } from '../../store';
import { i18nService } from '../../services/i18n';
import { ArrowRightIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';

interface CoworkPermissionOverlayProps {
  /**
   * Session whose permission prompt is already rendered inline by
   * CoworkSessionDetail (the open chat), or null when no inline seat is
   * mounted. Prompts for any OTHER session surface in this overlay.
   */
  inlineSessionId: string | null;
}

/**
 * Global fallback seat for cowork permission prompts. CoworkSessionDetail only
 * renders prompts for the currently open chat, so prompts raised by background,
 * IM-automation or hidden sessions would otherwise queue with nowhere to
 * render and burn the runner's 60s watchdog into an automatic denial. This
 * overlay floats above every view and links back to the owning session. The
 * session's composer takeover remains the single place where users answer.
 */
const CoworkPermissionOverlay: React.FC<CoworkPermissionOverlayProps> = ({ inlineSessionId }) => {
  const pendingPermissions = useSelector((state: RootState) => state.cowork.pendingPermissions);
  const sessions = useSelector((state: RootState) => state.cowork.sessions);
  const permission = useMemo(
    () => pendingPermissions.find((entry) => entry.sessionId !== inlineSessionId) ?? null,
    [pendingPermissions, inlineSessionId],
  );
  const sessionTitle = useMemo(() => {
    if (!permission) return null;
    return sessions.find((session) => session.id === permission.sessionId)?.title ?? null;
  }, [permission, sessions]);

  const summary = useMemo(() => {
    if (!permission) return '';
    if (permission.toolName !== 'AskUserQuestion') return permission.toolName;
    const questions = permission.toolInput?.questions;
    if (!Array.isArray(questions)) return permission.toolName;
    const first = questions.find((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>).question === 'string');
    return first ? String((first as Record<string, unknown>).question) : permission.toolName;
  }, [permission]);

  const handleOpenSession = useCallback(() => {
    if (!permission) return;
    window.dispatchEvent(new CustomEvent('cowork:viewSession', { detail: { sessionId: permission.sessionId } }));
  }, [permission]);

  if (!permission) return null;

  return (
    <div
      className="fixed right-4 top-14 z-[90] w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-claude-border bg-claude-surface shadow-elevated animate-slide-up dark:border-claude-darkBorder dark:bg-claude-darkSurface"
      data-cowork-permission-overlay="true"
    >
      <div className="flex items-start gap-3 p-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-yellow-500/10 text-yellow-600 dark:text-yellow-400">
          <ExclamationTriangleIcon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-claude-text dark:text-claude-darkText">
            {i18nService.t('coworkGlobalPermissionTitle')}
          </p>
          {sessionTitle && <p className="mt-0.5 truncate text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">{sessionTitle}</p>}
          <p className="mt-1 line-clamp-2 text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">{summary}</p>
        </div>
        <button
          type="button"
          onClick={handleOpenSession}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-claude-accent transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
        >
          {i18nService.t('coworkGlobalPermissionOpenSession')}
          <ArrowRightIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
};

export default CoworkPermissionOverlay;
