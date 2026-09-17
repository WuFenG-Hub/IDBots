import React from 'react';
import { i18nService } from '../../services/i18n';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import type { TrackedCardSummary } from '../../types/trackedTask';

interface ClosureBannerProps {
  cards: TrackedCardSummary[];
  /** 后端投影给的超阈值计数（closureDueCount），前端不重算。 */
  closureDueCount: number;
  onlyOwnerAction: boolean;
  onToggleOnlyOwnerAction: (next: boolean) => void;
  onOpenCard: (cardId: string) => void;
}

/**
 * 「待收口」横条。
 *
 * 规格 §9 D1 的口径：待收口**不是第 5 列**——它是与四列正交的标志（closureDue），
 * 所以这里做成顶部计数横条 + 卡面内联建议，而不是再切一列出来。
 * 横条右侧同时作为「只看需要我出手」的筛选开关。
 */
const ClosureBanner: React.FC<ClosureBannerProps> = ({
  cards,
  closureDueCount,
  onlyOwnerAction,
  onToggleOnlyOwnerAction,
  onOpenCard,
}) => {
  const dueCards = cards.filter((card) => card.closureDue && card.state !== 'closed');
  if (closureDueCount === 0 || dueCards.length === 0) return null;

  const suggestion = dueCards.find((card) => card.closureSuggestion)?.closureSuggestion ?? '';

  return (
    <div className="shrink-0 border-b dark:border-claude-darkBorder border-claude-border bg-red-500/5 px-4 py-2">
      <div className="flex items-center gap-2">
        <ExclamationTriangleIcon className="h-4 w-4 shrink-0 text-red-500" />
        <span className="text-sm font-medium text-red-500">
          {i18nService.t('trackedTask.closureDueBanner').replace('{count}', String(closureDueCount))}
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
            className="max-w-[280px] truncate rounded-full border border-red-500/30 bg-claude-bg px-2 py-[2px] text-[11px] dark:bg-claude-darkBg dark:text-claude-darkText text-claude-text transition-colors hover:border-red-500/60"
          >
            {card.title}
          </button>
        ))}
      </div>
    </div>
  );
};

export default ClosureBanner;
