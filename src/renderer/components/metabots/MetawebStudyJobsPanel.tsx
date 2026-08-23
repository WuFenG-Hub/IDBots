/**
 * MetaWeb study jobs panel ("自主学习") — the read-only M4 status view living
 * at the bottom of the knowledge-base tab.
 *
 * The owner assigns study topics in chat ("有空学学 X" → the bot queues a job
 * via metaweb_study_enqueue); nightly background sessions search MetaWeb,
 * read pins, and save the worthwhile bodies into this bot's knowledge bases.
 * This panel is the deliberate substitute for a proactive morning report
 * (locked owner decision 2026-08-23): job status is visible here on demand,
 * and the bot answers from metaweb_study_status when asked. Read-only by
 * design — jobs are created/cancelled through conversation, not here.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { AcademicCapIcon, ArrowPathIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { MetawebStudyJobInfo, MetawebStudyJobStatus } from '../../types/metawebStudy';

interface MetawebStudyJobsPanelProps {
  metabotId: number;
}

// Replicated from KnowledgeBasePanel (kept in sync with the edit-tab chrome).
const hintClass = 'text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1';
const cardClass = 'rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-4 space-y-3';
const actionBtnClass = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

const STATUS_BADGE_CLASS: Record<MetawebStudyJobStatus, string> = {
  pending: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
  running: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
  done: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  failed: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30',
};

const STATUS_LABEL_KEY: Record<MetawebStudyJobStatus, string> = {
  pending: 'metawebStudyStatusPending',
  running: 'metawebStudyStatusRunning',
  done: 'metawebStudyStatusDone',
  failed: 'metawebStudyStatusFailed',
};

const formatRunAt = (iso: string | null): string => {
  if (!iso) return i18nService.t('metawebStudyNever');
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleString();
};

const MetawebStudyJobsPanel: React.FC<MetawebStudyJobsPanelProps> = ({ metabotId }) => {
  const [jobs, setJobs] = useState<MetawebStudyJobInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [panelError, setPanelError] = useState('');

  const loadJobs = useCallback(async () => {
    try {
      const result = await window.electron.metawebStudy.list(metabotId);
      if (result.success && result.jobs) {
        setJobs(result.jobs);
        setPanelError('');
      } else {
        setPanelError(result.error || i18nService.t('metawebStudyLoadFailed'));
      }
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : i18nService.t('metawebStudyLoadFailed'));
    } finally {
      setLoaded(true);
    }
  }, [metabotId]);

  // (Re)load when a different bot is loaded into the same mounted editor.
  useEffect(() => {
    setJobs([]);
    setLoaded(false);
    setPanelError('');
    void loadJobs();
  }, [loadJobs]);

  const renderCard = (job: MetawebStudyJobInfo) => (
    <div key={job.id} className={cardClass} data-slot={`metaweb-study-job-${job.id}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium dark:text-claude-darkText text-claude-text break-all">
          {job.topic}
        </div>
        <span
          className={`shrink-0 inline-flex items-center px-2 py-0.5 text-xs rounded-full border ${STATUS_BADGE_CLASS[job.status] ?? ''}`}
        >
          {i18nService.t(STATUS_LABEL_KEY[job.status] ?? 'metawebStudyStatusPending')}
        </span>
      </div>
      <p className={hintClass}>
        {i18nService.t('metawebStudyJobStats')
          .replace('{runs}', String(job.runCount))
          .replace('{pins}', String(job.processedPinIds.length))
          .replace('{budget}', String(job.budgetPins))}
        {' · '}
        {i18nService.t('metawebStudyLastRun').replace('{time}', formatRunAt(job.lastRunAt))}
      </p>
      {job.lastRunSummary ? (
        <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary whitespace-pre-wrap break-words">
          {job.lastRunSummary}
        </p>
      ) : null}
      {job.lastError ? (
        <p className="text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap break-words">{job.lastError}</p>
      ) : null}
    </div>
  );

  return (
    <div className="space-y-3 pt-4 mt-4 border-t dark:border-claude-darkBorder border-claude-border">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider dark:text-claude-darkTextSecondary text-claude-textSecondary">
          <AcademicCapIcon className="h-3.5 w-3.5" aria-hidden />
          <span>{i18nService.t('metawebStudyPanelTitle')}</span>
        </div>
        <button
          type="button"
          data-slot="metaweb-study-refresh"
          onClick={() => void loadJobs()}
          className={actionBtnClass}
        >
          <ArrowPathIcon className="h-4 w-4" aria-hidden />
          {i18nService.t('metawebStudyRefresh')}
        </button>
      </div>
      <p className={hintClass}>{i18nService.t('metawebStudyPanelHint')}</p>
      {panelError ? (
        <p className="text-xs text-red-600 dark:text-red-400">{panelError}</p>
      ) : null}
      {loaded && !panelError && jobs.length === 0 ? (
        <p className={hintClass}>{i18nService.t('metawebStudyEmpty')}</p>
      ) : (
        jobs.map(renderCard)
      )}
    </div>
  );
};

export default MetawebStudyJobsPanel;
