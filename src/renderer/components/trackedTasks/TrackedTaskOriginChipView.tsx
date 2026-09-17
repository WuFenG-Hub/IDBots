import React from 'react';
import { i18nService } from '../../services/i18n';
import { Squares2X2Icon } from '@heroicons/react/24/outline';
import { sessionRoleLabel } from './trackedTaskPresentation';

export interface TrackedTaskOriginLink {
  cardId: string;
  role: string;
}

interface TrackedTaskOriginChipViewProps {
  cards: TrackedTaskOriginLink[];
  onOpenCard: (cardId: string) => void;
}

/**
 * 会话侧「所属长期任务」chip 的纯展示件（无 IO、无副作用）。
 * 0 张卡 → **渲染空**：独立会话不臆造归属（验收⑤）。
 */
export const TrackedTaskOriginChipView: React.FC<TrackedTaskOriginChipViewProps> = ({
  cards,
  onOpenCard,
}) => {
  if (cards.length === 0) return null;
  const primary = cards[0];

  return (
    <button
      type="button"
      onClick={() => onOpenCard(primary.cardId)}
      title={i18nService.t('trackedTask.origin.open')}
      className="non-draggable inline-flex shrink-0 items-center gap-1 rounded-full border border-claude-accent/40 bg-claude-accent/10 px-2 py-0.5 text-[10px] font-semibold transition-colors hover:border-claude-accent/70 dark:text-claude-darkText text-claude-text"
    >
      <Squares2X2Icon className="h-3 w-3" />
      {i18nService.t('trackedTask.origin.label')}
      <span className="font-mono opacity-80">{sessionRoleLabel(primary.role)}</span>
      {cards.length > 1 && <span className="font-mono opacity-80">+{cards.length - 1}</span>}
      <span className="max-w-[120px] truncate font-mono opacity-70">{primary.cardId.slice(0, 8)}</span>
    </button>
  );
};

export default TrackedTaskOriginChipView;
