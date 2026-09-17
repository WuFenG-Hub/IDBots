import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../../store';
import { setViewMode, selectCard, setOnlyOwnerAction } from '../../store/slices/trackedTaskSlice';
import { trackedTaskService } from '../../services/trackedTask';
import { i18nService } from '../../services/i18n';
import { Squares2X2Icon, ListBulletIcon, ArrowPathIcon } from '@heroicons/react/24/outline';
import TrackedTasksBoard from './TrackedTasksBoard';
import TrackedTasksList from './TrackedTasksList';
import TrackedTaskDrawer from './TrackedTaskDrawer';
import CloseTaskModal from './CloseTaskModal';
import ClosureBanner from './ClosureBanner';
import { filterNeedsOwnerAction } from './trackedTaskRanking';
import type { TrackedCardSummary } from '../../types/trackedTask';

/**
 * 「长期任务」Tab 的主体：看板 / 清单两视图 + 任务卡抽屉 + 收口入口。
 *
 * 事实源 = orchestration_tasks（经 `trackedTask:*` 读路径投影）。本组件不做任何状态推导：
 * 列顺序、列名 key、state / actionRank / needsOwnerAction / closureDue / reasons 全部用后端字段。
 * 读路径缺席时渲染明确的「读不到」空态，而不是伪造一张空台账。
 */
const TrackedTasksSection: React.FC = () => {
  const dispatch = useDispatch();
  const {
    available,
    bridgeMissingReason,
    board,
    details,
    loading,
    error,
    viewMode,
    selectedCardId,
    onlyOwnerAction,
  } = useSelector((state: RootState) => state.trackedTask);

  const [closeTargetId, setCloseTargetId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [metabotNames, setMetabotNames] = useState<Map<number, string>>(new Map());

  useEffect(() => {
    void trackedTaskService.init();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadMetabots = async () => {
      const result = await window.electron?.metabot?.list?.();
      if (cancelled || !result?.success || !result.list) return;
      setMetabotNames(new Map(result.list.map((metabot) => [metabot.id, metabot.name])));
    };
    void loadMetabots();
    return () => {
      cancelled = true;
    };
  }, []);

  const cards: TrackedCardSummary[] = board?.cards ?? [];

  const visibleCards = useMemo(
    () => (onlyOwnerAction ? filterNeedsOwnerAction(cards) : cards),
    [cards, onlyOwnerAction]
  );

  const selectedDetail = selectedCardId ? details[selectedCardId] ?? null : null;

  const closeTarget = useMemo(
    () => (closeTargetId ? cards.find((card) => card.id === closeTargetId) ?? null : null),
    [cards, closeTargetId]
  );

  const openCard = useCallback(
    (cardId: string) => {
      dispatch(selectCard(cardId));
      void trackedTaskService.loadCard(cardId);
    },
    [dispatch]
  );

  const requestClose = useCallback((cardId: string) => {
    setCloseError(null);
    setCloseTargetId(cardId);
  }, []);

  const submitClose = useCallback(
    async (input: { conclusion: string; by: 'owner' | 'twin' }) => {
      if (!closeTarget) return;
      setSubmitting(true);
      setCloseError(null);
      const failure = await trackedTaskService.closeCard({
        cardId: closeTarget.id,
        conclusion: input.conclusion,
        by: input.by,
      });
      setSubmitting(false);
      if (failure) {
        setCloseError(failure);
        return;
      }
      setCloseTargetId(null);
    },
    [closeTarget]
  );

  const toolbar = (
    <div className="flex shrink-0 items-center gap-2 border-b dark:border-claude-darkBorder border-claude-border px-4 py-2">
      <div className="flex rounded-lg border dark:border-claude-darkBorder border-claude-border p-0.5">
        {(['board', 'list'] as const).map((mode) => {
          const active = viewMode === mode;
          return (
            <button
              key={mode}
              type="button"
              aria-pressed={active}
              onClick={() => dispatch(setViewMode(mode))}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                active
                  ? 'bg-claude-accent/10 dark:text-claude-darkText text-claude-text'
                  : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
              }`}
            >
              {mode === 'board' ? (
                <Squares2X2Icon className="w-3.5 h-3.5" />
              ) : (
                <ListBulletIcon className="w-3.5 h-3.5" />
              )}
              {i18nService.t(mode === 'board' ? 'trackedTask.view.board' : 'trackedTask.view.list')}
            </button>
          );
        })}
      </div>

      <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {i18nService.t('trackedTask.cardTotal').replace('{count}', String(cards.length))}
      </span>

      <button
        type="button"
        onClick={() => void trackedTaskService.loadBoard()}
        className="ml-auto inline-flex items-center gap-1 rounded-md border dark:border-claude-darkBorder border-claude-border px-2 py-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
      >
        <ArrowPathIcon className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        {i18nService.t('trackedTask.refresh')}
      </button>
    </div>
  );

  if (!available) {
    return (
      <div className="flex h-full flex-col">
        {toolbar}
        <div className="flex flex-1 items-center justify-center px-6">
          <div className="max-w-md text-center">
            <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
              {i18nService.t('trackedTask.bridgeMissingTitle')}
            </h3>
            <p className="mt-1 text-xs leading-relaxed dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('trackedTask.bridgeMissingHint')}
            </p>
            {bridgeMissingReason && (
              <p className="mt-2 break-words rounded-md border border-dashed dark:border-claude-darkBorder border-claude-border px-2 py-1 font-mono text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {bridgeMissingReason}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {toolbar}

      {error && (
        <div className="shrink-0 border-b dark:border-claude-darkBorder border-claude-border px-4 py-1.5 text-xs text-red-500">
          {error}
        </div>
      )}

      {board && (
        <ClosureBanner
          cards={board.cards}
          closureDueCount={board.closureDueCount}
          onlyOwnerAction={onlyOwnerAction}
          onToggleOnlyOwnerAction={(next) => dispatch(setOnlyOwnerAction(next))}
          onOpenCard={openCard}
        />
      )}

      <div className="min-h-0 flex-1">
        {!board ? (
          <div className="flex h-full items-center justify-center text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('trackedTask.loading')}
          </div>
        ) : viewMode === 'board' ? (
          <TrackedTasksBoard board={board} onOpenCard={openCard} onCloseCard={requestClose} />
        ) : (
          <TrackedTasksList cards={visibleCards} onOpenCard={openCard} onCloseCard={requestClose} />
        )}
      </div>

      {selectedDetail && (
        <TrackedTaskDrawer
          detail={selectedDetail}
          metabotNames={metabotNames}
          onClose={() => dispatch(selectCard(null))}
          onRequestCloseCard={requestClose}
        />
      )}

      {closeTarget && (
        <CloseTaskModal
          card={closeTarget}
          submitting={submitting}
          error={closeError}
          onSubmit={submitClose}
          onCancel={() => {
            setCloseTargetId(null);
            setCloseError(null);
          }}
        />
      )}
    </div>
  );
};

export default TrackedTasksSection;
