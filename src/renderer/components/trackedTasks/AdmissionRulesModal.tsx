import React from 'react';
import { i18nService } from '../../services/i18n';
import { QuestionMarkCircleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { TRACKED_ADMISSION_RULE_LABEL_KEYS } from '../../types/trackedTask';
import type { TrackedAdmissionRule } from '../../types/trackedTask';

const ADMISSION_RULES: TrackedAdmissionRule[] = ['ADM-1', 'ADM-2', 'ADM-3', 'ADM-4', 'ADM-5'];

/**
 * 「长期任务准入规则」说明 modal（owner 2026-09-18 反馈④）。
 * 内容复用 trackedTask.admission.* 的既有键（设置页 TrackedTaskSettings 同源），
 * 另加两条：不够格行的归档去向、口径切换入口。
 * 根节点 non-draggable：modal 盖住 48px 拖拽头条带，不标 no-drag 的话顶部条带
 * 里的点击会被窗口拖拽吞掉（与任务卡抽屉同一坑，TrackedTaskCardItem 已有同款防御）。
 */
const AdmissionRulesModal: React.FC<{ onClose: () => void }> = ({ onClose }) => (
  <div className="non-draggable fixed inset-0 z-[9999] flex items-center justify-center" onClick={onClose}>
    <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />

    <div
      className="relative max-h-[80vh] w-[520px] max-w-[92vw] overflow-y-auto rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-white p-5 shadow-2xl"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-start gap-2">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-claude-accent/10">
          <QuestionMarkCircleIcon className="h-5 w-5 text-claude-accent" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
            {i18nService.t('trackedTask.admission.title')}
          </h3>
          <p className="mt-1 break-words text-xs leading-snug dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('trackedTask.admission.hint')}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={i18nService.t('close')}
          className="shrink-0 rounded-lg p-1.5 dark:text-claude-darkTextSecondary text-claude-textSecondary transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
        >
          <XMarkIcon className="w-4 h-4" />
        </button>
      </div>

      <h4 className="mt-4 text-[11px] font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {i18nService.t('trackedTask.admission.activeRules')}
      </h4>
      <ul className="mt-1.5 space-y-1">
        {ADMISSION_RULES.map((rule) => (
          <li
            key={rule}
            className="flex items-baseline gap-2 text-xs leading-snug dark:text-claude-darkText text-claude-text"
          >
            <span className="shrink-0 rounded border dark:border-claude-darkBorder border-claude-border px-1 py-[1px] font-mono text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {rule}
            </span>
            <span className="break-words">{i18nService.t(TRACKED_ADMISSION_RULE_LABEL_KEYS[rule])}</span>
          </li>
        ))}
      </ul>

      <p className="mt-3 break-words text-xs leading-snug dark:text-claude-darkText text-claude-text">
        {i18nService.t('trackedTask.admission.archiveNote')}
      </p>
      <p className="mt-1.5 break-words text-xs leading-snug dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {i18nService.t('trackedTask.admission.modeSwitchNote')}
      </p>
    </div>
  </div>
);

export default AdmissionRulesModal;
