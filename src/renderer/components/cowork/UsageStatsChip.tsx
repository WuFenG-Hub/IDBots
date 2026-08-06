import React, { useState, useRef, useEffect } from 'react';
import { i18nService } from '../../services/i18n';
import type { CoworkUsageStats } from '../../types/cowork';

/**
 * DeepSeek V4 pricing (USD per 1M tokens). Standard off-peak rates from the
 * official DeepSeek pricing page (api-docs.deepseek.com). Peak-hour rates
 * double (9:00–12:00 / 14:00–18:00 Beijing time) — not modeled here; the
 * displayed cost is an ESTIMATE at standard rates.
 */
const DEEPSEEK_RATES: Record<string, { cacheHitPerM: number; cacheMissPerM: number; outputPerM: number }> = {
  'deepseek-v4-pro': { cacheHitPerM: 0.003625, cacheMissPerM: 0.435, outputPerM: 0.87 },
  'deepseek-v4-flash': { cacheHitPerM: 0.0028, cacheMissPerM: 0.14, outputPerM: 0.28 },
};

/** Defaults to the cheapest tier when the model id is unknown. */
const DEEPSEEK_DEFAULT_RATE = DEEPSEEK_RATES['deepseek-v4-flash'];

function estimateDeepSeekCostUSD(model: string | undefined, stats: CoworkUsageStats): number {
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

const formatUSD = (value: number): string => `$${value.toFixed(4)}`;

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
  const containerRef = useRef<HTMLDivElement>(null);

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

  const totalTokens = usageStats.inputTokens + usageStats.outputTokens
    + usageStats.cacheReadTokens + usageStats.cacheCreationTokens;

  if (totalTokens <= 0) return null;

  const isDeepSeek = usageStats.source === 'deepseek';
  const estimatedCost = isDeepSeek
    ? estimateDeepSeekCostUSD(modelId, usageStats)
    : (usageStats.totalCostUsd ?? 0);
  const showCost = estimatedCost > 0;

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
        {showCost && <span className="text-[10px] opacity-80">{formatUSD(estimatedCost)}</span>}
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
            // Cache-hit rate + lightweight miss attribution (diagnostics).
            const denom = usageStats.cacheReadTokens + usageStats.cacheCreationTokens;
            if (denom <= 0) return null;
            const hitRate = Math.round((usageStats.cacheReadTokens / denom) * 100);
            const recentMisses = (usageStats.cacheMissEvents ?? []).slice(-3);
            return (
              <div className="mt-2 pt-2 border-t dark:border-claude-darkBorder/60 border-claude-border/60 space-y-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                <div className="flex justify-between">
                  <span>{i18nService.t('deepseekCacheHitRate')}</span>
                  <span className="font-mono font-medium dark:text-claude-darkText text-claude-text">{hitRate}%</span>
                </div>
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
                {formatUSD(estimatedCost)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default UsageStatsChip;
