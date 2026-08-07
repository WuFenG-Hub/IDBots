import React, { useState, useRef, useEffect } from 'react';
import { i18nService } from '../../services/i18n';
import type { CoworkUsageStats } from '../../types/cowork';

/**
 * DeepSeek V4 pricing (CNY per 1M tokens). Standard off-peak rates from the
 * official DeepSeek pricing page (api-docs.deepseek.com), denominated in CNY to
 * match the wallet balance display (the DeepSeek account is billed in CNY).
 * Peak-hour rates double (9:00–12:00 / 14:00–18:00 Beijing time) — not modeled
 * here; the displayed cost is an ESTIMATE at standard rates.
 */
const DEEPSEEK_RATES: Record<string, { cacheHitPerM: number; cacheMissPerM: number; outputPerM: number }> = {
  'deepseek-v4-pro': { cacheHitPerM: 0.025, cacheMissPerM: 3, outputPerM: 6 },
  'deepseek-v4-flash': { cacheHitPerM: 0.02, cacheMissPerM: 1, outputPerM: 2 },
};

/** Defaults to the cheapest tier when the model id is unknown. */
const DEEPSEEK_DEFAULT_RATE = DEEPSEEK_RATES['deepseek-v4-flash'];

function estimateDeepSeekCostCNY(model: string | undefined, stats: CoworkUsageStats): number {
  const rate = (model && DEEPSEEK_RATES[model]) || DEEPSEEK_DEFAULT_RATE;
  return (
    (stats.cacheReadTokens / 1_000_000) * rate.cacheHitPerM
    + (stats.cacheCreationTokens / 1_000_000) * rate.cacheMissPerM
    + (stats.inputTokens / 1_000_000) * rate.cacheMissPerM
    + (stats.outputTokens / 1_000_000) * rate.outputPerM
  );
}

const formatTokens = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
};

const formatCNY = (value: number): string => `¥${value.toFixed(4)}`;

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

interface UsageStatsChipProps {
  usageStats: CoworkUsageStats;
  /** Current model id for DeepSeek rate lookup. */
  modelId?: string;
}

/**
 * Per-session token/cost indicator (DeepSeek-first). Shows a compact chip in
 * the session header with token total; hover reveals the breakdown: input /
 * output / cache hit / cache miss tokens, an estimated USD cost at DeepSeek
 * rates (for proxy sessions), or the SDK-priced cost (Anthropic direct).
 */
