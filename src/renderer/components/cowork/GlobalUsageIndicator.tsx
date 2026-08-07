import React, { useState, useRef, useEffect } from 'react';
import { useSelector } from 'react-redux';
import { i18nService } from '../../services/i18n';
import type { RootState } from '../../store';

/** Balance result shape mirroring the main-process DeepSeekBalanceResult. */
type BalanceSuccess = {
  success: true;
  balance: {
    available: boolean;
    display: string;
    infos: Array<{
      currency: string;
      totalBalance: number;
      grantedBalance: number;
      toppedUpBalance: number;
    }>;
  };
};

const formatTokens = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
};

/**
 * Always-visible usage indicator for the sidebar footer. Shows the DeepSeek
 * wallet balance (global, session-independent) and, when a cowork session is
 * active, the current session's cache-hit rate + token total. Hover reveals the
 * full breakdown (per-currency balance + cache-miss attribution).
 *
 * This is the Reasonix-style "status bar" surface: visible across every view
 * and every conversation type, not just cowork sessions.
 *
 * Data sources:
 *  - Balance: fetched on mount + on manual refresh via the deepseek:getBalance IPC.
 *  - Cache/tokens: read from Redux (state.cowork.currentSession.usageStats),
 *    which is refreshed by the cowork service after each stream completion.
 *    Sessions that bypass CoworkRunner (private-chat/group-task daemons via the
 *    cognitive layer) do not accumulate usageStats yet, so the indicator falls
 *    back to balance-only in those contexts.
 */
