import React, { useState } from 'react';
import { i18nService } from '../../services/i18n';
import { CheckCircleIcon } from '@heroicons/react/24/outline';
import type { TrackedCardSummary } from '../../types/trackedTask';
import { suggestionTextForCard } from './trackedTaskFactText';

interface CloseTaskModalProps {
  card: TrackedCardSummary;
  submitting: boolean;
  error: string | null;
  onSubmit: (input: { conclusion: string | null }) => void;
  onCancel: () => void;
}

/**
 * 「收口这张卡」（v1.4：收口＝人类验收）。
 * 只有一个确认动作，没有验收 / 拒绝二选一；结论**选填**——留空就只是确认
 * 验收（落库 NULL，不进执行队列）；填写后 Twin 会把这段结论当指令执行，
 * 并把处理结果与证据写回本卡；破坏性动作仍走既有安全确认，不会静默执行。
 * v1.4 移除「收口人」选择行：在弹窗里收口的就是人自己（owner），历史收口人
 * 展示仍在抽屉里按记录如实显示。
 * 卡上带一句话收口建议时，按钮把它灌进输入框——人只需按需改一两个字。
 */
const CloseTaskModal: React.FC<CloseTaskModalProps> = ({
  card,
  submitting,
  error,
  onSubmit,
  onCancel,
}) => {
  const [conclusion, setConclusion] = useState('');
  // 建议按钮用的是 renderer 渲染的文案（后端只回 suggestion code），填入的也是这句。
  const suggestion = suggestionTextForCard(card);

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center" onClick={onCancel}>
      <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />

      <div
        className="relative w-[460px] max-w-[92vw] rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/30">
            <CheckCircleIcon className="h-5 w-5 text-emerald-500" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
              {i18nService.t('trackedTask.close.title')}
            </h3>
            <p className="mt-0.5 break-words text-xs leading-snug dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {card.title}
            </p>
          </div>
        </div>

        <label className="mt-4 block text-[11px] font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('trackedTask.close.conclusion')}
        </label>
        <textarea
          autoFocus
          value={conclusion}
          onChange={(e) => setConclusion(e.target.value)}
          rows={3}
          placeholder={i18nService.t('trackedTask.close.conclusionPlaceholder')}
          className="mt-1 w-full resize-y rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg px-2.5 py-2 text-sm dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent"
        />
        <p className="mt-1 break-words text-[11px] leading-snug dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('trackedTask.close.recordOnlyHint')}
        </p>

        {suggestion && (
          <button
            type="button"
            onClick={() => setConclusion(suggestion)}
            className="mt-1.5 w-full rounded-md border border-dashed dark:border-claude-darkBorder border-claude-border px-2 py-1 text-left text-[11px] leading-snug dark:text-claude-darkTextSecondary text-claude-textSecondary transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
          >
            {i18nService.t('trackedTask.close.useSuggestion')}：{suggestion}
          </button>
        )}

        {error && <p className="mt-2 break-words text-xs text-red-500">{error}</p>}

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-lg border dark:border-claude-darkBorder border-claude-border px-4 py-2 text-sm dark:text-claude-darkText text-claude-text transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
          >
            {i18nService.t('cancel')}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => onSubmit({ conclusion: conclusion.trim() || null })}
            className="btn-idchat-primary-filled flex-1 px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting
              ? i18nService.t('trackedTask.close.submitting')
              : i18nService.t('trackedTask.close.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CloseTaskModal;
