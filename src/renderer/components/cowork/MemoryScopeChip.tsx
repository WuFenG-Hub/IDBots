import React, { useCallback, useEffect, useRef, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { coworkService } from '../../services/cowork';
import type { CoworkSessionMemoryScope, CoworkUserMemoryEntry } from '../../types/cowork';

interface MemoryScopeChipProps {
  sessionId: string;
}

function formatMemoryUpdatedAt(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '-';
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return '-';
  }
}

/**
 * Per-session memory indicator. Shows which memory scope the current session
 * reads/writes (owner for local sessions, contact/conversation for external
 * ones) plus the entry count; clicking reveals the recent entries of that
 * scope. Read-only preview — management stays in Settings → Memory.
 */
const MemoryScopeChip: React.FC<MemoryScopeChipProps> = ({ sessionId }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [sessionScope, setSessionScope] = useState<CoworkSessionMemoryScope | null>(null);
  const [entries, setEntries] = useState<CoworkUserMemoryEntry[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const scope = await coworkService.getSessionMemoryScope({ sessionId });
    setSessionScope(scope);
    if (scope) {
      const list = await coworkService.listMemoryEntries({ sessionId, limit: 8 });
      setEntries(list);
    } else {
      setEntries([]);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!isOpen) return;
    void refresh();
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, refresh]);

  const activeCount = sessionScope
    ? sessionScope.stats.created + sessionScope.stats.stale
    : 0;
  if (!sessionScope || activeCount <= 0) {
    return null;
  }

  const scopeLabel = sessionScope.scopeKind === 'contact'
    ? `${i18nService.t('coworkMemoryChipContactLabel')}${sessionScope.peerName ? `: ${sessionScope.peerName}` : ''}`
    : sessionScope.scopeKind === 'conversation'
      ? i18nService.t('coworkMemoryChipConversationLabel')
      : i18nService.t('coworkMemoryChipOwnerLabel');

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 rounded-lg border dark:border-claude-darkBorder border-claude-border px-2 py-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:bg-claude-darkSurfaceInset hover:bg-claude-surfaceInset transition-colors"
        title={i18nService.t('coworkMemoryChipTitle')}
      >
        <span className="text-[11px]">🧠</span>
        <span className="font-medium max-w-[140px] truncate">{scopeLabel}</span>
        <span className="text-[10px] opacity-80">{activeCount}</span>
      </button>
      {isOpen && (
        <div className="absolute right-0 bottom-full mb-2 w-80 rounded-xl shadow-xl dark:bg-claude-darkBg bg-claude-bg dark:border-claude-darkBorder border-claude-border border p-3 z-50">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold dark:text-claude-darkText text-claude-text">
              {`${i18nService.t('coworkMemoryChipTitle')} · ${scopeLabel}`}
            </span>
            <span className="text-[10px] dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">
              {`${activeCount} ${i18nService.t('coworkMemoryChipCountLabel')}`}
            </span>
          </div>
          <div className="mt-2 max-h-[300px] overflow-auto rounded-lg border dark:border-claude-darkBorder border-claude-border">
            {entries.length === 0 ? (
              <div className="px-3 py-3 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('coworkMemoryChipEmpty')}
              </div>
            ) : (
              <div className="divide-y dark:divide-claude-darkBorder divide-claude-border">
                {entries.map((entry) => (
                  <div key={entry.id} className="px-3 py-2 text-[11px]">
                    <div className="dark:text-claude-darkText text-claude-text break-words line-clamp-3">
                      {entry.text}
                    </div>
                    <div className="mt-0.5 dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                      {formatMemoryUpdatedAt(entry.updatedAt)}
                      {entry.visibility === 'external_safe' && (
                        <span className="ml-1 text-emerald-600 dark:text-emerald-400">
                          · {i18nService.t('coworkMemoryVisibilityExternalSafe')}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="mt-2 text-[10px] dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">
            {i18nService.t('coworkMemoryChipManageHint')}
          </div>
        </div>
      )}
    </div>
  );
};

export default MemoryScopeChip;
