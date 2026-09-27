import React, { useEffect, useMemo } from 'react';
import { useSelector } from 'react-redux';
import { ArrowPathIcon } from '@heroicons/react/24/outline';
import { RootState } from '../../store';
import { metaTaskService } from '../../services/metatask';
import { setView } from '../../store/slices/metataskSlice';
import { store } from '../../store';
import { i18nService } from '../../services/i18n';
import MetaTaskDetail from './MetaTaskDetail';
import type { MetaTaskAlert, MetaTaskBoardTask } from '../../types/metatask';

const alertText = (alert: MetaTaskAlert): string => {
  const node = alert.node ?? '—';
  const detail = alert.detail ?? '';
  if (alert.kind === 'claim_ttl_soon') {
    return `${i18nService.t('metatask.alert.claimTtlSoon').replace('{node}', node)} · ${detail}`;
  }
  if (alert.kind === 'submission_change') {
    return i18nService.t('metatask.alert.submissionChange').replace('{node}', node).replace('{detail}', detail);
  }
  return i18nService.t('metatask.alert.closingDrive').replace('{detail}', detail);
};

/** MetaTask tab (P1 read path). 任务广场 / 我的参与 inner views over the
 * chain-sourced projection; every surface shows the boundary block it was
 * computed at (chain index lag is a measured fact, never hidden). */
const MetaTaskBoard: React.FC = () => {
  const board = useSelector((state: RootState) => state.metatask.board);
  const view = useSelector((state: RootState) => state.metatask.view);
  const loading = useSelector((state: RootState) => state.metatask.loading);
  const refreshing = useSelector((state: RootState) => state.metatask.refreshing);
  const error = useSelector((state: RootState) => state.metatask.error);
  const bridgeMissingReason = useSelector((state: RootState) => state.metatask.bridgeMissingReason);
  const selectedRootPinId = useSelector((state: RootState) => state.metatask.selectedRootPinId);

  useEffect(() => {
    void metaTaskService.init();
    return () => metaTaskService.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tasks = board?.tasks ?? [];
  const mine = useMemo(() => tasks.filter((task) => task.myRoles.length > 0), [tasks]);
  const shown = view === 'mine' ? mine : tasks;

  if (selectedRootPinId) {
    return <MetaTaskDetail rootPinId={selectedRootPinId} />;
  }

  const tabButtonClass = (active: boolean): string =>
    `px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
      active
        ? 'bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover dark:text-claude-darkText text-claude-text'
        : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
    }`;

  return (
    <div className="flex flex-col h-full">
      {/* Header: inner views + refresh + freshness */}
      <div className="flex items-center justify-between border-b dark:border-claude-darkBorder border-claude-border px-4 py-2 shrink-0">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => store.dispatch(setView('square'))}
            className={tabButtonClass(view === 'square')}
          >
            {i18nService.t('metatask.view.square')}
          </button>
          <button
            type="button"
            onClick={() => store.dispatch(setView('mine'))}
            className={tabButtonClass(view === 'mine')}
          >
            {i18nService.t('metatask.view.mine')}
          </button>
        </div>
        <div className="flex items-center gap-3">
          {board && (
            <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('metatask.freshnessBlock').replace('{block}', String(board.refresh.boundaryBlock ?? '—'))}
            </span>
          )}
          <button
            type="button"
            onClick={() => void metaTaskService.refresh()}
            disabled={refreshing}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-sm rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-50 transition-colors"
          >
            <ArrowPathIcon className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? i18nService.t('metatask.refreshing') : i18nService.t('metatask.refresh')}
          </button>
        </div>
      </div>

      {(error || bridgeMissingReason) && (
        <div className="mx-4 mt-3 px-3 py-2 text-sm rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400">
          {bridgeMissingReason ?? error}
        </div>
      )}
      {board && board.alerts.length > 0 && (
        <div className="mx-4 mt-3 space-y-1">
          {board.alerts.slice(0, 6).map((alert, index) => (
            <button
              key={`${alert.createdAtMs}-${index}`}
              type="button"
              onClick={() => metaTaskService.selectTask(alert.rootPinId)}
              className="block w-full text-left px-3 py-1.5 text-xs rounded-lg bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors"
            >
              {alertText(alert)}
            </button>
          ))}
        </div>
      )}
      {board?.refresh.lastError && !error && (
        <div className="mx-4 mt-3 px-3 py-2 text-xs rounded-lg bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400">
          {board.refresh.lastError}
        </div>
      )}

      {/* Task cards */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        {loading && !board ? (
          <div className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary py-8 text-center">
            {i18nService.t('metatask.loading')}
          </div>
        ) : shown.length === 0 ? (
          <div className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary py-8 text-center">
            {view === 'mine' ? i18nService.t('metatask.mineEmpty') : i18nService.t('metatask.noTasks')}
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {shown.map((task) => (
              <MetaTaskCard key={task.rootPinId} task={task} />
            ))}
          </div>
        )}
        <p className="mt-4 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('metatask.indexLagNote')}
        </p>
      </div>
    </div>
  );
};

