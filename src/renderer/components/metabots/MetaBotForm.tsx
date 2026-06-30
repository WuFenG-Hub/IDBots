import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowTopRightOnSquareIcon, PhotoIcon, PlusIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { Skill } from '../../types/skill';
import type { OwnerMetaAppRecord } from '../../types/metaAppOwner';
import {
  addAllowChatSkill,
  normalizeAllowChatSkills,
  removeAllowChatSkill,
} from './allowChatSkills.ts';

const AVATAR_MAX_SIZE_BYTES = 200 * 1024; // 200KB

type HomepageMetaAppLoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

const stripProtocolPrefix = (value: string, scheme: 'metaapp://' | 'metafile://') => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return trimmed.toLowerCase().startsWith(scheme)
    ? trimmed.slice(scheme.length).trim()
    : trimmed;
};

const protocolUriFromInput = (value: string, scheme: 'metaapp://' | 'metafile://') => {
  const ref = stripProtocolPrefix(value, scheme);
  return ref ? `${scheme}${ref}` : '';
};

const ownerMetaAppName = (record: OwnerMetaAppRecord) =>
  (record.appName || record.title || i18nService.t('metabotHomepageUntitledMetaApp')).trim();

export interface MetaBotFormValues {
  name: string;
  avatar: string;
  metabot_type: 'twin' | 'worker';
  role: string;
  soul: string;
  goal: string;
  bio: string;
  boss_global_metaid: string;
  boss_id: string;
  llm_id: string;
  allow_chat_skills: string[];
  homepage_source: 'default' | 'metafile' | 'metaapp';
  homepage_metafile_uri: string;
  homepage_metafile_content_type: string;
  homepage_metaapp_pin: string;
  /** DB homepage JSON at form open (for diff & read-only display in metafile edit mode). */
  homepage_initial: string | null;
  /** Composed final homepage JSON string (or null) set by handleSubmit for the parent. */
  homepage?: string | null;
}

export interface LlmOption {
  id: string;
  label: string;
}

const defaultValues: MetaBotFormValues = {
  name: '',
  avatar: '',
  metabot_type: 'worker',
  role: '',
  soul: '',
  goal: '',
  bio: '',
  boss_global_metaid: '',
  boss_id: '',
  llm_id: '',
  allow_chat_skills: [],
  homepage_source: 'default',
  homepage_metafile_uri: '',
  homepage_metafile_content_type: '',
  homepage_metaapp_pin: '',
  homepage_initial: null,
};

interface MetaBotFormProps {
  initialValues?: Partial<MetaBotFormValues> | null;
  isEdit: boolean;
  onCancel: () => void;
  onSave: (values: MetaBotFormValues) => Promise<void>;
  saveLabel?: string;
  /** Available LLM providers for selection. Multiple MetaBots may share the same LLM. Empty = none available. */
  llmOptions: LlmOption[];
  /** Available local skills for private-chat allowlist selection. */
  skillOptions: Skill[];
  /** Called when user clicks "Go to Model Settings" (e.g. to open Settings tab). */
  onRequestModelSettings?: () => void;
  /** Check if name already exists (for uniqueness). Returns true if duplicate. */
  onCheckNameExists?: (name: string, excludeId?: number) => Promise<boolean>;
  /** Exclude this metabot ID when checking name (for edit mode). */
  excludeIdForNameCheck?: number | null;
  /** Metabot id for homepage file upload (edit mode). Null/undefined in create mode disables metafile upload. */
  metabotId?: number | null;
  /** Open the current Bot's default template homepage in Bot Browser. */
  onOpenDefaultHomepage?: () => void;
  /** Open a MetaApp homepage preview by its pin id (best-effort; browser may fail to resolve). */
  onPreviewMetaAppHomepage?: (pin: string) => Promise<boolean> | boolean;
  /** Open the MetaApps surface so the user can publish a MetaApp for this Bot. */
  onRequestMetaApps?: () => void;
}

