/**
 * Minimal MetaBot creation form.
 * Only the essentials are collected at creation time: name (required),
 * primary LLM (required) and fallback LLM (optional, defaults to None).
 * All other profile fields (role/soul/goal/bio/avatar/owner/skills) are
 * filled in later through the edit view, after the bot exists on-chain.
 * Styling intentionally mirrors MetaBotForm (same row/label/input classes).
 */

import React, { useState } from 'react';
import { i18nService } from '../../services/i18n';
import type { LlmOption } from './MetaBotEditTabs';

export interface MetaBotCreateFormValues {
  name: string;
  llm_id: string;
  fallback_llm_id: string;
}

interface MetaBotCreateFormProps {
  onCancel: () => void;
  onSave: (values: MetaBotCreateFormValues) => Promise<void>;
  saveLabel?: string;
  /** Available LLM providers for selection. Empty = none available. */
  llmOptions: LlmOption[];
  /** Called when user clicks "Go to Model Settings" (e.g. to open Settings tab). */
  onRequestModelSettings?: () => void;
  /** Check if name already exists (for uniqueness). Returns true if duplicate. */
  onCheckNameExists?: (name: string, excludeId?: number) => Promise<boolean>;
}

const MetaBotCreateForm: React.FC<MetaBotCreateFormProps> = ({
  onCancel,
  onSave,
  saveLabel,
  llmOptions,
  onRequestModelSettings,
  onCheckNameExists,
}) => {
  const [values, setValues] = useState<MetaBotCreateFormValues>({ name: '', llm_id: '', fallback_llm_id: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [nameDuplicate, setNameDuplicate] = useState(false);

  const handleChange = <K extends keyof MetaBotCreateFormValues>(field: K, value: MetaBotCreateFormValues[K]) => {
    setValues((prev) => ({ ...prev, [field]: value }));
    setError('');
    if (field === 'name') setNameDuplicate(false);
  };

  const handleNameBlur = async () => {
    const name = values.name.trim();
    if (!name || !onCheckNameExists) return;
    const exists = await onCheckNameExists(name);
    setNameDuplicate(exists);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!values.name.trim()) {
      setError(i18nService.t('metabotNameRequired'));
      return;
    }
    if (nameDuplicate) {
      setError(i18nService.t('metabotNameDuplicate'));
      return;
    }
    if (onCheckNameExists) {
      const exists = await onCheckNameExists(values.name.trim());
      if (exists) {
        setError(i18nService.t('metabotNameDuplicate'));
        setNameDuplicate(true);
        return;
      }
    }
    if (!values.llm_id.trim()) {
      setError(i18nService.t('metabotLlmRequired'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave({
        name: values.name.trim(),
        llm_id: values.llm_id.trim(),
        fallback_llm_id: values.fallback_llm_id.trim(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : i18nService.t('metabotSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const saveButtonLabel = saveLabel ?? i18nService.t('metabotCreate');
  const hasNoAvailableLlm = llmOptions.length === 0;
  const canSave = !hasNoAvailableLlm;
  const rowClass = 'grid grid-cols-1 md:grid-cols-[132px_minmax(0,1fr)] gap-2 md:gap-4 items-start';
  const labelClass = 'pt-2 text-sm font-medium dark:text-claude-darkText text-claude-text';
  const hintClass = 'text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1';
  const inputClass = 'w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent';

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {error && (
        <div className="text-sm text-red-500 dark:text-red-400 bg-red-500/10 dark:bg-red-500/10 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      <div className={rowClass}>
        <label htmlFor="metabot-name" className={labelClass}>
          {i18nService.t('metabotName')}
          <span className="ml-1 text-red-500">*</span>
        </label>
        <div className="min-w-0">
          <input
            id="metabot-name"
            type="text"
            value={values.name}
            onChange={(e) => handleChange('name', e.target.value)}
            onBlur={handleNameBlur}
            placeholder={i18nService.t('metabotNamePlaceholder')}
            className={`${inputClass} ${nameDuplicate ? 'border-red-500 dark:border-red-500' : ''}`}
          />
          {nameDuplicate && (
            <p className="text-xs text-red-500 mt-1">
              {i18nService.t('metabotNameDuplicate')}
            </p>
          )}
        </div>
      </div>

      <div className={rowClass}>
        <label htmlFor="metabot-llm" className={labelClass}>
          {i18nService.t('metabotLlmProvider')}
          <span className="ml-1 text-red-500">*</span>
        </label>
        <div className="min-w-0">
          {hasNoAvailableLlm ? (
            <div
              data-slot="metabot-no-llm-guidance"
              className="rounded-xl border dark:border-claude-darkBorder border-claude-border px-3 py-3 dark:bg-claude-darkSurface/50 bg-claude-surface/50"
            >
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('metabotNoAvailableLlm')}
              </p>
              {onRequestModelSettings && (
                <button
                  type="button"
                  onClick={onRequestModelSettings}
                  className="mt-2 text-sm text-claude-accent hover:underline"
                >
                  {i18nService.t('metabotGoToModelSettings')}
                </button>
              )}
            </div>
          ) : (
            <>
              <select
                id="metabot-llm"
                value={values.llm_id}
                onChange={(e) => handleChange('llm_id', e.target.value)}
                className={inputClass}
              >
                <option value="">{i18nService.t('metabotLlmIdPlaceholder')}</option>
                {llmOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <p className={hintClass}>
                {i18nService.t('metabotLlmRequired')}
              </p>
            </>
          )}
        </div>
      </div>

      {!hasNoAvailableLlm && (
        <div className={rowClass}>
          <label htmlFor="metabot-fallback-llm" className={labelClass}>
            {i18nService.t('metabotFallbackLlmLabel')}
          </label>
          <div className="min-w-0">
            <select
              id="metabot-fallback-llm"
              value={values.fallback_llm_id}
              onChange={(e) => handleChange('fallback_llm_id', e.target.value)}
              className={inputClass}
            >
              <option value="">{i18nService.t('metabotFallbackLlmNone')}</option>
              {llmOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
            <p className={hintClass}>
              {i18nService.t('metabotFallbackLlmHint')}
            </p>
          </div>
        </div>
      )}

      <div className={rowClass}>
        <div className="hidden md:block" />
        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="px-3 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50"
          >
            {i18nService.t('cancel')}
          </button>
          <button
            type="submit"
            disabled={saving || !canSave}
            className="btn-idchat-primary-filled px-3 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? i18nService.t('saving') : saveButtonLabel}
          </button>
        </div>
      </div>
    </form>
  );
};

export default MetaBotCreateForm;
