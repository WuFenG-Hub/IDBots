import React from 'react';
import { i18nService } from '../services/i18n';

interface ContextUsageRingProps {
  /** Estimated tokens currently consumed by the conversation. */
  usedTokens: number;
  /** The model's total context window in tokens. */
  contextWindow: number;
  className?: string;
}

const RING_SIZE = 20;
const STROKE_WIDTH = 3;
const WARNING_RATIO = 0.82;
const CRITICAL_RATIO = 0.95;

/** Formats a token count in K units, e.g. 128000 -> "128K", 1048576 -> "1,049K". */
export function formatTokensK(value: number): string {
  const k = Math.max(0, Math.round(value / 1000));
  return `${k.toLocaleString('en-US')}K`;
}

const ContextUsageRing: React.FC<ContextUsageRingProps> = ({ usedTokens, contextWindow, className }) => {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }

  const ratio = Math.min(1, Math.max(0, usedTokens / contextWindow));
  const radius = (RING_SIZE - STROKE_WIDTH) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - ratio);
  const percent = Math.round(ratio * 100);

  const arcColorClass = ratio >= CRITICAL_RATIO
    ? 'text-red-500'
    : ratio >= WARNING_RATIO
      ? 'text-amber-500'
      : 'text-claude-accent';

  return (
    <div className={`relative group inline-flex items-center ${className ?? ''}`}>
      <svg
        width={RING_SIZE}
        height={RING_SIZE}
        viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
        role="img"
        aria-label={`${i18nService.t('contextUsageLabel')}: ${percent}%`}
        className="-rotate-90"
      >
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE_WIDTH}
          className="dark:text-claude-darkBorder text-claude-border"
        />
        {ratio > 0 && (
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={STROKE_WIDTH}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            className={arcColorClass}
          />
        )}
      </svg>
      <div className="absolute right-0 bottom-full mb-2 px-3.5 py-2.5 text-[13px] leading-relaxed rounded-xl shadow-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text dark:border-claude-darkBorder border-claude-border border opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 pointer-events-none z-50 whitespace-nowrap">
        <div className="font-medium">
          {i18nService.t('contextUsageLabel')}: {percent}%
        </div>
        <div className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('contextUsageUsed')}: {formatTokensK(usedTokens)} / {i18nService.t('contextUsageTotal')}: {formatTokensK(contextWindow)}
        </div>
      </div>
    </div>
  );
};

export default ContextUsageRing;
