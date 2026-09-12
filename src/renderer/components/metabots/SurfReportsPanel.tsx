/**
 * MetaWeb surf run-history panel ("AI 冲浪" reports).
 *
 * Lists the bot's recent surf runs (newest first) with a status badge, the
 * run trigger, its start time and a one-line stats summary; clicking a run
 * expands/collapses its full markdown surf report. Reloads on mount, on the
 * metabotId change, on the refresh button, and whenever the parent bumps
 * refreshToken (the surfStatusChanged broadcast for this bot).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ArrowPathIcon, ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import MarkdownContent from '../MarkdownContent';
import type { MetawebSurfRunInfo, MetawebSurfRunStats, MetawebSurfRunStatus, MetawebSurfTrigger } from '../../types/metawebSurf';

interface SurfReportsPanelProps {
  metabotId: number;
  /** Bumped by the parent when a surfStatusChanged event arrives for this bot. */
  refreshToken: number;
}

// Replicated from MetawebStudyJobsPanel (kept in sync with the edit-tab chrome).
const hintClass = 'text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1';
const cardClass = 'rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-4 space-y-3';
const actionBtnClass = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

const STATUS_BADGE_CLASS: Record<MetawebSurfRunStatus, string> = {
  running: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
  done: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  failed: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30',
};

const STATUS_LABEL_KEY: Record<MetawebSurfRunStatus, string> = {
  running: 'surfStatusRunning',
  done: 'surfStatusDone',
  failed: 'surfStatusFailed',
};

const TRIGGER_LABEL_KEY: Record<MetawebSurfTrigger, string> = {
  'manual-chat': 'surfTriggerManualChat',
  'manual-ui': 'surfTriggerManualUi',
  'pre-dream': 'surfTriggerPreDream',
};

const formatStartedAt = (iso: string): string => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleString();
};

/** One-line stats summary: only the non-zero parts, i18n fragments joined by '·'. */
const formatRunStats = (stats: MetawebSurfRunStats): string => {
  const acted = stats.liked + stats.commented + stats.answered + stats.posted + stats.challenged;
  const parts: string[] = [];
  if (stats.fetched > 0) parts.push(i18nService.t('surfRunStatsFetched').replace('{count}', String(stats.fetched)));
  if (stats.deepRead > 0) parts.push(i18nService.t('surfRunStatsRead').replace('{count}', String(stats.deepRead)));
  if (stats.savedToKb > 0) parts.push(i18nService.t('surfRunStatsSaved').replace('{count}', String(stats.savedToKb)));
  if (acted > 0) parts.push(i18nService.t('surfRunStatsActed').replace('{count}', String(acted)));
  return parts.join(' · ');
};

const SurfReportsPanel: React.FC<SurfReportsPanelProps> = ({ metabotId, refreshToken }) => {
  const [runs, setRuns] = useState<MetawebSurfRunInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [panelError, setPanelError] = useState('');
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    try {
      const result = await window.electron.surf.listRuns(metabotId, 20);
      if (result.success && result.runs) {
        setRuns(result.runs);
        setPanelError('');
      } else {
        setPanelError(result.error || i18nService.t('surfReportsLoadFailed'));
      }
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : i18nService.t('surfReportsLoadFailed'));
    } finally {
      setLoaded(true);
    }
  }, [metabotId]);

  // (Re)load when a different bot is loaded into the same mounted editor and
  // whenever a surf run for this bot starts or finishes (refreshToken bump).
  useEffect(() => {
    void loadRuns();
  }, [loadRuns, refreshToken]);

  // Collapse any expanded report when switching bots.
  useEffect(() => {
    setExpandedRunId(null);
  }, [metabotId]);

  const renderRunCard = (run: MetawebSurfRunInfo) => {
    const expanded = expandedRunId === run.id;
    const statsSummary = formatRunStats(run.stats);
    return (
      <div key={run.id} className={cardClass} data-slot={`surf-report-run-${run.id}`}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => setExpandedRunId(expanded ? null : run.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setExpandedRunId(expanded ? null : run.id);
            }
          }}
          className="flex items-center justify-between gap-3 cursor-pointer select-none"
        >
          <div className="flex items-center gap-2 min-w-0">
            {expanded ? (
              <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary" aria-hidden />
            ) : (
              <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary" aria-hidden />
            )}
            <span className="text-sm font-medium dark:text-claude-darkText text-claude-text break-all">
              {i18nService.t(TRIGGER_LABEL_KEY[run.trigger] ?? 'surfTriggerManualUi')}
            </span>
            <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary shrink-0">
              {formatStartedAt(run.startedAt)}
            </span>
          </div>
          <span
            className={`shrink-0 inline-flex items-center gap-1.5 px-2 py-0.5 text-xs rounded-full border ${STATUS_BADGE_CLASS[run.status] ?? ''}`}
          >
            {run.status === 'running' ? (
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" aria-hidden />
            ) : null}
            {i18nService.t(STATUS_LABEL_KEY[run.status] ?? 'surfStatusRunning')}
          </span>
        </div>
        <p className={hintClass}>
          {statsSummary || '—'}
        </p>
        {expanded ? (
          <div className="space-y-2 pt-1">
            {run.error ? (
              <p className="text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap break-words">{run.error}</p>
            ) : null}
            {run.reportMarkdown ? (
              <div className="rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg p-3">
                <MarkdownContent content={run.reportMarkdown} compact />
              </div>
            ) : !run.error ? (
              <p className={hintClass}>—</p>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="space-y-3" data-slot="surf-reports-panel">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider dark:text-claude-darkTextSecondary text-claude-textSecondary">
          <span>{i18nService.t('surfReportsTitle')}</span>
        </div>
        <button
          type="button"
          data-slot="surf-reports-refresh"
          onClick={() => void loadRuns()}
          className={actionBtnClass}
        >
          <ArrowPathIcon className="h-4 w-4" aria-hidden />
          {i18nService.t('surfReportsRefresh')}
        </button>
      </div>
      {panelError ? (
        <p className="text-xs text-red-600 dark:text-red-400">{panelError}</p>
      ) : null}
      {loaded && !panelError && runs.length === 0 ? (
        <p className={hintClass}>{i18nService.t('surfReportsEmpty')}</p>
      ) : (
        runs.map(renderRunCard)
      )}
    </div>
  );
};

export default SurfReportsPanel;
