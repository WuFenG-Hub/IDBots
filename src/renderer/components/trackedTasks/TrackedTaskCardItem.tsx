import React from 'react';
import { i18nService } from '../../services/i18n';
import {
  ClockIcon,
  CubeIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { TRACKED_DUE_LEVEL_LABEL_KEYS } from '../../types/trackedTask';
import type { TrackedCardSummary } from '../../types/trackedTask';
import { STATE_CHIP_CLASS, columnLabel, formatIdleDays, sourceKindLabel } from './trackedTaskPresentation';
import { reasonText, suggestionTextForCard } from './trackedTaskFactText';

interface TrackedTaskCardItemProps {
  card: TrackedCardSummary;
  columnLabelKey: string;
  onOpen: (cardId: string) => void;
  onClose: (cardId: string) => void;
}

/**
 * 看板列里的一张卡。密度按「一眼看清卡在哪、卡在谁手里、多久没动」排：
 * 第一行 = 卡面态 + 僵尸预警 + 台账原生 status；第二行 = 目标；再往下是摘要首行与来源/闲置。
 * 所有判定字段（state / closureDue / closureWarn / idleMs / reasons）都直接来自台账投影；
 * 摘要层没有会话明细，所以卡面不显示会话数——要看得点开抽屉（不臆造计数）。
 */
const TrackedTaskCardItem: React.FC<TrackedTaskCardItemProps> = ({
  card,
  columnLabelKey,
  onOpen,
  onClose,
}) => {
  // 摘要与建议都走结构化事实 → i18n 文案（后端只回 code + args）。
  const headline = card.reasonCodes?.[0]
    ? reasonText(card.reasonCodes[0], card.reasons?.[0])
    : card.reasons?.[0] ?? '';
  const suggestion = suggestionTextForCard(card);

  return (
  <div
    role="button"
    tabIndex={0}
    onClick={() => onOpen(card.id)}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onOpen(card.id);
      }
    }}
    className="non-draggable group w-full text-left rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg px-3 py-2.5 cursor-pointer transition-colors hover:border-claude-accent/60 dark:hover:border-claude-accent/60 hover:bg-claude-surfaceHover/40 dark:hover:bg-claude-darkSurfaceHover/40"
  >
    <div className="flex items-center gap-1.5 mb-1.5">
      <span
        className={`shrink-0 inline-flex items-center rounded-full border px-1.5 py-[1px] text-[10px] font-semibold ${STATE_CHIP_CLASS[card.state]}`}
      >
        {columnLabel(columnLabelKey || card.stateLabelKey, card.state)}
      </span>
      {card.closureDue && (
        <span
          title={
            card.closureDueLevel
              ? i18nService.t(TRACKED_DUE_LEVEL_LABEL_KEYS[card.closureDueLevel])
              : undefined
          }
          className="shrink-0 inline-flex items-center gap-0.5 rounded-full border border-red-500/40 bg-red-500/10 text-red-500 px-1.5 py-[1px] text-[10px] font-semibold"
        >
          <ExclamationTriangleIcon className="w-3 h-3" />
          {i18nService.t('trackedTask.badge.closureDue')}
        </span>
      )}
      {!card.closureDue && card.closureWarn && (
        <span
          title={i18nService.t('trackedTask.badge.closureWarnTooltip')}
          className="shrink-0 inline-flex items-center gap-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-500 px-1.5 py-[1px] text-[10px] font-semibold"
        >
          <ClockIcon className="w-3 h-3" />
          {i18nService.t('trackedTask.badge.closureWarn')}
        </span>
      )}
      {card.closerRole === 'twin' && (
        <span
          className="shrink-0 inline-flex items-center rounded-full border dark:border-claude-darkBorder border-claude-border px-1.5 py-[1px] text-[10px] font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary"
        >
          {i18nService.t('trackedTask.badge.internal')}
        </span>
      )}
      <span className="ml-auto shrink-0 text-[10px] font-mono dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {card.ledgerStatus}
      </span>
    </div>

    <div className="text-sm font-medium leading-snug dark:text-claude-darkText text-claude-text line-clamp-2 break-words">
      {card.title}
    </div>

    {headline && (
      <div className="mt-1 text-xs leading-snug dark:text-claude-darkTextSecondary text-claude-textSecondary line-clamp-2 break-words">
        {headline}
      </div>
    )}

    <div className="mt-2 flex items-center gap-3 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
      <span className="inline-flex items-center gap-1" title={i18nService.t('trackedTask.sourceKindLabel')}>
        <CubeIcon className="w-3.5 h-3.5" />
        {sourceKindLabel(card.sourceKind)}
      </span>
      <span className="ml-auto font-mono" title={i18nService.t('trackedTask.listCol.activity')}>
        {formatIdleDays(card.idleMs)}
      </span>
    </div>

    {suggestion && (
      <div className="mt-2 rounded-md border border-dashed dark:border-claude-darkBorder border-claude-border px-2 py-1 text-[11px] leading-snug dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {suggestion}
      </div>
    )}

    {/* v1.5：twin 自收卡不出收口按钮（守卫在后端，按钮在前端就不出现） */}
    {card.state !== 'closed' && card.closerRole !== 'twin' && (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose(card.id);
        }}
        className="mt-2 w-full rounded-md border dark:border-claude-darkBorder border-claude-border px-2 py-1 text-[11px] font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-opacity"
      >
        {i18nService.t('trackedTask.close.button')}
      </button>
    )}
  </div>
  );
};

export default TrackedTaskCardItem;
