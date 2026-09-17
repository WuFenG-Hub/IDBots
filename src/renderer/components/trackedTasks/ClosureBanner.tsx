import React from 'react';
import { i18nService } from '../../services/i18n';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import type { TrackedCardCounts, TrackedCardSummary } from '../../types/trackedTask';
import { TRACKED_DUE_LEVEL_LABEL_KEYS } from '../../types/trackedTask';

interface ClosureBannerProps {
  cards: TrackedCardSummary[];
  /** 后端投影给的分级计数；前端不重算任何一级。 */
  counts: TrackedCardCounts;
  onlyOwnerAction: boolean;
  onToggleOnlyOwnerAction: (next: boolean) => void;
  onOpenCard: (cardId: string) => void;
}

/**
 * 「待收口」横条 —— 跨列的正交标志（chair D1：**不是第 5 列**，卡留在自己那一列）。
 * 三级分别计数（[SEC-07]）：僵尸级 / 终态缺结论级 各自可见，会话已结束级作为补充信息。
 * 横条右侧兼作「只看需要我出手」开关。
 */
const ClosureBanner: React.FC<ClosureBannerProps> = ({
  cards,
  counts,
  onlyOwnerAction,
  onToggleOnlyOwnerAction,
  onOpenCard,
}) => {
  const dueCards = cards.filter((card) => card.closureDue && card.state !== 'closed');
  if (counts.closureDue === 0 || dueCards.length === 0) return null;

  const suggestion = dueCards.find((card) => card.closureSuggestion)?.closureSuggestion ?? '';

  const levels: Array<{ key: keyof TrackedCardCounts; className: string }> = [
    { key: 'zombieLevel', className: 'border-red-500/40 bg-red-500/10 text-red-500' },
    {
      key: 'terminalMissingConclusionLevel',
      className: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
    },
    {
      key: 'sessionsEndedLevel',
      className: 'dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary',
    },
  ];

  return (
    <div className="shrink-0 border-b dark:border-claude-darkBorder border-claude-border bg-red-500/5 px-4 py-2">
      <div className="flex items-center gap-2">
        <ExclamationTriangleIcon className="h-4 w-4 shrink-0 text-red-500" />
        <span className="text-sm font-medium text-red-500">
          {i18nService.t('trackedTask.closureDueBanner').replace('{count}', String(counts.closureDue))}
        </span>

        {/* 分级分别可见：不把两级合成一个数 */}
        <span className="flex items-center gap-1">
          {levels.map((level) => {
            const value = counts[level.key];
            if (typeof value !== 'number' || value === 0) return null;
            const labelKey =
              level.key === 'zombieLevel'
                ? 'trackedTask.counts.zombie'
                : level.key === 'terminalMissingConclusionLevel'
                  ? 'trackedTask.counts.terminalMissing'
                  : 'trackedTask.counts.sessionsEnded';
            return (
              <span
                key={level.key}
                className={`rounded-full border px-1.5 py-[1px] text-[10px] font-semibold ${level.className}`}
              >
                {i18nService.t(labelKey).replace('{count}', String(value))}
              </span>
            );
          })}
        </span>

        <span className="truncate text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {suggestion}
        </span>

        <button
          type="button"
          onClick={() => onToggleOnlyOwnerAction(!onlyOwnerAction)}
          className={`ml-auto shrink-0 rounded-full border px-2 py-[2px] text-[11px] transition-colors ${
            onlyOwnerAction
              ? 'border-red-500/60 bg-red-500/10 text-red-500'
              : 'dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary'
          }`}
        >
          {i18nService.t('trackedTask.onlyOwnerAction')}
        </button>
      </div>

      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {dueCards.map((card) => (
          <button
            key={card.id}
            type="button"
            onClick={() => onOpenCard(card.id)}
            title={
              card.closureDueLevel
                ? i18nService.t(TRACKED_DUE_LEVEL_LABEL_KEYS[card.closureDueLevel])
                : undefined
            }
            className="max-w-[300px] truncate rounded-full border border-red-500/30 bg-claude-bg px-2 py-[2px] text-[11px] dark:bg-claude-darkBg dark:text-claude-darkText text-claude-text transition-colors hover:border-red-500/60"
          >
            {card.closureDueLevel
              ? `${i18nService.t(TRACKED_DUE_LEVEL_LABEL_KEYS[card.closureDueLevel])} · ${card.title}`
              : card.title}
          </button>
        ))}
      </div>
    </div>
  );
};

export default ClosureBanner;
