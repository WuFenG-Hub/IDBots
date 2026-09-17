import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../../store';
import {
  setViewMode,
  selectCard,
  setOnlyOwnerAction,
  setScope,
  setReceipt,
} from '../../store/slices/trackedTaskSlice';
import { trackedTaskService } from '../../services/trackedTask';
import { i18nService } from '../../services/i18n';
import {
  Squares2X2Icon,
  ListBulletIcon,
  ArchiveBoxIcon,
  ArrowPathIcon,
  FunnelIcon,
  CheckCircleIcon,
  QuestionMarkCircleIcon,
} from '@heroicons/react/24/outline';
import TrackedTasksBoard from './TrackedTasksBoard';
import TrackedTasksList from './TrackedTasksList';
import TrackedTaskDrawer from './TrackedTaskDrawer';
import CloseTaskModal from './CloseTaskModal';
import ClosureBanner from './ClosureBanner';
import AdmissionRulesModal from './AdmissionRulesModal';
import { filterNeedsOwnerAction } from './trackedTaskRanking';
import type { TrackedCardScope, TrackedCardSummary, TrackedTaskViewMode } from '../../types/trackedTask';

/**
 * 「长期任务」Tab 的主体：看板 / 清单两视图 + 范围筛选 + 待收口横条 + 任务卡抽屉 + 收口入口。
 *
 * 事实源 = orchestration_tasks（经 `trackedTask:*` 投影）。本组件不做任何状态推导：
 * 列顺序、列名 key、state / actionRank / needsOwnerAction / closureDue 级别 / reasons
 * 全部用后端字段；范围筛选把 `scope` 回传后端并回显 `scopeApplied`（D3：显式、可一键清除）。
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
    scope,
    receipt,
  } = useSelector((state: RootState) => state.trackedTask);

  const [closeTargetId, setCloseTargetId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [metabotNames, setMetabotNames] = useState<Map<number, string>>(new Map());
  const [admissionModalOpen, setAdmissionModalOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveNotice, setArchiveNotice] = useState(false);

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

  const changeScope = useCallback(
    (next: TrackedCardScope) => {
      dispatch(setScope(next));
      void trackedTaskService.loadBoard({ scope: next });
    },
    [dispatch]
  );

  /**
   * v1.1 归档视图是**只读列表**：它读 `scope:'archived'`（恰好 ¬admitted 的行），
   * 也是三个 scope 里唯一的归档入口。离开归档视图时回到 default，避免把归档
   * 误当成长任务的常规筛选。
   */
  const changeView = useCallback(
    (mode: TrackedTaskViewMode) => {
      dispatch(setViewMode(mode));
      if (mode === 'archive') {
        dispatch(setScope('archived'));
        void trackedTaskService.loadBoard({ scope: 'archived' });
        return;
      }
      if (scope === 'archived') {
        dispatch(setScope('default'));
        void trackedTaskService.loadBoard({ scope: 'default' });
      }
    },
    [dispatch, scope]
  );

  const submitClose = useCallback(
    async (input: { conclusion: string; by: 'owner' | 'twin' }) => {
      if (!closeTarget) return;
      setSubmitting(true);
      setCloseError(null);
      const outcome = await trackedTaskService.closeCard({
        cardId: closeTarget.id,
        conclusion: input.conclusion,
        by: input.by,
      });
      setSubmitting(false);
      if (outcome.error) {
        setCloseError(outcome.error);
        return;
      }
      dispatch(setReceipt(outcome.receipt));
      setCloseTargetId(null);
    },
    [closeTarget, dispatch]
  );

  /**
   * v1.3 手工归档（反馈⑥）：只读归档视图里唯一多的一个写入口，仅对已收口的卡开放。
   * 服务层成功后整块重取看板（归档改变准入种群与 counts）；这里只关抽屉、出回执横条。
   */
  const submitArchive = useCallback(
    async (cardId: string) => {
      setArchiving(true);
      const outcome = await trackedTaskService.archiveCard({ cardId, archived: true });
      setArchiving(false);
      if (outcome.error) {
        dispatch(setError(outcome.error));
        return;
      }
      dispatch(selectCard(null));
      setArchiveNotice(true);
    },
    [dispatch]
  );

  /** 反馈⑤：切到 cowork 新对话并预填 composer 草稿（文案走 i18n，App.tsx 接力）。 */
  const handleNewTrackedTask = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent('cowork:newChatWithDraft', {
        detail: { text: i18nService.t('trackedTask.newTaskDraft') },
      })
    );
  }, []);

  const foldedCount = board?.counts.folded ?? 0;
  const scopeIsDefault = (board?.scopeApplied ?? scope) === 'default';
  const inArchiveView = viewMode === 'archive';
  const archivedCount = board?.counts.archived ?? 0;

  const toolbar = (
    <div className="flex shrink-0 items-center gap-2 border-b dark:border-claude-darkBorder border-claude-border px-4 py-2">
      <div className="flex rounded-lg border dark:border-claude-darkBorder border-claude-border p-0.5">
        {(['board', 'list', 'archive'] as const).map((mode) => {
          const active = viewMode === mode;
          return (
            <button
              key={mode}
              type="button"
              aria-pressed={active}
              onClick={() => changeView(mode)}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                active
                  ? 'bg-claude-accent/10 dark:text-claude-darkText text-claude-text'
                  : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
              }`}
            >
              {mode === 'board' ? (
                <Squares2X2Icon className="w-3.5 h-3.5" />
              ) : mode === 'list' ? (
                <ListBulletIcon className="w-3.5 h-3.5" />
              ) : (
                <ArchiveBoxIcon className="w-3.5 h-3.5" />
              )}
              {i18nService.t(
                mode === 'board'
                  ? 'trackedTask.view.board'
                  : mode === 'list'
                    ? 'trackedTask.view.list'
                    : 'trackedTask.view.archive'
              )}
              {mode === 'archive' && archivedCount > 0 ? ` · ${archivedCount}` : ''}
            </button>
          );
        })}
      </div>

      {/* D3：范围必须显式可见、一键可清，折叠掉的卡不许静默隐藏。
          归档视图下本按钮不适用（归档不是时间窗，它由准入决定）。 */}
      {!inArchiveView && (
      <button
        type="button"
        onClick={() => changeScope(scopeIsDefault ? 'all' : 'default')}
        title={scopeIsDefault
          ? i18nService.t('trackedTask.scope.default')
          : i18nService.t('trackedTask.scope.backToDefault')}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-[2px] text-[11px] transition-colors ${
          scopeIsDefault
            ? 'dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary'
            : 'border-claude-accent/60 bg-claude-accent/10 dark:text-claude-darkText text-claude-text'
        }`}
      >
        <FunnelIcon className="w-3 h-3" />
        {i18nService.t(scopeIsDefault ? 'trackedTask.scope.default' : 'trackedTask.scope.all')}
        {scopeIsDefault && foldedCount > 0
          ? ` · ${i18nService.t('trackedTask.scope.folded').replace('{count}', String(foldedCount))}`
          : ''}
        <span className="opacity-70">
          {scopeIsDefault ? i18nService.t('trackedTask.scope.showAll') : i18nService.t('trackedTask.scope.backToDefault')}
        </span>
      </button>
      )}

      <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {i18nService.t('trackedTask.cardTotal').replace('{count}', String(cards.length))}
        {board?.hasMore ? '+' : ''}
      </span>

      {/* 准入规则说明入口（反馈④）：刷新左侧，样式对齐既有工具栏按钮。 */}
      <button
        type="button"
        onClick={() => setAdmissionModalOpen(true)}
        title={i18nService.t('trackedTask.admission.title')}
        className="ml-auto inline-flex items-center gap-1 rounded-md border dark:border-claude-darkBorder border-claude-border px-2 py-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
      >
        <QuestionMarkCircleIcon className="w-3.5 h-3.5" />
        {i18nService.t('trackedTask.admission.entry')}
      </button>

      <button
        type="button"
        onClick={() => void trackedTaskService.loadBoard()}
        className="inline-flex items-center gap-1 rounded-md border dark:border-claude-darkBorder border-claude-border px-2 py-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
      >
        <ArrowPathIcon className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        {i18nService.t('trackedTask.refresh')}
      </button>

      {/* 新建任务（反馈⑤）：样式与定时任务的 New Task 一致，点击切到 cowork 并预填草稿。 */}
      <button
        type="button"
        onClick={handleNewTrackedTask}
        className="btn-idchat-primary-filled px-3 py-1 text-sm font-medium"
      >
        {i18nService.t('trackedTask.newTask.button')}
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

      {/* 收口回执：区分「状态已推进」与「结论已记录、状态保留」（F1 两段写） */}
      {receipt && (
        <div className="flex shrink-0 items-center gap-2 border-b dark:border-claude-darkBorder border-claude-border bg-emerald-500/5 px-4 py-1.5">
          <CheckCircleIcon className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
          <span className="text-xs text-emerald-500">
            {i18nService.t(
              receipt.statusMoved ? 'trackedTask.receipt.statusMoved' : 'trackedTask.receipt.statusKept'
            )}
          </span>
          {receipt.statusNote && (
            <span className="truncate text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {receipt.statusNote}
            </span>
          )}
          <button
            type="button"
            onClick={() => dispatch(setReceipt(null))}
            className="ml-auto text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary hover:underline"
          >
            {i18nService.t('close')}
          </button>
        </div>
      )}

      {/* 归档回执横条（反馈⑥）：归档成功后短暂确认，卡已在归档视图可查 */}
      {archiveNotice && (
        <div className="flex shrink-0 items-center gap-2 border-b dark:border-claude-darkBorder border-claude-border bg-emerald-500/5 px-4 py-1.5">
          <CheckCircleIcon className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
          <span className="text-xs text-emerald-500">
            {i18nService.t('trackedTask.archive.successToast')}
          </span>
          <button
            type="button"
            onClick={() => setArchiveNotice(false)}
            className="ml-auto text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary hover:underline"
          >
            {i18nService.t('close')}
          </button>
        </div>
      )}

      {board && (
        <ClosureBanner
          cards={board.cards}
          counts={board.counts}
          onlyOwnerAction={onlyOwnerAction}
          onToggleOnlyOwnerAction={(next) => dispatch(setOnlyOwnerAction(next))}
          onOpenCard={openCard}
        />
      )}

      {board && inArchiveView && (
        <div className="shrink-0 border-b dark:border-claude-darkBorder border-claude-border bg-claude-surfaceHover/40 dark:bg-claude-darkSurfaceHover/40 px-4 py-2">
          <div className="flex items-center gap-2">
            <ArchiveBoxIcon className="h-3.5 w-3.5 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
            <span className="text-xs font-medium dark:text-claude-darkText text-claude-text">
              {i18nService.t('trackedTask.archive.title').replace('{count}', String(archivedCount))}
            </span>
            <span className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('trackedTask.archive.readOnly')}
            </span>
          </div>
          <p className="mt-0.5 pl-5 text-[11px] leading-relaxed dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('trackedTask.archive.hint')}
          </p>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {!board ? (
          <div className="flex h-full items-center justify-center text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('trackedTask.loading')}
          </div>
        ) : viewMode === 'archive' ? (
          <TrackedTasksList
            cards={board.cards}
            onOpenCard={openCard}
            onCloseCard={requestClose}
            readOnly
            emptyTextKey="trackedTask.archive.empty"
          />
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
          onArchiveCard={submitArchive}
          archiving={archiving}
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

      {admissionModalOpen && (
        <AdmissionRulesModal onClose={() => setAdmissionModalOpen(false)} />
      )}
    </div>
  );
};

export default TrackedTasksSection;