const shortId = (metaId: string): string =>
  metaId.length > 14 ? `${metaId.slice(0, 8)}…${metaId.slice(-4)}` : metaId;

const MetaTaskCard: React.FC<{ task: MetaTaskBoardTask }> = ({ task }) => {
  const progressPct = task.progress.total > 0 ? Math.round((task.progress.verified / task.progress.total) * 100) : 0;
  return (
    <button
      type="button"
      onClick={() => metaTaskService.selectTask(task.rootPinId)}
      className="text-left p-3 rounded-xl border dark:border-claude-darkBorder border-claude-border hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors flex flex-col gap-2"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium dark:text-claude-darkText text-claude-text line-clamp-2">
          {task.title}
        </span>
        {task.settlementFinalized && (
          <span className="shrink-0 px-1.5 py-0.5 text-[11px] rounded bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">
            {i18nService.t('metatask.settled')}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
        <span>
          {i18nService.t('metatask.publisher')} {shortId(task.publisher)}
        </span>
        <span>·</span>
        <span>
          {i18nService.t('metatask.participants').replace('{count}', String(task.participantCount))}
        </span>
      </div>
      {/* Progress bar */}
      <div>
        <div className="flex items-center justify-between text-xs mb-1">
          <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('metatask.progressVerified')
              .replace('{verified}', String(task.progress.verified))
              .replace('{total}', String(task.progress.total))}
          </span>
          <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{progressPct}%</span>
        </div>
        <div className="h-1.5 rounded-full bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover overflow-hidden">
          <div
            className="h-full bg-brand rounded-full transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>
      {task.progress.disputed > 0 && (
        <span className="text-xs text-amber-600 dark:text-amber-400">
          {i18nService.t('metatask.disputedCount').replace('{count}', String(task.progress.disputed))}
        </span>
      )}
      {task.myRoles.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {task.myRoles.includes('publisher') && (
            <span className="px-1.5 py-0.5 text-[11px] rounded bg-brand/10 text-brand">
              {i18nService.t('metatask.role.publisher')}
            </span>
          )}
          {task.myRoles.includes('participant') && (
            <span className="px-1.5 py-0.5 text-[11px] rounded bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-400">
              {i18nService.t('metatask.role.participant')}
            </span>
          )}
          {task.myStats && (
            <span className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('metatask.myStatsSummary')
                .replace('{verified}', String(task.myStats.verified))
                .replace('{reviews}', String(task.myStats.reviewVotes))}
            </span>
          )}
        </div>
      )}
      <span className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {i18nService.t('metatask.freshnessBlock').replace('{block}', String(task.freshness.boundaryBlock))}
        {' · '}
        {i18nService.t('metatask.events').replace('{count}', String(task.freshness.eventCount))}
      </span>
    </button>
  );
};

export default MetaTaskBoard;
