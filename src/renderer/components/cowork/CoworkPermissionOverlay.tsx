import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import type { RootState } from '../../store';
import type { CoworkPermissionResult } from '../../types/cowork';
import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import CoworkPermissionPanel from './CoworkPermissionPanel';

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
 * overlay floats above every view; answers route back through
 * respondToPermission(requestId), which the runner resolves to the owning
 * session.
 */
const CoworkPermissionOverlay: React.FC<CoworkPermissionOverlayProps> = ({ inlineSessionId }) => {
  const pendingPermissions = useSelector((state: RootState) => state.cowork.pendingPermissions);
  const sessions = useSelector((state: RootState) => state.cowork.sessions);
  const permission = useMemo(
    () => pendingPermissions.find((entry) => entry.sessionId !== inlineSessionId) ?? null,
    [pendingPermissions, inlineSessionId],
  );
  const [responding, setResponding] = useState(false);

  useEffect(() => {
    setResponding(false);
  }, [permission?.requestId]);

  const sessionTitle = useMemo(() => {
    if (!permission) return null;
    return sessions.find((session) => session.id === permission.sessionId)?.title ?? null;
  }, [permission, sessions]);

  const handleRespond = useCallback(async (result: CoworkPermissionResult) => {
    if (!permission || responding) return;
    setResponding(true);
    const success = await coworkService.respondToPermission(permission.requestId, result);
    if (!success) setResponding(false);
  }, [permission, responding]);

  const handleOpenSession = useCallback(() => {
    if (!permission) return;
    window.dispatchEvent(new CustomEvent('cowork:viewSession', { detail: { sessionId: permission.sessionId } }));
  }, [permission]);

  if (!permission) return null;

  return (
    <div
      className="fixed top-14 right-4 z-[90] w-[min(480px,calc(100vw-2rem))] overflow-hidden rounded-[20px] border border-claude-accent/70 dark:border-claude-accent/50 bg-claude-surface dark:bg-claude-darkSurface shadow-elevated animate-slide-up"
      data-cowork-permission-overlay="true"
    >
      <div className="flex items-center gap-2 px-4 py-2.5 bg-claude-accent/20 dark:bg-claude-accent/15 text-[#7a5b00] dark:text-[#ffe47a] text-xs font-medium">
        <ExclamationTriangleIcon className="h-4 w-4 shrink-0" />
        <span className="truncate">
          {i18nService.t('coworkGlobalPermissionTitle')}
          {sessionTitle ? ` · ${sessionTitle}` : ''}
        </span>
        <button
          type="button"
          onClick={handleOpenSession}
          className="ml-auto shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium text-claude-textSecondary dark:text-claude-darkTextSecondary hover:bg-claude-accent/20 dark:hover:bg-claude-accent/15 transition-colors"
        >
          {i18nService.t('coworkGlobalPermissionOpenSession')}
        </button>
      </div>
      <div className="p-3">
        <CoworkPermissionPanel
          permission={permission}
          onRespond={handleRespond}
          responding={responding}
        />
      </div>
    </div>
  );
};

export default CoworkPermissionOverlay;
