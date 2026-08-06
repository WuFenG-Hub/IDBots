import React, { useState, useRef, useEffect } from 'react';
import { i18nService } from '../../services/i18n';
import type { CoworkUsageStats } from '../../types/cowork';

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

interface DeepSeekBalanceChipProps {
  /** Per-session usage stats, used to show the cache-hit rate alongside balance. */
  usageStats?: CoworkUsageStats;
}

/**
 * DeepSeek wallet balance indicator. Fetches GET /user/balance via IPC and
 * shows a compact chip with the remaining balance; hover reveals the per-
 * currency breakdown and the current session's cache-hit rate.
 *
 * Refresh is caller-driven (the parent re-mounts or bumps `refreshKey` after a
 * turn completes) rather than on a fixed timer, mirroring Reasonix's event-
 * driven balance refresh.
 */
const DeepSeekBalanceChip: React.FC<DeepSeekBalanceChipProps> = ({ usageStats }) => {
  const [balance, setBalance] = useState<BalanceSuccess['balance'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

  // Cache-hit rate from per-session stats (0–100%).
  const cacheDenominator = usageStats
    ? usageStats.cacheReadTokens + usageStats.cacheCreationTokens
    : 0;
  const cacheHitRate = cacheDenominator > 0
    ? Math.round((usageStats!.cacheReadTokens / cacheDenominator) * 100)
    : null;

  // Nothing to show if balance is unavailable and there are no usage stats.
  if (!balance && !error && cacheHitRate === null) return null;

  const display = balance?.display ?? (error ? '—' : '…');
  const unavailable = balance && !balance.available;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setIsOpen(!isOpen);
          if (!balance) void fetchBalance();
        }}
        className="flex items-center gap-1 rounded-lg border dark:border-claude-darkBorder border-claude-border px-2 py-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:bg-claude-darkSurfaceInset hover:bg-claude-surfaceInset transition-colors"
        title={i18nService.t('deepseekBalanceTitle')}
      >
        {/* Wallet icon */}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-70">
          <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2" />
          <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
        </svg>
        <span className="font-medium">{display}</span>
        {cacheHitRate !== null && (
          <span className="text-[10px] opacity-70">{cacheHitRate}%</span>
        )}
        {unavailable && (
          <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-red-400" title={i18nService.t('deepseekBalanceUnavailable')} />
        )}
      </button>
      {isOpen && (
        <div className="absolute right-0 bottom-full mb-2 w-64 rounded-xl shadow-xl dark:bg-claude-darkBg bg-claude-bg dark:border-claude-darkBorder border-claude-border border p-3 z-50">
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
          {cacheHitRate !== null && (
            <div className="mt-2 pt-2 border-t dark:border-claude-darkBorder/60 border-claude-border/60 flex items-center justify-between text-[11px]">
              <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('deepseekCacheHitRate')}
              </span>
              <span className="font-mono font-medium dark:text-claude-darkText text-claude-text">
                {cacheHitRate}%
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default DeepSeekBalanceChip;
