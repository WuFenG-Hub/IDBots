import React, { useMemo } from 'react';
import { i18nService } from '../../services/i18n';
import { TRACKED_BOARD_COLUMN_FALLBACK } from '../../types/trackedTask';
import type { TrackedCardBoard, TrackedCardState } from '../../types/trackedTask';
import TrackedTaskCardItem from './TrackedTaskCardItem';
import {
  STATE_ACCENT_BAR_CLASS,
  TRACKED_COLUMN_FALLBACK_LABEL_KEY,
  columnLabel,
} from './trackedTaskPresentation';

interface TrackedTasksBoardProps {
  board: TrackedCardBoard;
  onOpenCard: (cardId: string) => void;
  onCloseCard: (cardId: string) => void;
}

/**
 * 看板四列（验收④）。列顺序与列名 key 都取自台账投影的 `board.columns`
 * （主进程 TRACKED_CARD_STATE_ORDER），前端不维护第二份列定义、也不做二次归列。
 */
const TrackedTasksBoard: React.FC<TrackedTasksBoardProps> = ({ board, onOpenCard, onCloseCard }) => {
  const cardById = useMemo(
    () => new Map(board.cards.map((card) => [card.id, card])),
    [board.cards]
  );

  const columns = board.columns.length
    ? board.columns
    : TRACKED_BOARD_COLUMN_FALLBACK.map((state) => ({
        state,
        labelKey: TRACKED_COLUMN_FALLBACK_LABEL_KEY[state],
        cardIds: board.cards.filter((card) => card.state === state).map((card) => card.id),
      }));

  return (
    <div className="h-full overflow-x-auto overflow-y-hidden px-4 pb-4 pt-3">
      <div className="grid h-full grid-cols-4 gap-3 min-w-[880px]">
        {columns.map((column) => {
          const columnCards = column.cardIds
            .map((cardId) => cardById.get(cardId))
            .filter((card): card is NonNullable<typeof card> => Boolean(card));

          return (
            <div
              key={column.state}
              className="flex h-full min-h-0 flex-col rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/40 bg-claude-surface/40"
            >
              <div className="flex shrink-0 items-center gap-2 border-b dark:border-claude-darkBorder border-claude-border px-3 py-2">
                <span
                  className={`h-3.5 w-1 rounded-full ${STATE_ACCENT_BAR_CLASS[column.state as TrackedCardState]}`}
                />
                <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                  {columnLabel(column.labelKey, column.state as TrackedCardState)}
                </span>
                <span className="ml-auto rounded-full border dark:border-claude-darkBorder border-claude-border px-1.5 py-[1px] text-[11px] font-mono dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {columnCards.length}
                </span>
              </div>

              <div className="flex-1 min-h-0 space-y-2 overflow-y-auto p-2">
                {columnCards.length === 0 ? (
                  <div className="px-2 py-6 text-center text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('trackedTask.column.empty')}
                  </div>
                ) : (
                  columnCards.map((card) => (
                    <TrackedTaskCardItem
                      key={card.id}
                      card={card}
                      columnLabelKey={column.labelKey}
                      onOpen={onOpenCard}
                      onClose={onCloseCard}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default TrackedTasksBoard;
