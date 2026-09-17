import React, { useCallback, useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { trackedTaskService } from '../../services/trackedTask';
import type { TrackedAdmissionMode, TrackedAdmissionRule } from '../../types/trackedTask';
import { TRACKED_ADMISSION_RULE_LABEL_KEYS } from '../../types/trackedTask';

/** 宽口径 = 任一条命中即准入；严口径 = 仅 ADM-1 ∨ ADM-3。 */
const WIDE_RULES: TrackedAdmissionRule[] = ['ADM-1', 'ADM-2', 'ADM-3', 'ADM-4', 'ADM-5'];
const STRICT_RULES: TrackedAdmissionRule[] = ['ADM-1', 'ADM-3'];

/**
 * 准入规则设置（v1.1 冻结件 §2）。
 *
 * 「长期任务看板」把整本委派台账投影成卡片时，单步委派收据会挤满「需要收口」队列。
 * 准入规则决定哪一行够格成卡：不够格的行进归档（仍可查、不删数据），不进收口队列。
 *
 * 口径开关持久化在既有 `kv` 表（key `tracked_admission_mode`）——改它不动任何
 * 数据结构：没有新列、没有新表，切换可逆（切回 `wide` 即完全复原判定）。
 */
const TrackedTaskSettings: React.FC = () => {
  const [mode, setMode] = useState<TrackedAdmissionMode | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void trackedTaskService.loadAdmissionMode().then(setMode);
  }, []);

  const change = useCallback(async (next: TrackedAdmissionMode) => {
    setPending(true);
    const applied = await trackedTaskService.setAdmissionMode(next);
    if (applied) setMode(applied);
    setPending(false);
  }, []);

  const activeRules = mode === 'strict' ? STRICT_RULES : WIDE_RULES;

  return (
    <div className="space-y-6">
      <div className="space-y-3 rounded-xl border px-4 py-4 dark:border-claude-darkBorder border-claude-border">
        <div>
          <div className="text-sm font-medium dark:text-claude-darkText text-claude-text">
            {i18nService.t('trackedTask.admission.title')}
          </div>
          <div className="mt-0.5 text-xs leading-relaxed dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('trackedTask.admission.hint')}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border p-0.5 dark:border-claude-darkBorder border-claude-border">
            {(['wide', 'strict'] as const).map((candidate) => {
              const active = mode === candidate;
              return (
                <button
                  key={candidate}
                  type="button"
                  aria-pressed={active}
                  disabled={pending}
                  onClick={() => void change(candidate)}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                    active
                      ? 'bg-claude-accent/10 dark:text-claude-darkText text-claude-text'
                      : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
                  }`}
                >
                  {i18nService.t(
                    candidate === 'wide' ? 'trackedTask.admission.modeWide' : 'trackedTask.admission.modeStrict'
                  )}
                </button>
              );
            })}
          </div>
          <span className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('trackedTask.admission.reversible')}
          </span>
        </div>

        <div className="rounded-lg border border-dashed px-3 py-2 dark:border-claude-darkBorder border-claude-border">
          <div className="text-[11px] font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('trackedTask.admission.activeRules')}
          </div>
          <ul className="mt-1 space-y-1">
            {(['ADM-1', 'ADM-2', 'ADM-3', 'ADM-4', 'ADM-5'] as TrackedAdmissionRule[]).map((rule) => {
              const on = activeRules.includes(rule);
              return (
                <li
                  key={rule}
                  className={`flex items-start gap-2 text-xs ${
                    on
                      ? 'dark:text-claude-darkText text-claude-text'
                      : 'dark:text-claude-darkTextSecondary text-claude-textSecondary line-through opacity-60'
                  }`}
                >
                  <span className="mt-[2px] font-mono text-[10px]">{rule}</span>
                  <span className="leading-relaxed">{i18nService.t(TRACKED_ADMISSION_RULE_LABEL_KEYS[rule])}</span>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="text-[11px] leading-relaxed dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('trackedTask.admission.notAdmitted')}
        </div>
      </div>
    </div>
  );
};

export default TrackedTaskSettings;