const GlobalUsageIndicator: React.FC = () => {
  const [balance, setBalance] = useState<BalanceSuccess['balance'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Current cowork session usage (may be null for non-cowork views).
  const usageStats = useSelector((state: RootState) => state.cowork.currentSession?.usageStats ?? null);

  const fetchBalance = React.useCallback(async () => {
    const result = await window.electron.deepseek.getBalance();
    if (result.success === true) {
      setBalance(result.balance);
      setError(null);
    } else {
      setBalance(null);
      setError(result.error);
    }
  }, []);

  useEffect(() => {
    void fetchBalance();
  }, [fetchBalance]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const cacheDenominator = usageStats
    ? usageStats.cacheReadTokens + usageStats.cacheCreationTokens
    : 0;
  const cacheHitRate = cacheDenominator > 0
    ? Math.round((usageStats!.cacheReadTokens / cacheDenominator) * 100)
    : null;
  // Warm-cache rate: exclude the T1 cold start (100% miss by definition) so the
  // displayed number matches the DeepSeek dashboard's per-request hit rate.
  const turnStats = usageStats?.turnStats ?? [];
  const warmTurns = turnStats.length > 1 ? turnStats.slice(1) : [];
  const warmHit = warmTurns.reduce((sum, t) => sum + t.cacheHitTokens, 0);
  const warmMiss = warmTurns.reduce((sum, t) => sum + t.cacheMissTokens, 0);
  const warmDenom = warmHit + warmMiss;
  const warmCacheHitRate = warmDenom > 0
    ? Math.round((warmHit / warmDenom) * 100)
    : null;
  const totalTokens = usageStats
    ? usageStats.inputTokens + usageStats.outputTokens
      + usageStats.cacheReadTokens + usageStats.cacheCreationTokens
    : 0;

  // Hide entirely if there is no balance AND no usage data (e.g. no DeepSeek key).
  if (!balance && !error && warmCacheHitRate === null && cacheHitRate === null) return null;

  const display = balance?.display ?? (error ? '—' : '…');

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setIsOpen(!isOpen);
          if (!balance) void fetchBalance();
        }}
        className="flex items-center gap-1.5 rounded-md px-1.5 py-1.5 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:bg-claude-darkSurfaceInset hover:bg-claude-surfaceInset transition-colors"
        title={i18nService.t('deepseekBalanceTitle')}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-70 shrink-0">
          <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2" />
          <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
        </svg>
        <span className="font-medium tabular-nums">{display}</span>
        {/* Show the warm-cache rate (excl. T1 cold start) as the primary signal. */}
        {(warmCacheHitRate ?? cacheHitRate) !== null && (
          <>
            <span className="opacity-30">·</span>
            <span className="tabular-nums opacity-80">{warmCacheHitRate ?? cacheHitRate}%</span>
          </>
        )}
      </button>
      {isOpen && (
        <div className="absolute left-0 bottom-full mb-2 w-64 rounded-xl shadow-xl dark:bg-claude-darkBg bg-claude-bg dark:border-claude-darkBorder border-claude-border border p-3 z-50">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold dark:text-claude-darkText text-claude-text">
              {i18nService.t('deepseekBalanceTitle')}
            </span>
            <button
              type="button"
              onClick={() => void fetchBalance()}
              className="text-[10px] dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60 hover:opacity-80"
            >
              ↻ {i18nService.t('deepseekBalanceRefresh')}
            </button>
          </div>
          {error ? (
            <div className="mt-2 text-[11px] text-red-400">{error}</div>
          ) : balance ? (
            <div className="mt-2 space-y-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {balance.infos.map((info) => (
                <div key={info.currency} className="flex justify-between">
                  <span>{info.currency}</span>
                  <span className="font-mono">{info.totalBalance.toFixed(2)}</span>
                </div>
              ))}
              {balance.infos.length > 0 && (
                <div className="flex justify-between pt-1 border-t dark:border-claude-darkBorder/60 border-claude-border/60">
                  <span className="opacity-70">{i18nService.t('deepseekBalanceGranted')}</span>
                  <span className="font-mono opacity-80">
                    {balance.infos[0].grantedBalance.toFixed(2)}
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div className="mt-2 text-[11px] opacity-60">…</div>
          )}
          {usageStats && totalTokens > 0 && (
            <div className="mt-2 pt-2 border-t dark:border-claude-darkBorder/60 border-claude-border/60 space-y-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
              <div className="flex justify-between font-medium dark:text-claude-darkText text-claude-text">
                <span>{i18nService.t('coworkUsageStatsTitle')}</span>
                <span className="font-mono">{formatTokens(totalTokens)}</span>
              </div>
              <div className="flex justify-between">
                <span>{i18nService.t('deepseekCacheHitRate')} ({i18nService.t('deepseekCacheHitRateAll')})</span>
                <span className="font-mono">{cacheHitRate ?? 0}%</span>
              </div>
              {warmCacheHitRate !== null && (
                <div className="flex justify-between">
                  <span className="font-medium dark:text-claude-darkText text-claude-text">{i18nService.t('deepseekCacheHitRate')} ({i18nService.t('deepseekCacheHitRateWarm')})</span>
                  <span className="font-mono font-medium dark:text-claude-darkText text-claude-text">{warmCacheHitRate}%</span>
                </div>
              )}
              {(() => {
                const turnStats = usageStats.turnStats ?? [];
                const lastTurn = turnStats[turnStats.length - 1];
                if (!lastTurn) return null;
                const lastTurnRate = Math.round((lastTurn.cacheHitTokens / Math.max(lastTurn.cacheHitTokens + lastTurn.cacheMissTokens, 1)) * 100);
                return (
                  <div className="flex justify-between">
                    <span>{i18nService.t('deepseekLastTurnCacheHitRate')}</span>
                    <span className="font-mono">{lastTurnRate}%</span>
                  </div>
                );
              })()}
              <div className="flex justify-between">
                <span>{i18nService.t('coworkUsageInput')}</span>
                <span className="font-mono">{formatTokens(usageStats.inputTokens)}</span>
              </div>
              <div className="flex justify-between">
                <span>{i18nService.t('coworkUsageOutput')}</span>
                <span className="font-mono">{formatTokens(usageStats.outputTokens)}</span>
              </div>
              <div className="flex justify-between">
                <span>{i18nService.t('coworkUsageCacheHit')}</span>
                <span className="font-mono">{formatTokens(usageStats.cacheReadTokens)}</span>
              </div>
              <div className="flex justify-between">
                <span>{i18nService.t('coworkUsageCacheMiss')}</span>
                <span className="font-mono">{formatTokens(usageStats.cacheCreationTokens)}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default GlobalUsageIndicator;