const MetaBotForm: React.FC<MetaBotFormProps> = ({
  initialValues,
  isEdit,
  onCancel,
  onSave,
  saveLabel,
  llmOptions,
  skillOptions,
  onRequestModelSettings,
  onCheckNameExists,
  excludeIdForNameCheck,
  metabotId,
  onOpenDefaultHomepage,
  onPreviewMetaAppHomepage,
  onRequestMetaApps,
}) => {
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const homepageFileInputRef = useRef<HTMLInputElement>(null);
  const homepageMetaAppsRequestIdRef = useRef(0);
  const [values, setValues] = useState<MetaBotFormValues>({
    ...defaultValues,
    ...(initialValues || {}),
    allow_chat_skills: normalizeAllowChatSkills(initialValues?.allow_chat_skills ?? defaultValues.allow_chat_skills),
  });
  const [selectedAllowChatSkillId, setSelectedAllowChatSkillId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [nameDuplicate, setNameDuplicate] = useState(false);
  const [homepageUploading, setHomepageUploading] = useState(false);
  const [homepageUploadError, setHomepageUploadError] = useState('');
  const [homepageMetaAppPickerOpen, setHomepageMetaAppPickerOpen] = useState(false);
  const [homepageMetaAppLoadStatus, setHomepageMetaAppLoadStatus] = useState<HomepageMetaAppLoadStatus>('idle');
  const [homepageMetaAppLoadError, setHomepageMetaAppLoadError] = useState('');
  const [homepageMetaAppRecords, setHomepageMetaAppRecords] = useState<OwnerMetaAppRecord[]>([]);

  useEffect(() => {
    if (initialValues) {
      setValues((prev) => ({
        ...defaultValues,
        ...prev,
        ...initialValues,
        allow_chat_skills: normalizeAllowChatSkills(initialValues.allow_chat_skills ?? prev.allow_chat_skills),
      }));
      setSelectedAllowChatSkillId('');
      setHomepageMetaAppPickerOpen(false);
      setHomepageUploadError('');
    }
  }, [initialValues]);

  useEffect(() => {
    homepageMetaAppsRequestIdRef.current += 1;
    setHomepageMetaAppPickerOpen(false);
    setHomepageMetaAppLoadStatus('idle');
    setHomepageMetaAppLoadError('');
    setHomepageMetaAppRecords([]);
  }, [metabotId]);

  const handleChange = <K extends keyof MetaBotFormValues>(field: K, value: MetaBotFormValues[K]) => {
    setValues((prev) => ({ ...prev, [field]: value }));
    setError('');
    if (field === 'name') setNameDuplicate(false);
  };

  const availableSkillOptions = useMemo(
    () => skillOptions.filter((skill) => skill.enabled),
    [skillOptions],
  );
  const skillNameById = useMemo(
    () => new Map(skillOptions.map((skill) => [skill.id, skill.name])),
    [skillOptions],
  );
  const normalizedAllowChatSkills = useMemo(
    () => normalizeAllowChatSkills(values.allow_chat_skills),
    [values.allow_chat_skills],
  );
  const canAddSelectedAllowChatSkill =
    Boolean(selectedAllowChatSkillId) && !normalizedAllowChatSkills.includes(selectedAllowChatSkillId);

  useEffect(() => {
    if (!selectedAllowChatSkillId) return;
    if (!availableSkillOptions.some((skill) => skill.id === selectedAllowChatSkillId)) {
      setSelectedAllowChatSkillId('');
    }
  }, [availableSkillOptions, selectedAllowChatSkillId]);

  const handleAddAllowChatSkill = () => {
    if (!canAddSelectedAllowChatSkill) return;
    handleChange('allow_chat_skills', addAllowChatSkill(values.allow_chat_skills, selectedAllowChatSkillId));
    setSelectedAllowChatSkillId('');
  };

  const handleRemoveAllowChatSkill = (skillId: string) => {
    handleChange('allow_chat_skills', removeAllowChatSkill(values.allow_chat_skills, skillId));
  };

  const handleHomepageSourceChange = (source: MetaBotFormValues['homepage_source']) => {
    handleChange('homepage_source', source);
    setHomepageMetaAppPickerOpen(false);
    setHomepageUploadError('');
  };

  const handleNameBlur = async () => {
    const name = values.name.trim();
    if (!name || !onCheckNameExists) return;
    const exists = await onCheckNameExists(name, excludeIdForNameCheck ?? undefined);
    setNameDuplicate(exists);
  };

  const handleAvatarFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > AVATAR_MAX_SIZE_BYTES) {
      setError(i18nService.t('metabotAvatarSizeError'));
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('metabotAvatarSizeError') }));
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = reader.result as string;
      setValues((prev) => ({ ...prev, avatar: dataUri }));
      setError('');
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleHomepageFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || metabotId == null) return;
    setHomepageUploading(true);
    setHomepageUploadError('');
    try {
      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const result = String(reader.result || '');
          const m = /^data:[^;]+;base64,(.+)$/.exec(result);
          resolve(m ? m[1] : '');
        };
        reader.onerror = () => reject(new Error('read failed'));
        reader.readAsDataURL(file);
      });
      if (!base64) throw new Error('empty');
      const res = await window.electron.idbots.uploadMetabotHomepageFile({
        metabotId,
        fileName: file.name,
        contentType: file.type || undefined,
        base64,
      });
      if (!res.success || !res.metafileUri) {
        throw new Error(res.error || i18nService.t('metabotSaveFailed'));
      }
      handleChange('homepage_metafile_uri', res.metafileUri);
      handleChange('homepage_metafile_content_type', res.contentType || file.type || '');
      handleChange('homepage_source', 'metafile');
    } catch (err) {
      setHomepageUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setHomepageUploading(false);
      e.target.value = '';
    }
  };

  /** Compose the final homepage JSON string (or null) from current form selection. Throws on invalid. */
  const composeHomepageForSave = (): string | null => {
    if (!isEdit) return null;
    if (values.homepage_source === 'default') return null;
    if (values.homepage_source === 'metafile') {
      const pin = stripProtocolPrefix(values.homepage_metafile_uri, 'metafile://');
      if (!pin) throw new Error(i18nService.t('metabotHomepageErrNoFile'));
      if (/\s/u.test(pin) || /:\/\//.test(pin)) {
        throw new Error(i18nService.t('metabotHomepageErrInvalidMetafilePin'));
      }
      const contentType = values.homepage_metafile_content_type.trim() || 'application/octet-stream';
      return JSON.stringify({ uri: `metafile://${pin}`, renderer: 'auto', contentType });
    }
    // metaapp
    const stripped = stripProtocolPrefix(values.homepage_metaapp_pin, 'metaapp://');
    if (!stripped || /\s/u.test(stripped) || /:\/\//.test(stripped)) {
      throw new Error(i18nService.t('metabotHomepageErrInvalidPin'));
    }
    return JSON.stringify({ uri: `metaapp://${stripped}`, renderer: 'metaapp', contentType: 'application/vnd.metaapp' });
  };

  const loadHomepageMetaApps = useCallback(async () => {
    if (metabotId == null) {
      setHomepageMetaAppLoadStatus('loaded');
      setHomepageMetaAppRecords([]);
      return;
    }
    const requestId = ++homepageMetaAppsRequestIdRef.current;
    setHomepageMetaAppLoadStatus('loading');
    setHomepageMetaAppLoadError('');
    try {
      const result = await window.electron.metaappOwner.list({ metabotId, size: 24 });
      if (requestId !== homepageMetaAppsRequestIdRef.current) return;
      if (!result.success) {
        throw new Error(result.error || i18nService.t('metabotHomepageMetaAppsLoadFailed'));
      }
      setHomepageMetaAppRecords((result.records || []).filter((record) => Boolean(record.pinId)));
      setHomepageMetaAppLoadStatus('loaded');
    } catch (err) {
      if (requestId !== homepageMetaAppsRequestIdRef.current) return;
      setHomepageMetaAppRecords([]);
      setHomepageMetaAppLoadStatus('error');
      setHomepageMetaAppLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [metabotId]);

  const openHomepageMetaAppPicker = () => {
    setHomepageMetaAppPickerOpen(true);
    void loadHomepageMetaApps();
  };

  const handleChooseHomepageMetaApp = (record: OwnerMetaAppRecord) => {
    handleChange('homepage_metaapp_pin', record.pinId);
    setHomepageMetaAppPickerOpen(false);
    setHomepageMetaAppLoadError('');
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
      const exists = await onCheckNameExists(values.name.trim(), excludeIdForNameCheck ?? undefined);
      if (exists) {
        setError(i18nService.t('metabotNameDuplicate'));
        setNameDuplicate(true);
        return;
      }
    }
    if (!values.role.trim()) {
      setError(i18nService.t('metabotRoleRequired'));
      return;
    }
    if (!values.soul.trim()) {
      setError(i18nService.t('metabotSoulRequired'));
      return;
    }
    if (!isEdit && !values.llm_id.trim()) {
      setError(i18nService.t('metabotLlmRequired'));
      return;
    }
    let homepageForSave: string | null = null;
    try {
      homepageForSave = composeHomepageForSave();
    } catch (e) {
      setError(e instanceof Error ? e.message : i18nService.t('metabotSaveFailed'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave({
        ...values,
        allow_chat_skills: normalizeAllowChatSkills(values.allow_chat_skills),
        homepage: homepageForSave,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : i18nService.t('metabotSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const saveButtonLabel = saveLabel ?? (isEdit ? i18nService.t('save') : i18nService.t('metabotCreate'));
  const hasNoAvailableLlm = llmOptions.length === 0;
  const canSave = isEdit || !hasNoAvailableLlm;
  const rowClass = 'grid grid-cols-1 md:grid-cols-[132px_minmax(0,1fr)] gap-2 md:gap-4 items-start';
  const labelClass = 'pt-2 text-sm font-medium dark:text-claude-darkText text-claude-text';
  const hintClass = 'text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1';
  const inputChromeClass = 'px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent';
  const inputClass = `w-full ${inputChromeClass}`;
  const homepageInlineButtonClass = 'inline-flex h-[38px] shrink-0 items-center justify-center gap-1.5 px-3 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap';
  const homepageProtocolInputClass = 'flex h-[38px] min-w-0 flex-1 items-center overflow-hidden rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg focus-within:ring-2 focus-within:ring-claude-accent';
  const homepageProtocolPrefixClass = 'flex h-full shrink-0 items-center border-r dark:border-claude-darkBorder border-claude-border px-2 text-xs font-mono dark:text-claude-darkTextSecondary text-claude-textSecondary';
  const homepageProtocolFieldClass = 'h-full min-w-0 flex-1 bg-transparent px-2 text-sm font-mono dark:text-claude-darkText text-claude-text focus:outline-none';
  const homepageMetafilePin = stripProtocolPrefix(values.homepage_metafile_uri, 'metafile://');
  const homepageMetaAppPin = stripProtocolPrefix(values.homepage_metaapp_pin, 'metaapp://');

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
        <label className={labelClass}>
          {i18nService.t('metabotAvatar')}
        </label>
        <div className="min-w-0 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="w-16 h-16 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border overflow-hidden flex-shrink-0 flex items-center justify-center">
            {values.avatar && (values.avatar.startsWith('data:') || values.avatar.startsWith('http')) ? (
              <img src={values.avatar} alt="" className="w-full h-full object-cover" />
            ) : (
              <PhotoIcon className="h-8 w-8 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
              className="hidden"
              onChange={handleAvatarFileChange}
            />
            <button
              type="button"
              onClick={() => avatarInputRef.current?.click()}
              className="px-3 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
            >
              {i18nService.t('metabotAvatarUpload')}
            </button>
            <p className={hintClass}>
              {i18nService.t('metabotAvatarPlaceholder')}
            </p>
            {values.avatar && (
              <button
                type="button"
                onClick={() => handleChange('avatar', '')}
                className="mt-1 text-xs text-red-500 dark:text-red-400 hover:underline"
              >
                {i18nService.t('metabotAvatarClear')}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Hidden: Type, Parent MetaBot ID, Tools, Skills - default values injected silently */}

      <div className={rowClass}>
        <label htmlFor="metabot-role" className={labelClass}>
          {i18nService.t('metabotRole')}
        </label>
        <div className="min-w-0">
          <input
            id="metabot-role"
            type="text"
            value={values.role}
            onChange={(e) => handleChange('role', e.target.value)}
            placeholder={i18nService.t('metabotRolePlaceholder')}
            className={inputClass}
          />
        </div>
      </div>

      <div className={rowClass}>
        <label htmlFor="metabot-soul" className={labelClass}>
          {i18nService.t('metabotSoul')}
        </label>
        <div className="min-w-0">
          <textarea
            id="metabot-soul"
            value={values.soul}
            onChange={(e) => handleChange('soul', e.target.value)}
            placeholder={i18nService.t('metabotSoulPlaceholder')}
            rows={4}
            className={`${inputClass} resize-y`}
          />
        </div>
      </div>

      <div className={rowClass}>
        <label htmlFor="metabot-goal" className={labelClass}>
          {i18nService.t('metabotGoal')}
        </label>
        <div className="min-w-0">
          <textarea
            id="metabot-goal"
            value={values.goal}
            onChange={(e) => handleChange('goal', e.target.value)}
            placeholder={i18nService.t('metabotGoalPlaceholder')}
            rows={2}
            className={`${inputClass} resize-y`}
          />
        </div>
      </div>

      <div className={rowClass}>
        <label htmlFor="metabot-bio" className={labelClass}>
          {i18nService.t('metabotBio')}
        </label>
        <div className="min-w-0">
          <textarea
            id="metabot-bio"
            value={values.bio}
            onChange={(e) => handleChange('bio', e.target.value)}
            placeholder={i18nService.t('metabotBioPlaceholder')}
            rows={2}
            className={`${inputClass} resize-y`}
          />
        </div>
      </div>

      <div className={rowClass}>
        <label htmlFor="metabot-boss-metaid" className={labelClass}>
          {i18nService.t('metabotBossMetaId')}
          <span className="ml-1 font-normal opacity-60">{i18nService.t('metabotBossMetaIdOptional')}</span>
        </label>
        <div className="min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <input
              id="metabot-boss-metaid"
              type="text"
              value={values.boss_global_metaid}
              onChange={(e) => handleChange('boss_global_metaid', e.target.value)}
              placeholder={i18nService.t('metabotBossMetaIdPlaceholder')}
              className={`${inputClass} flex-1 min-w-0 font-mono`}
            />
            <button
              type="button"
              onClick={() => {/* TODO: fetch my MetaID */}}
              className="shrink-0 px-3 py-2 text-xs rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors whitespace-nowrap"
            >
              {i18nService.t('metabotGetMyMetaId')}
            </button>
          </div>
          <p className={`${hintClass} opacity-70`}>
            {i18nService.t('metabotBossMetaIdHint')}
          </p>
        </div>
      </div>

      <div className={rowClass}>
        <label htmlFor="metabot-llm" className={labelClass}>
          {i18nService.t('metabotLlmProvider')}
          {!isEdit && <span className="ml-1 text-red-500">*</span>}
        </label>
        <div className="min-w-0">
          {hasNoAvailableLlm ? (
            <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border px-3 py-3 dark:bg-claude-darkSurface/50 bg-claude-surface/50">
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
              {!isEdit && (
                <p className={hintClass}>
                  {i18nService.t('metabotLlmRequired')}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      <div className={rowClass}>
        <label htmlFor="metabot-allow-chat-skills" className={labelClass}>
          {i18nService.t('metabotAllowChatSkills')}
        </label>
        <div className="min-w-0 space-y-2">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <select
              id="metabot-allow-chat-skills"
              value={selectedAllowChatSkillId}
              onChange={(e) => setSelectedAllowChatSkillId(e.target.value)}
              className={inputClass}
              disabled={availableSkillOptions.length === 0}
            >
              <option value="">{i18nService.t('metabotAllowChatSkillsPlaceholder')}</option>
              {availableSkillOptions.map((skill) => (
                <option key={skill.id} value={skill.id}>
                  {skill.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleAddAllowChatSkill}
              disabled={!canAddSelectedAllowChatSkill}
              className="shrink-0 px-3 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              <PlusIcon className="h-4 w-4" />
              <span>{i18nService.t('metabotAdd')}</span>
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {normalizedAllowChatSkills.length > 0 ? (
              normalizedAllowChatSkills.map((skillId) => (
                <span
                  key={skillId}
                  className="inline-flex max-w-full items-center gap-1 rounded-full border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface px-2 py-1 text-xs dark:text-claude-darkText text-claude-text"
                >
                  <span className="max-w-[10rem] truncate" title={skillId}>
                    {skillNameById.get(skillId) || skillId}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleRemoveAllowChatSkill(skillId)}
                    className="inline-flex h-4 w-4 items-center justify-center rounded-full text-claude-textSecondary dark:text-claude-darkTextSecondary hover:bg-black/10 dark:hover:bg-white/10"
                    aria-label={i18nService.t('metabotDelete')}
                    title={i18nService.t('metabotDelete')}
                  >
                    <XMarkIcon className="h-3 w-3" />
                  </button>
                </span>
              ))
            ) : (
              <p className={hintClass}>
                {i18nService.t('metabotAllowChatSkillsDefault')}
              </p>
            )}
          </div>
          <p className={hintClass}>
            {i18nService.t('metabotAllowChatSkillsHint')}
          </p>
          {availableSkillOptions.length === 0 && (
            <p className={`${hintClass} text-amber-500 dark:text-amber-400`}>
              {i18nService.t('metabotNoAvailableSkills')}
            </p>
          )}
        </div>
      </div>

      {isEdit && (
        <div className={rowClass}>
          <label htmlFor="metabot-homepage" className={labelClass}>
            {i18nService.t('metabotHomepage')}
          </label>
          <div className="min-w-0 space-y-1.5">
            <div
              data-slot="metabot-homepage-control-row"
              className="flex min-w-0 items-center gap-2"
            >
              <select
                id="metabot-homepage"
                value={values.homepage_source}
                onChange={(e) => handleHomepageSourceChange(e.target.value as MetaBotFormValues['homepage_source'])}
                className={`${inputChromeClass} h-[38px] w-[9.5rem] shrink-0`}
              >
                <option value="default">{i18nService.t('metabotHomepageDefault')}</option>
                <option value="metafile">{i18nService.t('metabotHomepageMetafile')}</option>
                <option value="metaapp">{i18nService.t('metabotHomepageMetaapp')}</option>
              </select>

              {values.homepage_source === 'default' && (
                <div className="min-w-0 flex-1">
                  {onOpenDefaultHomepage ? (
                    <button
                      type="button"
                      data-slot="metabot-homepage-view"
                      onClick={onOpenDefaultHomepage}
                      className={homepageInlineButtonClass}
                      title={i18nService.t('metabotHomepageView')}
                    >
                      <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                      <span>{i18nService.t('metabotHomepageView')}</span>
                    </button>
                  ) : (
                    <p className={`${hintClass} mt-0 truncate`}>
                      {i18nService.t('metabotHomepageDefaultDesc')}
                    </p>
                  )}
                </div>
              )}

              {values.homepage_source === 'metafile' && (
                <div className="min-w-0 flex-1 flex items-center gap-2">
                  <input
                    ref={homepageFileInputRef}
                    type="file"
                    className="hidden"
                    onChange={handleHomepageFileChange}
                  />
                  <label className={homepageProtocolInputClass}>
                    <span className={homepageProtocolPrefixClass}>metafile://</span>
                    <input
                      type="text"
                      data-slot="metabot-homepage-metafile-pin"
                      value={homepageMetafilePin}
                      onChange={(e) => handleChange('homepage_metafile_uri', protocolUriFromInput(e.target.value, 'metafile://'))}
                      placeholder={i18nService.t('metabotHomepageMetafilePinPlaceholder')}
                      className={homepageProtocolFieldClass}
                    />
                  </label>
                  <button
                    type="button"
                    data-slot="metabot-homepage-metafile-upload"
                    onClick={() => homepageFileInputRef.current?.click()}
                    disabled={homepageUploading || metabotId == null}
                    className={homepageInlineButtonClass}
                    title={metabotId == null ? i18nService.t('metabotHomepageMetafileDisabledHint') : undefined}
                  >
                    {homepageUploading ? i18nService.t('metabotHomepageUploading') : i18nService.t('metabotHomepageMetafileUpload')}
                  </button>
                  {homepageUploadError && (
                    <p className="min-w-0 truncate text-xs text-red-500">{homepageUploadError}</p>
                  )}
                </div>
              )}

              {values.homepage_source === 'metaapp' && (
                <div className="min-w-0 flex-1 flex items-center gap-2">
                  <label className={homepageProtocolInputClass}>
                    <span className={homepageProtocolPrefixClass}>metaapp://</span>
                    <input
                      type="text"
                      data-slot="metabot-homepage-metaapp-pin"
                      value={homepageMetaAppPin}
                      onChange={(e) => handleChange('homepage_metaapp_pin', stripProtocolPrefix(e.target.value, 'metaapp://'))}
                      placeholder={i18nService.t('metabotHomepageMetaappPinPlaceholder')}
                      className={homepageProtocolFieldClass}
                    />
                  </label>
                  <div className="relative shrink-0">
                    <button
                      type="button"
                      data-slot="metabot-homepage-metaapp-select"
                      onClick={openHomepageMetaAppPicker}
                      disabled={metabotId == null}
                      aria-haspopup="dialog"
                      aria-expanded={homepageMetaAppPickerOpen}
                      className={homepageInlineButtonClass}
                    >
                      {i18nService.t('metabotHomepageMetaappSelect')}
                    </button>
                    {homepageMetaAppPickerOpen && (
                      <div
                        data-slot="metabot-homepage-metaapp-picker"
                        role="dialog"
                        aria-label={i18nService.t('metabotHomepageMetaappSelect')}
                        className="absolute right-0 top-full z-30 mt-2 w-[min(24rem,calc(100vw-3rem))] overflow-hidden rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-white shadow-xl"
                      >
                        {homepageMetaAppLoadStatus === 'loading' && (
                          <div className="px-3 py-3 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                            {i18nService.t('metabotHomepageLoadingMetaApps')}
                          </div>
                        )}
                        {homepageMetaAppLoadStatus === 'error' && (
                          <div className="space-y-2 px-3 py-3 text-sm">
                            <p className="font-medium text-red-500 dark:text-red-400">
                              {i18nService.t('metabotHomepageMetaAppsLoadFailed')}
                            </p>
                            <p className="break-words text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                              {homepageMetaAppLoadError}
                            </p>
                            <button
                              type="button"
                              onClick={() => void loadHomepageMetaApps()}
                              className={homepageInlineButtonClass}
                            >
                              {i18nService.t('retry')}
                            </button>
                          </div>
                        )}
                        {homepageMetaAppLoadStatus === 'loaded' && homepageMetaAppRecords.length === 0 && (
                          <div className="space-y-2 px-3 py-3 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                            <p className="font-medium dark:text-claude-darkText text-claude-text">
                              {i18nService.t('metabotHomepageNoMetaAppsTitle')}
                            </p>
                            <p>{i18nService.t('metabotHomepageNoMetaAppsMessage')}</p>
                            {onRequestMetaApps && (
                              <button
                                type="button"
                                onClick={onRequestMetaApps}
                                className="btn-idchat-primary-filled px-3 py-2 text-sm"
                              >
                                {i18nService.t('metabotHomepageCreateMetaApp')}
                              </button>
                            )}
                          </div>
                        )}
                        {homepageMetaAppLoadStatus === 'loaded' && homepageMetaAppRecords.length > 0 && (
                          <div className="max-h-72 overflow-y-auto py-1">
                            {homepageMetaAppRecords.map((record) => (
                              <button
                                key={record.pinId}
                                type="button"
                                onClick={() => handleChooseHomepageMetaApp(record)}
                                className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                              >
                                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg dark:bg-claude-darkBg bg-claude-surface text-xs font-semibold dark:text-claude-darkText text-claude-text">
                                  {ownerMetaAppName(record).slice(0, 2).toUpperCase()}
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-sm font-medium dark:text-claude-darkText text-claude-text">
                                    {ownerMetaAppName(record)}
                                  </span>
                                  <code className="block truncate text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                                    {record.pinId}
                                  </code>
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  {onPreviewMetaAppHomepage && (
                    <button
                      type="button"
                      data-slot="metabot-homepage-metaapp-preview"
                      onClick={() => {
                        const pin = stripProtocolPrefix(values.homepage_metaapp_pin, 'metaapp://');
                        if (pin) void onPreviewMetaAppHomepage(pin);
                      }}
                      disabled={!homepageMetaAppPin}
                      className={homepageInlineButtonClass}
                    >
                      {i18nService.t('metabotHomepageMetaappPreview')}
                    </button>
                  )}
                </div>
              )}
            </div>

            <p data-slot="metabot-homepage-hint" className={hintClass}>{i18nService.t('metabotHomepageHint')}</p>
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

export default MetaBotForm;