const UsageStatsChip: React.FC<UsageStatsChipProps> = ({ usageStats, modelId }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [balance, setBalance] = useState<BalanceSuccess['balance'] | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch the DeepSeek wallet balance fresh every time the panel opens, so the
  // readout reflects the latest spend without a background poll.
  const fetchBalance = React.useCallback(async () => {
    const result = await window.electron.deepseek.getBalance();
    if (result.success === true) {
      setBalance(result.balance);
      setBalanceError(null);
    } else {
      setBalance(null);
      setBalanceError(result.error);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    void fetchBalance();
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, fetchBalance]);

  const totalTokens = usageStats.inputTokens + usageStats.outputTokens
    + usageStats.cacheReadTokens + usageStats.cacheCreationTokens;

  if (totalTokens <= 0) return null;

  const isDeepSeek = usageStats.source === 'deepseek';
  const estimatedCost = isDeepSeek
    ? estimateDeepSeekCostCNY(modelId, usageStats)
    : (usageStats.totalCostUsd ?? 0);
  const showCost = estimatedCost > 0;
  // Session cache-hit rate. Two numbers with different meaning:
  // - cacheHitRate: cumulative over ALL turns (diluted by the T1 cold start,
  //   which is 100% miss by definition — nothing is cached yet).
  // - warmCacheHitRate: cumulative EXCLUDING the first turn, i.e. the rate on
  //   a warm prefix. This matches what the DeepSeek dashboard reports (per-
  //   request hit rate) much more closely than the all-turn average.
  // The chip button shows the warm rate as the primary signal.
  const cacheDenominator = usageStats.cacheReadTokens + usageStats.cacheCreationTokens;
  const cacheHitRate = cacheDenominator > 0
    ? Math.round((usageStats.cacheReadTokens / cacheDenominator) * 100)
    : null;
  const turnStats = usageStats.turnStats ?? [];
  // Exclude the first turn (T1 cold start). turnStats entries are appended in
  // order, so index 0 is T1.
  const warmTurns = turnStats.length > 1 ? turnStats.slice(1) : [];
  const warmHit = warmTurns.reduce((sum, t) => sum + t.cacheHitTokens, 0);
  const warmMiss = warmTurns.reduce((sum, t) => sum + t.cacheMissTokens, 0);
  const warmDenom = warmHit + warmMiss;
  const warmCacheHitRate = warmDenom > 0
    ? Math.round((warmHit / warmDenom) * 100)
    : null;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 rounded-lg border dark:border-claude-darkBorder border-claude-border px-2 py-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:bg-claude-darkSurfaceInset hover:bg-claude-surfaceInset transition-colors"
        title={i18nService.t('coworkUsageStatsTitle')}
      >
        <span className="text-[11px]">∑</span>
        <span className="font-medium">{formatTokens(totalTokens)}</span>
        {/* Show the warm-cache rate (excl. T1 cold start) as the primary signal.
            Falls back to the cumulative rate when only one turn has run. */}
        {warmCacheHitRate !== null && <span className="text-[10px] opacity-80">{warmCacheHitRate}%</span>}
      </button>
      {isOpen && (
        <div className="absolute right-0 bottom-full mb-2 w-60 rounded-xl shadow-xl dark:bg-claude-darkBg bg-claude-bg dark:border-claude-darkBorder border-claude-border border p-3 z-50">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold dark:text-claude-darkText text-claude-text">
              {i18nService.t('coworkUsageStatsTitle')}
            </span>
            {isDeepSeek && (
              <span className="text-[10px] dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">
                {i18nService.t('coworkUsageStatsEstimated')}
              </span>
            )}
          </div>
          <div className="mt-2 space-y-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
            <div className="flex justify-between"><span>{i18nService.t('coworkUsageInput')}</span><span className="font-mono">{formatTokens(usageStats.inputTokens)}</span></div>
            <div className="flex justify-between"><span>{i18nService.t('coworkUsageOutput')}</span><span className="font-mono">{formatTokens(usageStats.outputTokens)}</span></div>
            <div className="flex justify-between"><span>{i18nService.t('coworkUsageCacheHit')}</span><span className="font-mono">{formatTokens(usageStats.cacheReadTokens)}</span></div>
            <div className="flex justify-between"><span>{i18nService.t('coworkUsageCacheMiss')}</span><span className="font-mono">{formatTokens(usageStats.cacheCreationTokens)}</span></div>
          </div>
          {(() => {
            // Cache-hit rates, three meanings:
            //   cumulative (all turns, diluted by T1 cold start),
            //   warm (excluding T1 — the honest per-request rate, matches the
            //        DeepSeek dashboard), and last-turn (current prefix state).
            if (cacheDenominator <= 0) return null;
            const lastTurn = turnStats[turnStats.length - 1];
            const lastTurnRate = lastTurn
              ? Math.round((lastTurn.cacheHitTokens / Math.max(lastTurn.cacheHitTokens + lastTurn.cacheMissTokens, 1)) * 100)
              : null;
            const recentMisses = (usageStats.cacheMissEvents ?? []).slice(-3);
            return (
              <div className="mt-2 pt-2 border-t dark:border-claude-darkBorder/60 border-claude-border/60 space-y-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                <div className="flex justify-between">
                  <span>{i18nService.t('deepseekCacheHitRate')} ({i18nService.t('deepseekCacheHitRateAll')})</span>
                  <span className="font-mono">{cacheHitRate}%</span>
                </div>
                {warmCacheHitRate !== null && (
                  <div className="flex justify-between">
                    <span className="font-medium dark:text-claude-darkText text-claude-text">{i18nService.t('deepseekCacheHitRate')} ({i18nService.t('deepseekCacheHitRateWarm')})</span>
                    <span className="font-mono font-medium dark:text-claude-darkText text-claude-text">{warmCacheHitRate}%</span>
                  </div>
                )}
                {lastTurnRate !== null && (
                  <div className="flex justify-between">
                    <span>{i18nService.t('deepseekLastTurnCacheHitRate')}</span>
                    <span className="font-mono">{lastTurnRate}%</span>
                  </div>
                )}
                {recentMisses.length > 0 && (
                  <div className="space-y-0.5 opacity-70">
                    {recentMisses.map((evt) => (
                      <div key={evt.turn} className="flex justify-between">
                        <span>T{evt.turn} · {evt.reason}</span>
                        <span className="font-mono">{formatTokens(evt.missTokens)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
          {showCost && (
            <div className="mt-2 pt-2 border-t dark:border-claude-darkBorder/60 border-claude-border/60 flex items-center justify-between text-[11px]">
              <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {isDeepSeek ? i18nService.t('coworkUsageEstimatedCost') : i18nService.t('coworkUsageCost')}
              </span>
              <span className="font-mono font-medium dark:text-claude-darkText text-claude-text">
                {isDeepSeek ? formatCNY(estimatedCost) : `$${estimatedCost.toFixed(4)}`}
              </span>
            </div>
          )}
          {isDeepSeek && (
            <div className="mt-2 pt-2 border-t dark:border-claude-darkBorder/60 border-claude-border/60 flex items-center justify-between text-[11px]">
              <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('deepseekBalanceTitle')}
              </span>
              {balanceError ? (
                <span className="font-mono text-red-400" title={balanceError}>—</span>
              ) : (
                <span className="font-mono font-medium dark:text-claude-darkText text-claude-text">
                  {balance?.display ?? '…'}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default UsageStatsChip;
