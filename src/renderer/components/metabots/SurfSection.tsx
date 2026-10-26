/**
 * MetaWeb surf ("AI 冲浪") section for the MetaBot editor's Surf tab.
 *
 * Lets the owner control and observe the bot's autonomous MetaWeb surfing:
 * the surf-before-dream toggle and the per-surf on-chain interaction budget
 * are immediate-effect metabot_settings kv entries (like the OpenTeam /
 * Cowork switches), while "Surf now" starts a background run and the
 * SurfReportsPanel below lists the readable surf reports.
 */

import React, { useEffect, useState } from 'react';
import { GlobeAltIcon, RocketLaunchIcon, QuestionMarkCircleIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { buildMetaBotToggleViewModel } from './metaBotCardPresentation.js';
import SurfReportsPanel from './SurfReportsPanel';
import Tooltip from './Tooltip';

// Keep in sync with src/main/services/surfSettings.ts (pinned by
// tests/quotaRendererSync.test.mjs — the quota audit 2026-09-17 raised the
// main constants and this copy lagged, clamping users to a phantom ceiling).
const SURF_BEFORE_DREAM_ENABLED_KEY = 'surf_before_dream_enabled';
const SURF_INTERACTION_BUDGET_KEY = 'surf_interaction_budget';
const DEFAULT_SURF_INTERACTION_BUDGET = 50;
const MAX_SURF_INTERACTION_BUDGET = 500;
const MIN_SURF_INTERACTION_BUDGET = 0;
const SURF_CREATION_BUDGET_KEY = 'surf_creation_budget';
const SURF_CREATION_MODE_KEY = 'surf_creation_mode';
const DEFAULT_SURF_CREATION_BUDGET = 3;
const MAX_SURF_CREATION_BUDGET = 20;
const MIN_SURF_CREATION_BUDGET = 0;
const SURF_CREATION_MODES = ['off', 'organic', 'encouraged'] as const;
const DEFAULT_SURF_CREATION_MODE: (typeof SURF_CREATION_MODES)[number] = 'organic';

// Same row/label/input chrome the edit form uses, so the section blends in
// (replicated from MetaBotHomepageSection / MetaBotEditTabs).
const rowClass = 'grid grid-cols-1 md:grid-cols-[132px_minmax(0,1fr)] gap-2 md:gap-4 items-start';
const labelClass = 'pt-2 text-sm font-medium dark:text-claude-darkText text-claude-text';
const hintClass = 'text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1';
const inputChromeClass = 'px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent';
const actionBtnClass = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

const clampBudget = (raw: string): number | null => {
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  return Math.min(MAX_SURF_INTERACTION_BUDGET, Math.max(MIN_SURF_INTERACTION_BUDGET, Math.round(num)));
};

const clampCreationBudget = (raw: string): number | null => {
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  return Math.min(MAX_SURF_CREATION_BUDGET, Math.max(MIN_SURF_CREATION_BUDGET, Math.round(num)));
};

const creationModeI18nKey: Record<(typeof SURF_CREATION_MODES)[number], string> = {
  off: 'surfCreationModeOff',
  organic: 'surfCreationModeOrganic',
  encouraged: 'surfCreationModeEncouraged',
};

interface SurfSectionProps {
  metabotId: number;
  /**
   * The bot's PERSISTED type (baseline, not the edited form value): the
   * surf-before-dream default is twin-only (owner decision 2026-10-26 —
   * unset means ON for the Twin, OFF for every other bot), so the toggle's
   * initial state before the kv read resolves must follow the type.
   */
  metabotType: 'twin' | 'worker' | 'welcome';
}

const SurfSection: React.FC<SurfSectionProps> = ({ metabotId, metabotType }) => {
  // Surf-before-dream toggle; the kv default (no record) is twin-only:
  // ON for the Twin bot, OFF for workers/welcome bots (owner decision,
  // 2026-10-26 — an explicit '0' opts any bot out, '1' opts in).
  const [surfBeforeDream, setSurfBeforeDream] = useState(metabotType === 'twin');
  const [surfBeforeDreamLoaded, setSurfBeforeDreamLoaded] = useState(false);
  // Interaction budget, kept as the raw input string while typing.
  const [surfBudget, setSurfBudget] = useState(String(DEFAULT_SURF_INTERACTION_BUDGET));
  // Creation budget + mode (P1c), same immediate-effect kv pattern.
  const [creationBudget, setCreationBudget] = useState(String(DEFAULT_SURF_CREATION_BUDGET));
  const [creationMode, setCreationMode] = useState<(typeof SURF_CREATION_MODES)[number]>(DEFAULT_SURF_CREATION_MODE);
  // Inline error for the kv-setting writes (toggle / budget).
  const [settingsError, setSettingsError] = useState('');
  // Inline error for the surf:runNow invoke.
  const [surfNowError, setSurfNowError] = useState('');
  const [surfNowBusy, setSurfNowBusy] = useState(false);
  // Live surf status for this bot, driven by the surfStatusChanged broadcast.
  const [running, setRunning] = useState(false);
  // Bumped on every surfStatusChanged event for this bot so the reports
  // panel reloads when a run starts or finishes.
  const [runVersion, setRunVersion] = useState(0);

  // Load both surf settings on mount / metabotId change. A missing or failed
  // read falls back to the product defaults (surf-before-dream twin-only,
  // budget 50).
  useEffect(() => {
    let cancelled = false;
    const typeDefaultOn = metabotType === 'twin';
    setSurfBeforeDream(typeDefaultOn);
    setSurfBeforeDreamLoaded(false);
    setSurfBudget(String(DEFAULT_SURF_INTERACTION_BUDGET));
    setCreationBudget(String(DEFAULT_SURF_CREATION_BUDGET));
    setCreationMode(DEFAULT_SURF_CREATION_MODE);
    setSettingsError('');
    setSurfNowError('');
    window.electron.metabot.getSetting(metabotId, SURF_BEFORE_DREAM_ENABLED_KEY)
      .then((result) => {
        if (cancelled) return;
        // null/absent value rides the twin-only type default; an explicit
        // '1'/'0' always wins. A failed read keeps the type default.
        setSurfBeforeDream(result.success && result.value != null ? result.value !== '0' : typeDefaultOn);
        setSurfBeforeDreamLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setSurfBeforeDream(typeDefaultOn);
        setSurfBeforeDreamLoaded(true);
      });
    window.electron.metabot.getSetting(metabotId, SURF_INTERACTION_BUDGET_KEY)
      .then((result) => {
        if (cancelled) return;
        const clamped = result.success && result.value != null ? clampBudget(result.value) : null;
        setSurfBudget(clamped === null ? String(DEFAULT_SURF_INTERACTION_BUDGET) : String(clamped));
      })
      .catch(() => {
        if (cancelled) return;
        setSurfBudget(String(DEFAULT_SURF_INTERACTION_BUDGET));
      });
    window.electron.metabot.getSetting(metabotId, SURF_CREATION_BUDGET_KEY)
      .then((result) => {
        if (cancelled) return;
        const clamped = result.success && result.value != null ? clampCreationBudget(result.value) : null;
        setCreationBudget(clamped === null ? String(DEFAULT_SURF_CREATION_BUDGET) : String(clamped));
      })
      .catch(() => {
        if (cancelled) return;
        setCreationBudget(String(DEFAULT_SURF_CREATION_BUDGET));
      });
    window.electron.metabot.getSetting(metabotId, SURF_CREATION_MODE_KEY)
      .then((result) => {
        if (cancelled) return;
        const raw = result.success ? result.value : null;
        setCreationMode(
          raw && (SURF_CREATION_MODES as readonly string[]).includes(raw)
            ? (raw as (typeof SURF_CREATION_MODES)[number])
            : DEFAULT_SURF_CREATION_MODE,
        );
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [metabotId, metabotType]);

  // Live surf status for this bot (mirrors the dreamStatusChanged pattern in
  // MetabotsManager). Every event also bumps runVersion so the reports panel
  // picks up the new/updated run row. The initial state is seeded from the
  // latest run row — the broadcast only covers transitions while this editor
  // is open, so opening it mid-run used to leave the button clickable and the
  // IPC then rejected with a confusing error (review P3).
  useEffect(() => {
    let cancelled = false;
    setRunning(false);
    window.electron.surf.listRuns(metabotId, 1)
      .then((result) => {
        if (cancelled) return;
        const latest = result.success ? result.runs?.[0] : undefined;
        if (latest?.status === 'running') setRunning(true);
      })
      .catch(() => undefined);
    const off = window.electron.surf?.onStatusChanged?.((payload) => {
      if (payload.metabotId !== metabotId) return;
      setRunning(payload.status === 'running');
      setRunVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [metabotId]);

  const surfBeforeDreamToggleView = buildMetaBotToggleViewModel({
    enabled: surfBeforeDream,
    disabled: !surfBeforeDreamLoaded,
  });

  // Immediate-effect toggle: optimistic flip, persisted via metabot:setSetting;
  // a failed write reverts the switch and surfaces an inline error.
  const handleBeforeDreamToggle = () => {
    if (!surfBeforeDreamLoaded) return;
    const next = !surfBeforeDream;
    setSurfBeforeDream(next);
    setSettingsError('');
    const revert = (message: string) => {
      setSurfBeforeDream(!next);
      setSettingsError(message);
    };
    window.electron.metabot.setSetting(metabotId, SURF_BEFORE_DREAM_ENABLED_KEY, next ? '1' : '0')
      .then((result) => {
        if (!result.success) revert(result.error || i18nService.t('surfSettingSaveFailed'));
      })
      .catch(() => revert(i18nService.t('surfSettingSaveFailed')));
  };

  // Clamp + persist the budget when the field loses focus (or on Enter, which
  // blurs the input). An invalid entry falls back to the default.
  const handleBudgetCommit = () => {
    const clamped = clampBudget(surfBudget);
    const next = clamped === null ? String(DEFAULT_SURF_INTERACTION_BUDGET) : String(clamped);
    setSurfBudget(next);
    setSettingsError('');
    window.electron.metabot.setSetting(metabotId, SURF_INTERACTION_BUDGET_KEY, next)
      .then((result) => {
        if (!result.success) setSettingsError(result.error || i18nService.t('surfSettingSaveFailed'));
      })
      .catch(() => setSettingsError(i18nService.t('surfSettingSaveFailed')));
  };

  // Creation budget: same clamp-on-blur persistence as the interaction budget.
  const handleCreationBudgetCommit = () => {
    const clamped = clampCreationBudget(creationBudget);
    const next = clamped === null ? String(DEFAULT_SURF_CREATION_BUDGET) : String(clamped);
    setCreationBudget(next);
    setSettingsError('');
    window.electron.metabot.setSetting(metabotId, SURF_CREATION_BUDGET_KEY, next)
      .then((result) => {
        if (!result.success) setSettingsError(result.error || i18nService.t('surfSettingSaveFailed'));
      })
      .catch(() => setSettingsError(i18nService.t('surfSettingSaveFailed')));
  };

  // Creation mode: immediate-effect select, optimistic set + revert on failure.
  const handleCreationModeChange = (next: (typeof SURF_CREATION_MODES)[number]) => {
    const prev = creationMode;
    setCreationMode(next);
    setSettingsError('');
    window.electron.metabot.setSetting(metabotId, SURF_CREATION_MODE_KEY, next)
      .then((result) => {
        if (!result.success) {
          setCreationMode(prev);
          setSettingsError(result.error || i18nService.t('surfSettingSaveFailed'));
        }
      })
      .catch(() => {
        setCreationMode(prev);
        setSettingsError(i18nService.t('surfSettingSaveFailed'));
      });
  };

  const handleSurfNow = () => {
    if (running || surfNowBusy) return;
    setSurfNowBusy(true);
    setSurfNowError('');
    window.electron.surf.runNow(metabotId)
      .then((result) => {
        if (!result.success) {
          setSurfNowError(i18nService.t('surfNowFailed').replace('{error}', result.error || 'unknown'));
        } else {
          // The surfStatusChanged broadcast confirms the running state; set it
          // optimistically so the button flips immediately.
          setRunning(true);
        }
      })
      .catch((error) => {
        setSurfNowError(i18nService.t('surfNowFailed').replace('{error}', error instanceof Error ? error.message : 'unknown'));
      })
      .finally(() => setSurfNowBusy(false));
  };

  return (
    <div
      className="space-y-3"
      data-slot="metabot-surf-section"
    >
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider dark:text-claude-darkTextSecondary text-claude-textSecondary">
        <GlobeAltIcon className="h-3.5 w-3.5" aria-hidden />
        <span>{i18nService.t('surfSectionTitle')}</span>
      </div>
      <div className="flex items-center gap-2">
        <p className={hintClass}>{i18nService.t('surfSectionHint')}</p>
        <Tooltip content={i18nService.t('surfSectionTooltip')}>
          <QuestionMarkCircleIcon
            className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary shrink-0 cursor-help"
            aria-label="More info"
          />
        </Tooltip>
      </div>
      {settingsError ? (
        <p className="text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap break-words">{settingsError}</p>
      ) : null}

      {/* Surf before dream: immediate-effect kv switch, outside the tab's dirty/save flow. */}
      <div className={rowClass} data-slot="metabot-surf-before-dream-row">
        <label id="metabot-surf-before-dream-label" className={labelClass}>
          {i18nService.t('surfBeforeDreamToggle')}
        </label>
        <div className="min-w-0">
          <div className="flex items-center gap-3 pt-1">
            <div
              role="switch"
              aria-checked={surfBeforeDream}
              aria-labelledby="metabot-surf-before-dream-label"
              data-slot="metabot-surf-before-dream-switch"
              title={i18nService.t('surfBeforeDreamToggle')}
              className={surfBeforeDreamToggleView.trackClass}
              onClick={handleBeforeDreamToggle}
            >
              <div className={surfBeforeDreamToggleView.knobClass} />
            </div>
          </div>
        </div>
      </div>

      {/* Interaction budget per surf. */}
      <div className={rowClass} data-slot="metabot-surf-budget-row">
        <label htmlFor="metabot-surf-budget" className={labelClass}>
          {i18nService.t('surfInteractionBudgetLabel')}
        </label>
        <div className="min-w-0">
          <input
            id="metabot-surf-budget"
            type="number"
            min={MIN_SURF_INTERACTION_BUDGET}
            max={MAX_SURF_INTERACTION_BUDGET}
            step={1}
            value={surfBudget}
            onChange={(e) => setSurfBudget(e.target.value)}
            onBlur={handleBudgetCommit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            className={`w-24 ${inputChromeClass}`}
          />
          <p className={hintClass}>
            {i18nService.t('surfInteractionBudgetHint')}
          </p>
        </div>
      </div>

      {/* Creation budget per surf (P1a): own pool, never competes with interactions. */}
      <div className={rowClass} data-slot="metabot-surf-creation-budget-row">
        <label htmlFor="metabot-surf-creation-budget" className={labelClass}>
          {i18nService.t('surfCreationBudgetLabel')}
        </label>
        <div className="min-w-0">
          <input
            id="metabot-surf-creation-budget"
            type="number"
            min={MIN_SURF_CREATION_BUDGET}
            max={MAX_SURF_CREATION_BUDGET}
            step={1}
            value={creationBudget}
            onChange={(e) => setCreationBudget(e.target.value)}
            onBlur={handleCreationBudgetCommit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            className={`w-24 ${inputChromeClass}`}
          />
          <p className={hintClass}>
            {i18nService.t('surfCreationBudgetHint')}
          </p>
        </div>
      </div>

      {/* Creation mode (P1c): off / organic / encouraged. */}
      <div className={rowClass} data-slot="metabot-surf-creation-mode-row">
        <label htmlFor="metabot-surf-creation-mode" className={labelClass}>
          {i18nService.t('surfCreationModeLabel')}
        </label>
        <div className="min-w-0">
          <select
            id="metabot-surf-creation-mode"
            value={creationMode}
            onChange={(e) => handleCreationModeChange(e.target.value as (typeof SURF_CREATION_MODES)[number])}
            className={`w-56 ${inputChromeClass}`}
            data-slot="metabot-surf-creation-mode-select"
          >
            {SURF_CREATION_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {i18nService.t(creationModeI18nKey[mode])}
              </option>
            ))}
          </select>
          <p className={hintClass}>
            {i18nService.t('surfCreationModeHint')}
          </p>
        </div>
      </div>

      {/* Surf now trigger. */}
      <div className={rowClass} data-slot="metabot-surf-now-row">
        <div className="hidden md:block" />
        <div className="min-w-0 flex flex-wrap items-center gap-3">
          <button
            type="button"
            data-slot="metabot-surf-now"
            onClick={handleSurfNow}
            disabled={running || surfNowBusy}
            className={actionBtnClass}
          >
            <RocketLaunchIcon className="h-4 w-4" aria-hidden />
            {running || surfNowBusy ? i18nService.t('surfNowRunning') : i18nService.t('surfNowButton')}
          </button>
          {surfNowError ? (
            <span className="text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap break-words">
              {surfNowError}
            </span>
          ) : null}
        </div>
      </div>

      <SurfReportsPanel metabotId={metabotId} refreshToken={runVersion} />
    </div>
  );
};

export default SurfSection;
