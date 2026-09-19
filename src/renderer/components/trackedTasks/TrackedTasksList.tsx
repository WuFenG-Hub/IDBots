import React, { useMemo } from 'react';
import { i18nService } from '../../services/i18n';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import type { TrackedCardSummary } from '../../types/trackedTask';
import { orderCardsForBoardList } from './trackedTaskRanking';
import {
  STATE_CHIP_CLASS,
  columnLabel,
  formatIdleDays,
  sourceKindLabel,
} from './trackedTaskPresentation';
import { reasonText } from './trackedTaskFactText';

interface TrackedTasksListProps {
  cards: TrackedCardSummary[];
  onOpenCard: (cardId: string) => void;
  onCloseCard: (cardId: string) => void;
  /**
   * v1.1 归档视图复用本列表，但归档是**只读**的：没有收口动作、没有「操作」列。
   * 这不是权限开关（读路径本就允许归档卡深链可查），而是界面契约。
   */
  readOnly?: boolean;
  /** 只读视图的空态文案 key；缺省用清单视图的。 */
  emptyTextKey?: string;
}

/**
 * 清单视图（验收④）：按「需要我出手」排序。
 * 顺序 = 台账投影的 actionRank（后端给出），本组件只用 `orderCardsForBoardList` 复现它，
 * 不在前端重推状态、也不写第二套优先级。
 */
const TrackedTasksList: React.FC<TrackedTasksListProps> = ({
  cards,
  onOpenCard,
  onCloseCard,
  readOnly = false,
  emptyTextKey = 'trackedTask.list.empty',
}) => {
  const ranked = useMemo(() => orderCardsForBoardList(cards), [cards]);
  const gridCols = readOnly
    ? 'grid-cols-[104px_1fr_200px_110px_90px]'
    : 'grid-cols-[104px_1fr_200px_110px_90px_100px]';

  return (
    <div className="h-full overflow-y-auto">
      <div className={`sticky top-0 z-10 grid ${gridCols} items-center gap-3 border-b dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg px-4 py-2 text-[11px] font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary`}>
        <span>{i18nService.t('trackedTask.listCol.state')}</span>
        <span>{i18nService.t('trackedTask.listCol.goal')}</span>
        <span>{i18nService.t('trackedTask.listCol.summary')}</span>
        <span>{i18nService.t('trackedTask.listCol.source')}</span>
        <span>{i18nService.t('trackedTask.listCol.activity')}</span>
        {!readOnly && (
          <span className="text-right">{i18nService.t('trackedTask.listCol.action')}</span>
        )}
      </div>

      {ranked.length === 0 ? (
        <div className="px-4 py-16 text-center text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t(emptyTextKey)}
        </div>
      ) : (
        ranked.map((card) => (
          <div
            key={card.id}
            className={`group grid ${gridCols} items-center gap-3 border-b dark:border-claude-darkBorder/50 border-claude-border/50 px-4 py-2.5 cursor-pointer transition-colors hover:bg-claude-surfaceHover/50 dark:hover:bg-claude-darkSurfaceHover/50`}
            onClick={() => onOpenCard(card.id)}
          >
            <span className="flex min-w-0 items-center gap-1">
              <span
                className={`inline-flex items-center whitespace-nowrap rounded-full border px-1.5 py-[1px] text-[10px] font-semibold ${STATE_CHIP_CLASS[card.state]}`}
              >
                {columnLabel(card.stateLabelKey, card.state)}
              </span>
              {card.closerRole === 'twin' && (
                <span className="inline-flex items-center whitespace-nowrap rounded-full border dark:border-claude-darkBorder border-claude-border px-1.5 py-[1px] text-[10px] font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('trackedTask.badge.internal')}
                </span>
              )}
            </span>

            <span className="min-w-0">
              <span className="block truncate text-sm font-medium dark:text-claude-darkText text-claude-text">
                {card.title}
              </span>
              <span className="block truncate text-[11px] font-mono dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {card.ledgerStatus} · {card.id.slice(0, 8)}
              </span>
            </span>

            <span className="truncate text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {card.reasonCodes?.[0]
                ? reasonText(card.reasonCodes[0], card.reasons?.[0])
                : card.reasons?.[0] ?? '—'}
            </span>

            <span className="truncate text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {sourceKindLabel(card.sourceKind)}
            </span>

            <span className="flex items-center gap-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {card.closureDue && <ExclamationTriangleIcon className="w-3.5 h-3.5 text-red-500" />}
              <span className="font-mono">{formatIdleDays(card.idleMs)}</span>
            </span>

            {!readOnly && (
              <span className="text-right">
                {card.state === 'closed' ? (
                  <span className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('trackedTask.list.closedMark')}
                  </span>
                ) : card.closerRole === 'twin' ? (
                  // v1.5：twin 自收卡没有 owner 可执行的动作——操作列留空，
                  // 内部标记已在状态列出现，不重复堆徽章。
                  null
                ) : (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseCard(card.id);
                    }}
                    className="rounded-md border dark:border-claude-darkBorder border-claude-border px-2 py-1 text-[11px] font-medium dark:text-claude-darkText text-claude-text transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                  >
                    {i18nService.t('trackedTask.close.button')}
                  </button>
                )}
              </span>
            )}
          </div>
        ))
      )}
    </div>
  );
};

export default TrackedTasksList;
