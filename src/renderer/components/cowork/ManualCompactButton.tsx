import React, { useState } from 'react';
import { ArrowsPointingInIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { coworkService } from '../../services/cowork';

interface ManualCompactButtonProps {
  sessionId: string;
  /** Current context-window usage ratio (0..1); hides the button below the threshold. */
  usageRatio: number;
  /** Button only appears once usage crosses this ratio (default 40%). */
  visibleRatio?: number;
  /** Disable while a turn is running. */
  disabled?: boolean;
}

/**
 * Manual context-compaction trigger shown next to the usage panel in the
 * Cowork header (Phase 3). It only appears once context usage is high enough
 * (default 40%) so it never clutters early conversations, and it queues the
 * compaction for the next local-mode turn on leftover Claude sessions; DSH
 * sessions compact immediately via native compactNow. The user keeps chatting
 * from the compacted history.
 */
const ManualCompactButton: React.FC<ManualCompactButtonProps> = ({
  sessionId,
  usageRatio,
  visibleRatio = 0.4,
  disabled = false,
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!Number.isFinite(usageRatio) || usageRatio < visibleRatio) {
    return null;
  }

  const label = i18nService.t('coworkManualCompact');
  const handleClick = async () => {
    if (busy || disabled) return;
    setBusy(true);
    setError(null);
    try {
      const result = await coworkService.requestManualCompaction(sessionId);
      if (!result.success) {
        setError(result.error || i18nService.t('coworkManualCompactFailed'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : i18nService.t('coworkManualCompactFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative inline-flex flex-col items-end">
      <button
        type="button"
        onClick={() => { void handleClick(); }}
        disabled={disabled || busy}
        title={error ?? label}
        aria-label={label}
        className="p-1.5 rounded-lg text-xs font-medium transition-colors dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:hover:text-claude-darkText hover:text-claude-text disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <ArrowsPointingInIcon className="h-4 w-4" />
      </button>
      {error && (
        <span className="absolute top-full right-0 z-20 mt-1 whitespace-nowrap rounded-md border border-red-200 dark:border-red-800/60 bg-white dark:bg-claude-darkBg px-1.5 py-0.5 text-[10px] text-red-500 dark:text-red-400 shadow-sm">
          {error}
        </span>
      )}
    </div>
  );
};

export default ManualCompactButton;
