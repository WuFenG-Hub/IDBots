/**
 * Daily Report ("每日汇报") section for the MetaBot editor's Advanced tab,
 * rendered only for the Twin Bot.
 *
 * Once enabled, the Twin Bot proactively opens a new local conversation at the
 * configured local hour each day with a briefing (pending follow-ups, progress
 * on human-sourced work, fleet activity). Both settings are immediate-effect
 * metabot_settings kv entries (like the Surf switches): an enable toggle
 * ('dailyReport.enabled', default OFF) and the report hour ('dailyReport.hour',
 * whole hours 0–23, default 8).
 *
 * The feature also requires the global experimental-automation master switch
 * (Settings → General); while that switch is off this section renders greyed
 * out with an explanatory hint.
 */

import React, { useEffect, useState } from 'react';
import { NewspaperIcon, PlayIcon, QuestionMarkCircleIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { buildMetaBotToggleViewModel } from './metaBotCardPresentation.js';
import Tooltip from './Tooltip';

// Keep in sync with src/main/services/dailyReportSettings.ts (keys whitelisted
// main-side in RENDERER_SETTING_DEFS with a normalizeValue each).
const DAILY_REPORT_ENABLED_KEY = 'dailyReport.enabled';
const DAILY_REPORT_HOUR_KEY = 'dailyReport.hour';
const DEFAULT_DAILY_REPORT_HOUR = 8;
const MIN_DAILY_REPORT_HOUR = 0;
const MAX_DAILY_REPORT_HOUR = 23;

// Same row/label/input chrome the edit form uses, so the section blends in
// (replicated from SurfSection / MetaBotEditTabs).
const rowClass = 'grid grid-cols-1 md:grid-cols-[132px_minmax(0,1fr)] gap-2 md:gap-4 items-start';
const labelClass = 'pt-2 text-sm font-medium dark:text-claude-darkText text-claude-text';
const hintClass = 'text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1';
const inputChromeClass = 'px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent disabled:opacity-50 disabled:cursor-not-allowed';
const actionBtnClass = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

// Read through the typed preload bridge (electron.d.ts); the runtime guard keeps
// a stale preload (older app shell) from crashing the button — it renders a
// clean 'unavailable' note instead.
const getDailyReportApi = (): typeof window.electron.dailyReport | null =>
  (typeof window.electron?.dailyReport?.runNow === 'function' ? window.electron.dailyReport : null);

// Known 'unavailable' reason tokens mapped to friendly i18n copy (kept in sync
// with the service's DailyReportRunNowResult); anything unrecognized falls back
// to the raw reason text.
const DAILY_REPORT_UNAVAILABLE_REASON_KEYS: Record<string, string> = {
  no_twin: 'dailyReportRunNowUnavailableNoTwin',
  experimental_disabled: 'dailyReportRunNowUnavailableExperimentalOff',
  feature_disabled: 'dailyReportRunNowUnavailableDisabled',
  deferred: 'dailyReportRunNowUnavailableFreshInstall',
  already_running: 'dailyReportRunNowAlreadyRunning',
};

const clampHour = (raw: string): number | null => {
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  return Math.min(MAX_DAILY_REPORT_HOUR, Math.max(MIN_DAILY_REPORT_HOUR, Math.round(num)));
};

const formatHourOptionLabel = (hour: number): string => `${String(hour).padStart(2, '0')}:00`;

interface DailyReportSectionProps {
  metabotId: number;
}

const DailyReportSection: React.FC<DailyReportSectionProps> = ({ metabotId }) => {
  // Enable toggle; the kv default (no record) means OFF (explicit '1' opts in).
  const [enabled, setEnabled] = useState(false);
  const [enabledLoaded, setEnabledLoaded] = useState(false);
  // Report hour, kept as the raw select value ('0'..'23').
  const [hour, setHour] = useState(String(DEFAULT_DAILY_REPORT_HOUR));
  // Global experimental-automation master switch (Settings → General). The
  // main-side default when the key is missing is ALLOWED, so default true and
  // let the IPC read correct it.
  const [experimentalAllowed, setExperimentalAllowed] = useState(true);
  // Inline error for the kv-setting writes (toggle / hour).
  const [settingsError, setSettingsError] = useState('');
  // "Run now" trigger: busy flag + the last result note (success / info / error).
  const [runNowBusy, setRunNowBusy] = useState(false);
  const [runNowNote, setRunNowNote] = useState<{ kind: 'success' | 'info' | 'error'; text: string } | null>(null);

  // Load both daily-report settings on mount / metabotId change. A missing or
  // failed read falls back to the product defaults (OFF, 08:00).
  useEffect(() => {
    let cancelled = false;
    setEnabled(false);
    setEnabledLoaded(false);
    setHour(String(DEFAULT_DAILY_REPORT_HOUR));
    setSettingsError('');
    setRunNowNote(null);
    window.electron.metabot.getSetting(metabotId, DAILY_REPORT_ENABLED_KEY)
      .then((result) => {
        if (cancelled) return;
        setEnabled(result.success ? result.value === '1' : false);
        setEnabledLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setEnabled(false);
        setEnabledLoaded(true);
      });
    window.electron.metabot.getSetting(metabotId, DAILY_REPORT_HOUR_KEY)
      .then((result) => {
        if (cancelled) return;
        const clamped = result.success && result.value != null ? clampHour(result.value) : null;
        setHour(String(clamped === null ? DEFAULT_DAILY_REPORT_HOUR : clamped));
      })
      .catch(() => {
        if (cancelled) return;
        setHour(String(DEFAULT_DAILY_REPORT_HOUR));
      });
    return () => { cancelled = true; };
  }, [metabotId]);

  // Global experimental-automation switch; while it is off the section stays
  // greyed out and non-interactive.
  useEffect(() => {
    let cancelled = false;
    window.electron.experimentalAutomation.get()
      .then(({ enabled: allowed }) => {
        if (cancelled) return;
        setExperimentalAllowed(allowed);
      })
      .catch(() => {
        // Missing key means allowed main-side; keep the permissive default.
        if (cancelled) return;
        setExperimentalAllowed(true);
      });
    return () => { cancelled = true; };
  }, []);

  const enabledToggleView = buildMetaBotToggleViewModel({
    enabled,
    disabled: !enabledLoaded || !experimentalAllowed,
  });

  // Immediate-effect toggle: optimistic flip, persisted via metabot:setSetting;
  // a failed write reverts the switch and surfaces an inline error.
  const handleEnabledToggle = () => {
    if (!enabledLoaded || !experimentalAllowed) return;
    const next = !enabled;
    setEnabled(next);
    setSettingsError('');
    const revert = (message: string) => {
      setEnabled(!next);
      setSettingsError(message);
    };
    window.electron.metabot.setSetting(metabotId, DAILY_REPORT_ENABLED_KEY, next ? '1' : '0')
      .then((result) => {
        if (!result.success) revert(result.error || i18nService.t('dailyReportSettingSaveFailed'));
      })
      .catch(() => revert(i18nService.t('dailyReportSettingSaveFailed')));
  };

  // Hour select: immediate-effect select, optimistic set + revert on failure.
  const handleHourChange = (next: string) => {
    if (!experimentalAllowed) return;
    const prev = hour;
    setHour(next);
    setSettingsError('');
    window.electron.metabot.setSetting(metabotId, DAILY_REPORT_HOUR_KEY, next)
      .then((result) => {
        if (!result.success) {
          setHour(prev);
          setSettingsError(result.error || i18nService.t('dailyReportSettingSaveFailed'));
        }
      })
      .catch(() => {
        setHour(prev);
        setSettingsError(i18nService.t('dailyReportSettingSaveFailed'));
      });
  };

  // Manual trigger ("立即汇报"): asks the main process to generate today's
  // report immediately. Completed runs jump straight to the new report
  // session via the app-wide 'cowork:viewSession' event (handler in App.tsx).
  const handleRunNow = () => {
    if (runNowBusy || !enabled || !enabledLoaded || !experimentalAllowed) return;
    const api = getDailyReportApi();
    if (!api || typeof api.runNow !== 'function') {
      setRunNowNote({ kind: 'error', text: i18nService.t('dailyReportRunNowUnavailable').replace('{reason}', 'dailyReport ipc not registered') });
      return;
    }
    setRunNowBusy(true);
    setRunNowNote(null);
    api.runNow()
      .then((result) => {
        if (!result || typeof result !== 'object') {
          setRunNowNote({ kind: 'error', text: i18nService.t('dailyReportRunNowFailed').replace('{error}', 'unknown') });
          return;
        }
        switch (result.status) {
          case 'completed':
            if (result.sessionId) {
              window.dispatchEvent(new CustomEvent('cowork:viewSession', { detail: { sessionId: result.sessionId } }));
            }
            setRunNowNote({ kind: 'success', text: i18nService.t('dailyReportRunNowCompleted') });
            break;
          case 'skipped':
            setRunNowNote({ kind: 'info', text: i18nService.t('dailyReportRunNowSkipped') });
            break;
          case 'failed':
            setRunNowNote({ kind: 'error', text: i18nService.t('dailyReportRunNowFailed').replace('{error}', result.error || 'unknown') });
            break;
          case 'unavailable': {
            const reasonKey = DAILY_REPORT_UNAVAILABLE_REASON_KEYS[result.reason];
            const reasonText = reasonKey ? i18nService.t(reasonKey) : (result.reason || 'unknown');
            setRunNowNote({ kind: 'error', text: i18nService.t('dailyReportRunNowUnavailable').replace('{reason}', reasonText) });
            break;
          }
          default:
            setRunNowNote({ kind: 'error', text: i18nService.t('dailyReportRunNowFailed').replace('{error}', 'unknown') });
        }
      })
      .catch((error) => {
        setRunNowNote({
          kind: 'error',
          text: i18nService.t('dailyReportRunNowFailed').replace('{error}', error instanceof Error ? error.message : 'unknown'),
        });
      })
      .finally(() => setRunNowBusy(false));
  };

  return (
    <div
      className={`space-y-3 ${experimentalAllowed ? '' : 'opacity-60'}`}
      data-slot="metabot-daily-report-section"
    >
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider dark:text-claude-darkTextSecondary text-claude-textSecondary">
        <NewspaperIcon className="h-3.5 w-3.5" aria-hidden />
        <span>{i18nService.t('dailyReportSectionTitle')}</span>
        <span className="rounded-full border px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('dailyReportExperimentalBadge')}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <p className={hintClass}>{i18nService.t('dailyReportSectionHint')}</p>
        <Tooltip content={i18nService.t('dailyReportSectionTooltip')}>
          <QuestionMarkCircleIcon
            className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary shrink-0 cursor-help"
            aria-label="More info"
          />
        </Tooltip>
      </div>
      {!experimentalAllowed ? (
        <p className="text-xs text-amber-600 dark:text-amber-400 whitespace-pre-wrap break-words">
          {i18nService.t('dailyReportGlobalSwitchRequired')}
        </p>
      ) : null}
      {settingsError ? (
        <p className="text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap break-words">{settingsError}</p>
      ) : null}

      {/* Enable toggle: immediate-effect kv switch, outside the tab's dirty/save flow. */}
      <div className={rowClass} data-slot="metabot-daily-report-enabled-row">
        <label id="metabot-daily-report-enabled-label" className={labelClass}>
          {i18nService.t('dailyReportEnableToggle')}
        </label>
        <div className="min-w-0">
          <div className="flex items-center gap-3 pt-1">
            <div
              role="switch"
              aria-checked={enabled}
              aria-labelledby="metabot-daily-report-enabled-label"
              data-slot="metabot-daily-report-enabled-switch"
              title={i18nService.t('dailyReportEnableToggle')}
              className={enabledToggleView.trackClass}
              onClick={handleEnabledToggle}
            >
              <div className={enabledToggleView.knobClass} />
            </div>
          </div>
          <p className={hintClass}>
            {i18nService.t('dailyReportEnableHint')}
          </p>
        </div>
      </div>

      {/* Run now: manual trigger for today's report (experimental UI — only
          rendered while the global experimental-automation switch is ON).
          Disabled until the per-bot daily report is enabled. */}
      {experimentalAllowed ? (
        <div className={rowClass} data-slot="metabot-daily-report-run-now-row">
          <div className="hidden md:block" />
          <div className="min-w-0 flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-slot="metabot-daily-report-run-now"
              onClick={handleRunNow}
              disabled={runNowBusy || !enabledLoaded || !enabled}
              className={actionBtnClass}
              title={i18nService.t('dailyReportRunNowButton')}
            >
              <PlayIcon className="h-4 w-4" aria-hidden />
              {runNowBusy ? i18nService.t('dailyReportRunNowRunning') : i18nService.t('dailyReportRunNowButton')}
            </button>
            {enabledLoaded && !enabled ? (
              <span className={hintClass}>
                {i18nService.t('dailyReportRunNowDisabledHint')}
              </span>
            ) : null}
            {runNowNote ? (
              <span
                className={
                  runNowNote.kind === 'success'
                    ? 'text-xs text-green-600 dark:text-green-400 whitespace-pre-wrap break-words'
                    : runNowNote.kind === 'info'
                      ? 'text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary whitespace-pre-wrap break-words'
                      : 'text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap break-words'
                }
              >
                {runNowNote.text}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Report hour: immediate-effect select with the 24 whole-hour options. */}
      <div className={rowClass} data-slot="metabot-daily-report-hour-row">
        <label htmlFor="metabot-daily-report-hour" className={labelClass}>
          {i18nService.t('dailyReportHourLabel')}
        </label>
        <div className="min-w-0">
          <select
            id="metabot-daily-report-hour"
            value={hour}
            onChange={(e) => handleHourChange(e.target.value)}
            disabled={!experimentalAllowed}
            className={`w-56 ${inputChromeClass}`}
            data-slot="metabot-daily-report-hour-select"
          >
            {Array.from({ length: MAX_DAILY_REPORT_HOUR - MIN_DAILY_REPORT_HOUR + 1 }, (_, i) => {
              const value = String(MIN_DAILY_REPORT_HOUR + i);
              return (
                <option key={value} value={value}>
                  {formatHourOptionLabel(MIN_DAILY_REPORT_HOUR + i)}
                </option>
              );
            })}
          </select>
          <p className={hintClass}>
            {i18nService.t('dailyReportHourHint')}
          </p>
        </div>
      </div>
    </div>
  );
};

export default DailyReportSection;
