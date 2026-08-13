import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useDispatch } from 'react-redux';
import { ArrowLeftIcon, MagnifyingGlassIcon, PlusCircleIcon, ArrowPathIcon } from '@heroicons/react/24/outline';
import { setPreferredMetabotId } from '../../store/slices/coworkSlice';
import { i18nService } from '../../services/i18n';
import { configService } from '../../services/config';
import { ALL_PROVIDER_KEYS } from '../../config';
import type { Metabot } from '../../types/metabot';
import type { Skill } from '../../types/skill';
import MetaBotEditTabs, {
  EDIT_TAB_FIELDS,
  normalizeA2AAutoReplyEnabledOption,
  normalizeA2AByeCooldownMsOption,
  normalizeA2AMaxIncomingTurnsOption,
  type LlmOption,
  type MetaBotEditTabKey,
  type MetaBotEditValues,
} from './MetaBotEditTabs';
import MetaBotCreateForm, { type MetaBotCreateFormValues } from './MetaBotCreateForm';
import MetaBotCreateSuccessModal, { type SyncStepKey } from './MetaBotCreateSuccessModal';
import MetaBotDeleteConfirmModal from './MetaBotDeleteConfirmModal';
import MetaBotRestoreMnemonicModal from './MetaBotRestoreMnemonicModal';
import MetaBotListCard from './MetaBotListCard';
import { normalizeAllowChatSkills } from './allowChatSkills.ts';
import { shouldRouteFirstMetabotCreationToOnboarding } from '../onboarding/onboardingGate.js';
import { DEFAULT_METABOT_LIMIT, METABOT_LIMIT_REACHED_ERROR } from '../../../main/shared/metabotLimit';

type ViewMode = 'list' | 'add' | 'edit';

/**
 * The on-chain edit-sync plan is now computed in the MAIN process
 * (metabotManageService.buildEditSyncFlags / updateMetaBotCore) — the same
 * single source the Twin metabot_update tool uses. The renderer only mirrors
 * the "still unsynced" steps so its manual Retry button can republish the
 * remainder via idbots:syncMetaBotEditChanges.
 */
interface EditSyncRemaining {
  metabotId: number;
  syncName: boolean;
  syncAvatar: boolean;
  syncBio: boolean;
  syncPersona: boolean;
  syncLlm: boolean;
  syncChatSkills: boolean;
  syncHomepage: boolean;
  syncOwner: boolean;
}

const EDIT_SYNC_STEP_FLAG_PAIRS: ReadonlyArray<
  readonly [string, keyof Omit<EditSyncRemaining, 'metabotId'>]
> = [
  ['name', 'syncName'],
  ['avatar', 'syncAvatar'],
  ['bio', 'syncBio'],
  ['persona', 'syncPersona'],
  ['llm', 'syncLlm'],
  ['chatSkills', 'syncChatSkills'],
  ['homepage', 'syncHomepage'],
  ['owner', 'syncOwner'],
];

/** Normalize main's remainingSyncInput (may leave flags undefined) to booleans. */
const toEditSyncRemaining = (input: unknown): EditSyncRemaining => {
  const src = (input ?? {}) as Record<string, unknown>;
  const next = { metabotId: Number(src.metabotId) || 0 } as EditSyncRemaining;
  for (const [, flag] of EDIT_SYNC_STEP_FLAG_PAIRS) {
    next[flag] = src[flag] === true;
  }
  return next;
};

/** Zero out every step already confirmed, so a retry only republishes the rest. */
const subtractEditSyncRemaining = (
  remaining: EditSyncRemaining,
  syncedSteps: readonly string[],
): EditSyncRemaining => {
  const synced = new Set(syncedSteps);
  const next = { ...remaining };
  for (const [step, flag] of EDIT_SYNC_STEP_FLAG_PAIRS) {
    if (synced.has(step)) next[flag] = false;
  }
  return next;
};

const hasEditSyncRemaining = (remaining: EditSyncRemaining): boolean =>
  EDIT_SYNC_STEP_FLAG_PAIRS.some(([, flag]) => remaining[flag] === true);

const syncStepKeyToFlag = (step: string): keyof Omit<EditSyncRemaining, 'metabotId'> | undefined =>
  EDIT_SYNC_STEP_FLAG_PAIRS.find(([k]) => k === step)?.[1];

const providerRequiresApiKey = (provider: string) => provider !== 'ollama';
const providerLabel = (key: string) => key.charAt(0).toUpperCase() + key.slice(1);
const sortMetabotsByCreatedAtAsc = (metabots: Metabot[]) =>
  [...metabots].sort((a, b) => a.created_at - b.created_at || a.id - b.id);
const parseOptionalBossId = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/** Map a Metabot row to edit-form values; shared by the edit view and the per-tab save scoping. */
const buildEditFormValues = (editMetabot: Metabot): MetaBotEditValues => ({
  name: editMetabot.name,
  avatar: editMetabot.avatar || '',
  metabot_type: editMetabot.metabot_type,
  role: editMetabot.role,
  soul: editMetabot.soul,
  goal: editMetabot.goal || '',
  bio: editMetabot.bio || editMetabot.background || '',
  boss_id: editMetabot.boss_id != null ? String(editMetabot.boss_id) : '',
  boss_global_metaid: editMetabot.boss_global_metaid || '',
  llm_id: editMetabot.llm_id || '',
  fallback_llm_id: editMetabot.fallback_llm_id || '',
  allow_chat_skills: editMetabot.allow_chat_skills || [],
  a2a_max_incoming_turns: normalizeA2AMaxIncomingTurnsOption(editMetabot.a2a_max_incoming_turns),
  a2a_bye_cooldown_ms: normalizeA2AByeCooldownMsOption(editMetabot.a2a_bye_cooldown_ms),
  a2a_auto_reply_enabled: normalizeA2AAutoReplyEnabledOption(editMetabot.a2a_auto_reply_enabled),
  homepage: editMetabot.homepage ?? null,
  homepage_initial: editMetabot.homepage ?? null,
  homepage_source: ((): MetaBotEditValues['homepage_source'] => {
    const hp = editMetabot.homepage;
    if (!hp) return 'default';
    try {
      const obj = JSON.parse(hp);
      if (obj?.uri?.startsWith('metaapp://')) return 'metaapp';
      if (obj?.uri?.startsWith('metafile://')) return 'metafile';
    } catch { /* ignore */ }
    return 'default';
  })(),
  homepage_metafile_uri: (() => {
    try {
      const obj = editMetabot.homepage ? JSON.parse(editMetabot.homepage) : null;
      return obj?.uri?.startsWith('metafile://') ? obj.uri : '';
    } catch { return ''; }
  })(),
  homepage_metafile_content_type: (() => {
    try {
      const obj = editMetabot.homepage ? JSON.parse(editMetabot.homepage) : null;
      return obj?.contentType ?? '';
    } catch { return ''; }
  })(),
  homepage_metaapp_pin: (() => {
    try {
      const obj = editMetabot.homepage ? JSON.parse(editMetabot.homepage) : null;
      return obj?.uri?.startsWith('metaapp://') ? String(obj.uri).slice('metaapp://'.length) : '';
    } catch { return ''; }
  })(),
});
const formatMetabotLimitReached = () =>
  i18nService.t('metabotLimitReached').replace('{limit}', String(DEFAULT_METABOT_LIMIT));
const resolveMetabotActionError = (error?: string): string => {
  if (error === METABOT_LIMIT_REACHED_ERROR) return formatMetabotLimitReached();
  if (error === 'OWNER_IDENTITY_MISSING') return i18nService.t('metabotErrorOwnerIdentityMissing');
  if (error === 'OWNER_IDENTITY_MISMATCH') return i18nService.t('metabotErrorOwnerMismatch');
  return error || i18nService.t('metabotSaveFailed');
};

interface MetabotsManagerProps {
  onRequestModelSettings?: () => void;
  onRequestOnboarding?: () => void;
  onOpenMetabotInBrowser?: (metabot: Metabot) => void;
  onPreviewMetaAppHomepage?: (pin: string) => Promise<boolean> | boolean;
  onRequestMetaApps?: () => void;
}

const MetabotsManager: React.FC<MetabotsManagerProps> = ({
  onRequestModelSettings,
  onRequestOnboarding,
  onOpenMetabotInBrowser,
  onPreviewMetaAppHomepage,
  onRequestMetaApps,
}) => {
  const dispatch = useDispatch();
  const [list, setList] = useState<Metabot[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [editId, setEditId] = useState<number | null>(null);
  const [actionError, setActionError] = useState('');
  const [skillOptions, setSkillOptions] = useState<Skill[]>([]);
  const [createSuccessModal, setCreateSuccessModal] = useState<{
    metabot: Metabot;
    subsidySuccess: boolean;
    subsidyError?: string;
    mode?: 'create' | 'syncOnly' | 'editSync';
    syncStepKeys?: SyncStepKey[];
    showSubsidyStatus?: boolean;
  } | null>(null);
  const [editSyncRemaining, setEditSyncRemaining] = useState<EditSyncRemaining | null>(null);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'success' | 'error'>('idle');
  const [syncError, setSyncError] = useState<string>('');
  const [deleteTarget, setDeleteTarget] = useState<Metabot | null>(null);
  const [showRestoreModal, setShowRestoreModal] = useState(false);
  const [showLimitModal, setShowLimitModal] = useState(false);
  // Chain-first creation state
  const [pendingCreateValues, setPendingCreateValues] = useState<MetaBotCreateFormValues | null>(null);
  const [createChainStatus, setCreateChainStatus] = useState<'idle' | 'publishing' | 'error'>('idle');
  const [createChainError, setCreateChainError] = useState<string>('');

  const loadList = useCallback(async () => {
    setLoading(true);
    const result = await window.electron.metabot.list();
    setLoading(false);
    if (result.success && result.list) {
      setList(sortMetabotsByCreatedAtAsc(result.list));
    } else {
      setActionError(result.error || i18nService.t('metabotLoadFailed'));
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  // Live dream-consolidation status: patch the card's moon indicator as bots
  // enter/leave their nightly dream run (initial state comes with metabot:list).
  useEffect(() => {
    const off = window.electron.dream?.onStatusChanged(({ metabotId, dreaming }) => {
      setList((prev) => prev.map((m) => (m.id === metabotId ? { ...m, dreaming } : m)));
    });
    return () => {
      off?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadSkillOptions = async () => {
      const result = await window.electron.skills.list();
      if (cancelled) return;
      setSkillOptions(result.success && result.skills ? result.skills : []);
    };
    void loadSkillOptions();
    const off = window.electron.skills.onChanged(() => {
      void loadSkillOptions();
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  const filteredList = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return list;
    return list.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.role.toLowerCase().includes(q) ||
        m.metabot_type.toLowerCase().includes(q)
    );
  }, [list, searchQuery]);

  const handleToggleEnabled = async (id: number, enabled: boolean) => {
    setActionError('');
    const result = await window.electron.metabot.setEnabled(id, enabled);
    if (result.success && result.metabot) {
      setList((prev) => prev.map((m) => (m.id === id ? { ...m, enabled: result.metabot!.enabled } : m)));
    } else {
      setActionError(result.error || i18nService.t('metabotUpdateFailed'));
    }
  };

  const handleAdd = () => {
    if (list.length >= DEFAULT_METABOT_LIMIT) {
      setShowLimitModal(true);
      return;
    }
    if (shouldRouteFirstMetabotCreationToOnboarding(list.length)) {
      setActionError('');
      onRequestOnboarding?.();
      return;
    }
    setActionError('');
    setEditId(null);
    setViewMode('add');
  };

  const handleEdit = (id: number) => {
    setActionError('');
    setEditId(id);
    setViewMode('edit');
  };

  const handleCancelForm = () => {
    setViewMode('list');
    setEditId(null);
    setActionError('');
    setCreateChainStatus('idle');
    setCreateChainError('');
    setPendingCreateValues(null);
  };

  const handleSaveNew = async (values: MetaBotCreateFormValues) => {
    setPendingCreateValues(values);
    setCreateChainStatus('publishing');
    setCreateChainError('');
    // Minimal creation: only name + primary/fallback LLM go on-chain now;
    // the remaining profile fields are filled in later via the edit view.
    const result = await window.electron.idbots.createMetaBotOnChain({
      name: values.name.trim(),
      llm_id: values.llm_id.trim() || null,
      fallback_llm_id: values.fallback_llm_id.trim() || null,
    });
    if (!result.success || !result.metabot) {
      setCreateChainStatus('error');
      setCreateChainError(resolveMetabotActionError(result.error));
      return;
    }
    // Success — clear publishing state, add to list, show success modal
    setCreateChainStatus('idle');
    setPendingCreateValues(null);
    setList((prev) => sortMetabotsByCreatedAtAsc([...prev, result.metabot!]));
    setCreateSuccessModal({
      metabot: result.metabot,
      subsidySuccess: result.subsidy?.success ?? false,
      subsidyError: result.subsidy?.error,
      mode: 'create',
      // Only the steps a minimal creation actually publishes (empty profile
      // steps are skipped by the full sync plan).
      syncStepKeys: ['name', 'chatpubkey', 'llm'],
      showSubsidyStatus: true,
    });
    setSyncStatus('success');
    setViewMode('list');
  };

  const handleCheckNameExists = useCallback(async (name: string, excludeId?: number): Promise<boolean> => {
    const result = await window.electron.metabot.checkNameExists({ name: name.trim(), excludeId });
    return result.success && result.exists === true;
  }, []);

  /**
   * Per-tab edit save. Only the saved tab's fields are taken from `values`;
   * everything else is pinned to the current DB state so the diff below (and
   * the chain sync plan) covers exactly the sync groups that tab owns.
   */
  const saveEditFields = async (tab: MetaBotEditTabKey, values: MetaBotEditValues) => {
    if (editId == null) return;
    const current = list.find((m) => m.id === editId);
    if (!current) throw new Error(i18nService.t('metabotLoadFailed'));

    const scopedValues: MetaBotEditValues = { ...buildEditFormValues(current) };
    for (const field of EDIT_TAB_FIELDS[tab]) {
      (scopedValues as unknown as Record<string, unknown>)[field] = values[field];
    }
    if (tab === 'advanced') {
      scopedValues.homepage = values.homepage ?? null;
    }

    const nextName = scopedValues.name.trim();
    const nextAvatarRaw = scopedValues.avatar.trim();
    const nextRole = scopedValues.role.trim();
    const nextSoul = scopedValues.soul.trim();
    const nextGoalRaw = scopedValues.goal.trim();
    const nextBioRaw = scopedValues.bio.trim();
    const nextBossId = parseOptionalBossId(scopedValues.boss_id);
    const nextBossGlobalMetaId = scopedValues.boss_global_metaid.trim() || null;
    const nextLlmRaw = scopedValues.llm_id.trim();
    // fallback_llm_id is a first-class Basic-tab field; only send it when the
    // Basic tab owns it (other tabs keep it pinned to the current DB value).
    const valuesFallbackLlm = scopedValues.fallback_llm_id;
    const hasFallbackLlmValue = valuesFallbackLlm !== undefined;
    const nextFallbackLlmRaw = hasFallbackLlmValue ? (valuesFallbackLlm ?? '').trim() : '';
    const nextAllowChatSkills = normalizeAllowChatSkills(scopedValues.allow_chat_skills);
    const nextA2aMaxIncomingTurns = normalizeA2AMaxIncomingTurnsOption(scopedValues.a2a_max_incoming_turns);
    const nextA2aByeCooldownMs = normalizeA2AByeCooldownMsOption(scopedValues.a2a_bye_cooldown_ms);
    const nextA2aAutoReplyEnabled = normalizeA2AAutoReplyEnabledOption(scopedValues.a2a_auto_reply_enabled);
    const nextHomepage = scopedValues.homepage ?? null;

    // metabot_type is a local-only change (never published on-chain); a Twin
    // transfer alone still counts as a save-worthy edit.
    const metabotTypeChanged = scopedValues.metabot_type !== current.metabot_type;

    // No-op guard: nothing at all changed for this tab. The on-chain sync
    // plan itself is now computed in the main process (updateMetaBotCore).
    const nothingChanged =
      nextName === (current.name || '').trim() &&
      nextAvatarRaw === (current.avatar || '').trim() &&
      nextRole === (current.role || '').trim() &&
      nextSoul === (current.soul || '').trim() &&
      nextGoalRaw === (current.goal || '').trim() &&
      nextBioRaw === (current.bio || current.background || '').trim() &&
      nextBossGlobalMetaId === ((current.boss_global_metaid ?? '').trim() || null) &&
      nextLlmRaw === (current.llm_id || '').trim() &&
      (!hasFallbackLlmValue || nextFallbackLlmRaw === (current.fallback_llm_id || '').trim()) &&
      JSON.stringify(nextAllowChatSkills) === JSON.stringify(normalizeAllowChatSkills(current.allow_chat_skills)) &&
      nextA2aMaxIncomingTurns === normalizeA2AMaxIncomingTurnsOption(current.a2a_max_incoming_turns) &&
      nextA2aByeCooldownMs === normalizeA2AByeCooldownMsOption(current.a2a_bye_cooldown_ms) &&
      nextA2aAutoReplyEnabled === normalizeA2AAutoReplyEnabledOption(current.a2a_auto_reply_enabled) &&
      nextHomepage === (current.homepage ?? null) &&
      !metabotTypeChanged;
    if (nothingChanged) {
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('metabotNoChanges') }));
      return;
    }

    const result = await window.electron.metabot.update(editId, {
      name: nextName,
      avatar: nextAvatarRaw || null,
      metabot_type: scopedValues.metabot_type,
      role: nextRole,
      soul: nextSoul,
      goal: nextGoalRaw || null,
      bio: nextBioRaw || null,
      boss_id: nextBossId,
      boss_global_metaid: nextBossGlobalMetaId,
      llm_id: nextLlmRaw || null,
      ...(hasFallbackLlmValue ? { fallback_llm_id: nextFallbackLlmRaw || null } : {}),
      allow_chat_skills: nextAllowChatSkills,
      a2a_max_incoming_turns: nextA2aMaxIncomingTurns,
      a2a_bye_cooldown_ms: nextA2aByeCooldownMs,
      a2a_auto_reply_enabled: nextA2aAutoReplyEnabled,
      homepage: nextHomepage,
    });
    if (!result.success) {
      throw new Error(resolveMetabotActionError(result.error));
    }
    const updatedMetabot = result.metabot ?? {
      ...current,
      name: nextName,
      avatar: nextAvatarRaw || null,
      metabot_type: scopedValues.metabot_type,
      role: nextRole,
      soul: nextSoul,
      goal: nextGoalRaw || null,
      bio: nextBioRaw || null,
      background: current.background ?? null,
      boss_id: nextBossId,
      boss_global_metaid: nextBossGlobalMetaId,
      llm_id: nextLlmRaw || null,
      ...(hasFallbackLlmValue ? { fallback_llm_id: nextFallbackLlmRaw || null } : {}),
      allow_chat_skills: nextAllowChatSkills,
      a2a_max_incoming_turns: nextA2aMaxIncomingTurns,
      a2a_bye_cooldown_ms: nextA2aByeCooldownMs,
      a2a_auto_reply_enabled: nextA2aAutoReplyEnabled,
      homepage: nextHomepage,
    };
    setList((prev) => prev.map((m) => (m.id === editId ? updatedMetabot : m)));
    // Stay in the edit view after a tab save so the user can keep editing
    // other tabs; the sync progress modal renders there too.
    // A Twin transfer also demotes the previous Twin main-process side, so
    // reload the whole list to refresh every card's type.
    if (metabotTypeChanged) {
      await loadList();
    }

    // metabot:update now performs local write + on-chain sync in ONE call
    // (updateMetaBotCore) — the exact same path the Twin metabot_update tool
    // uses. Read the sync outcome from the result instead of re-computing it.
    const sync = result.sync;
    if (!sync || sync.skipped) {
      // Local-only change (metabot_type / A2A knobs / enable): persisted, nothing to publish.
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('metabotSaveSuccess') }));
      return;
    }

    const attemptedStepKeys = (sync.attemptedStepKeys ?? []) as SyncStepKey[];
    const remaining = toEditSyncRemaining(sync.remainingSyncInput);
    setEditSyncRemaining(hasEditSyncRemaining(remaining) ? remaining : null);
    setSyncStatus(sync.success ? 'success' : 'error');
    setSyncError(sync.success ? '' : (sync.error ?? 'Unknown error'));
    setCreateSuccessModal({
      metabot: updatedMetabot,
      subsidySuccess: true,
      mode: 'editSync',
      syncStepKeys: attemptedStepKeys,
      showSubsidyStatus: false,
    });
    if (sync.success) {
      await loadList();
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('metabotSaveSuccess') }));
    }
  };

  const editMetabot = editId != null ? list.find((m) => m.id === editId) : null;

  const [settingsClosedTrigger, setSettingsClosedTrigger] = useState(0);
  useEffect(() => {
    const handler = () => setSettingsClosedTrigger((n) => n + 1);
    window.addEventListener('app:settingsClosed', handler);
    return () => window.removeEventListener('app:settingsClosed', handler);
  }, []);

  const llmOptions = useMemo((): LlmOption[] => {
    const config = configService.getConfig();
    const providers = (config.providers ?? {}) as Record<string, { enabled?: boolean; apiKey?: string }>;
    const configured: LlmOption[] = [];
    for (const key of ALL_PROVIDER_KEYS) {
      const p = providers[key];
      if (!p?.enabled) continue;
      if (providerRequiresApiKey(key) && !(p.apiKey ?? '').trim()) continue;
      configured.push({ id: key, label: providerLabel(key) });
    }
    return configured;
  }, [settingsClosedTrigger]);

  if (viewMode === 'add') {
    return (
      <div className="space-y-4 relative">
        <h2 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
          {i18nService.t('metabotAddTitle')}
        </h2>
        <MetaBotCreateForm
          onCancel={handleCancelForm}
          onSave={handleSaveNew}
          saveLabel={i18nService.t('save')}
          llmOptions={llmOptions}
          onRequestModelSettings={onRequestModelSettings}
          onCheckNameExists={handleCheckNameExists}
        />
        {/* Chain publishing overlay */}
        {createChainStatus !== 'idle' && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-[var(--bg-main)]/90 dark:bg-claude-darkBg/90 backdrop-blur-sm">
            <div className="w-full max-w-sm mx-4 rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface p-6 shadow-xl text-center space-y-4">
              {createChainStatus === 'publishing' ? (
                <>
                  <div className="flex justify-center">
                    <ArrowPathIcon className="h-10 w-10 text-claude-accent animate-spin" />
                  </div>
                  <p className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                    {i18nService.t('metabotCreatingOnChain')}
                  </p>
                  <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('metabotCreatingOnChainHint')}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium text-red-500">
                    {i18nService.t('metabotCreateChainFailed')}
                  </p>
                  <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary break-words">
                    {createChainError}
                  </p>
                  <div className="flex justify-center gap-3">
                    <button
                      type="button"
                      onClick={handleCancelForm}
                      className="px-4 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                    >
                      {i18nService.t('cancel')}
                    </button>
                    <button
                      type="button"
                      onClick={() => pendingCreateValues && handleSaveNew(pendingCreateValues)}
                      className="btn-idchat-primary-filled px-4 py-2 text-sm flex items-center gap-2"
                    >
                      <ArrowPathIcon className="h-4 w-4" />
                      {i18nService.t('metabotRetryCreate')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (viewMode === 'edit' && editMetabot) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCancelForm}
            aria-label={i18nService.t('back')}
            title={i18nService.t('back')}
            data-slot="metabot-edit-back"
            className="p-1.5 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
          >
            <ArrowLeftIcon className="h-4 w-4" />
          </button>
          <h2 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
            {i18nService.t('metabotEditTitle')}
          </h2>
        </div>
        <MetaBotEditTabs
          initialValues={buildEditFormValues(editMetabot)}
          metabotId={editMetabot.id}
          ownerBindingPinId={editMetabot.owner_binding_pinid ?? null}
          onCancel={handleCancelForm}
          onSaveTab={saveEditFields}
          llmOptions={llmOptions}
          skillOptions={skillOptions}
          onRequestModelSettings={onRequestModelSettings}
          onCheckNameExists={handleCheckNameExists}
          currentTwinName={list.find((m) => m.metabot_type === 'twin' && m.id !== editMetabot.id)?.name ?? null}
          onOpenDefaultHomepage={onOpenMetabotInBrowser ? () => onOpenMetabotInBrowser(editMetabot) : undefined}
          onPreviewMetaAppHomepage={onPreviewMetaAppHomepage}
          onRequestMetaApps={onRequestMetaApps}
          metabot={editMetabot}
          onDelete={() => handleDeleteRequest(editMetabot)}
        />
        {renderSuccessModal()}
        {renderDeleteModal()}
      </div>
    );
  }

  function handleCloseSuccessModal() {
    setCreateSuccessModal(null);
    setEditSyncRemaining(null);
    setSyncStatus('idle');
    setSyncError('');
  }

  // Shared by the list view and the edit view: per-tab saves stay in the edit
  // view, so the sync progress modal must be able to appear there too. Kept as
  // hoisted function declarations because the edit view returns before the
  // textual position of these definitions.
  function renderSuccessModal() {
    if (!createSuccessModal) return null;
    return (
      <MetaBotCreateSuccessModal
        metabot={createSuccessModal.metabot}
        subsidySuccess={createSuccessModal.subsidySuccess}
        subsidyError={createSuccessModal.subsidyError}
        syncStatus={syncStatus}
        syncError={syncError}
        mode={createSuccessModal.mode}
        syncStepKeys={createSuccessModal.syncStepKeys}
        showSubsidyStatus={createSuccessModal.showSubsidyStatus}
        onContinueEditing={
          createSuccessModal.mode === 'create'
            ? () => {
                const createdId = createSuccessModal.metabot.id;
                handleCloseSuccessModal();
                handleEdit(createdId);
              }
            : undefined
        }
        onClose={handleCloseSuccessModal}
        onSyncToChain={handleSyncToChain}
      />
    );
  }
  // Shared by the list view and the edit view: the Advanced-tab Danger Zone can
  // trigger delete while editing, so the confirm modal must render in both.
  function renderDeleteModal() {
    if (!deleteTarget) return null;
    return (
      <MetaBotDeleteConfirmModal
        metabot={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDeleteConfirm}
      />
    );
  }
  const handleDeleteRequest = (metabot: Metabot) => setDeleteTarget(metabot);
  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    const deletedId = deleteTarget.id;
    const result = await window.electron.idbots.deleteMetaBot(deletedId);
    if (result.success) {
      setList((prev) => prev.filter((m) => m.id !== deletedId));
      setDeleteTarget(null);
      // If the deleted bot was open in the edit view, fall back to the list.
      if (editId === deletedId) {
        setEditId(null);
        setViewMode('list');
      }
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('metabotDeleteSuccess') }));
    } else {
      setActionError(result.error || i18nService.t('metabotUpdateFailed'));
    }
  };
  const performSyncToChain = async (metabot: Metabot) => {
    setSyncStatus('syncing');
    setSyncError('');
    try {
      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const SYNC_RETRY_DELAY_MS = 2500;
      let result = await window.electron.idbots.syncMetaBot(metabot.id);
      if (!result.success) {
        await delay(SYNC_RETRY_DELAY_MS);
        result = await window.electron.idbots.syncMetaBot(metabot.id);
      }
      if (result.success) {
        setSyncStatus('success');
        await loadList();
      } else {
        setSyncStatus('error');
        if (result.canSkip && (result.txids?.length ?? 0) > 0) {
          setSyncError(`${result.error ?? 'Unknown error'} (txids: ${result.txids?.length ?? 0})`);
        } else {
          setSyncError(result.error ?? 'Unknown error');
        }
      }
    } catch (err) {
      setSyncStatus('error');
      setSyncError(err instanceof Error ? err.message : 'Sync failed');
    }
  };

  /**
   * Manual Retry for an edit whose on-chain sync is incomplete. Republishes
   * only the steps still marked unsynced (the plan is computed by the main
   * process in updateMetaBotCore) — on-chain pins are not idempotent, so we
   * never re-sync an already-confirmed step.
   */
  async function performEditSyncRetry(remaining: EditSyncRemaining) {
    setSyncStatus('syncing');
    setSyncError('');
    try {
      const result = await window.electron.idbots.syncMetaBotEditChanges({
        metabotId: remaining.metabotId,
        syncName: remaining.syncName,
        syncAvatar: remaining.syncAvatar,
        syncBio: remaining.syncBio,
        syncPersona: remaining.syncPersona,
        syncLlm: remaining.syncLlm,
        syncChatSkills: remaining.syncChatSkills,
        syncHomepage: remaining.syncHomepage,
        syncOwner: remaining.syncOwner,
      });
      const nextRemaining = subtractEditSyncRemaining(remaining, result.syncedSteps ?? []);
      setEditSyncRemaining(hasEditSyncRemaining(nextRemaining) ? nextRemaining : null);
      setCreateSuccessModal((current) =>
        current?.mode === 'editSync' && current.syncStepKeys?.length
          ? { ...current, syncStepKeys: current.syncStepKeys.filter((k) => nextRemaining[syncStepKeyToFlag(k)] !== true) }
          : current,
      );
      if (result.success) {
        setSyncStatus('success');
        await loadList();
        window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('metabotSaveSuccess') }));
      } else {
        setSyncStatus('error');
        setSyncError(result.error ?? 'Unknown error');
      }
    } catch (err) {
      setSyncStatus('error');
      setSyncError(err instanceof Error ? err.message : 'Sync failed');
    }
  }

  async function handleSyncToChain() {
    if (!createSuccessModal) return;
    if (createSuccessModal.mode === 'editSync') {
      if (!editSyncRemaining) {
        setSyncStatus('error');
        setSyncError(i18nService.t('metabotSyncError'));
        return;
      }
      await performEditSyncRetry(editSyncRemaining);
      return;
    }
    await performSyncToChain(createSuccessModal.metabot);
  }

  const handleSyncUnsyncedMetabot = (metabot: Metabot) => {
    setCreateSuccessModal({
      metabot,
      subsidySuccess: true,
      mode: 'syncOnly',
      syncStepKeys: undefined,
      showSubsidyStatus: false,
    });
    setEditSyncRemaining(null);
    void performSyncToChain(metabot);
  };

  const handleRestoreCompleted = (metabot: Metabot) => {
    setList((prev) => (prev.some((m) => m.id === metabot.id) ? prev : sortMetabotsByCreatedAtAsc([...prev, metabot])));
    dispatch(setPreferredMetabotId(metabot.id));
  };

  return (
    <div className="space-y-4">
      <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {i18nService.t('metabotsDescription')}
      </p>

      {actionError && (
        <div
          className="text-sm text-red-500 dark:text-red-400 bg-red-500/10 dark:bg-red-500/10 rounded-lg px-3 py-2"
          role="alert"
        >
          {actionError}
          <button
            type="button"
            onClick={() => setActionError('')}
            className="ml-2 underline"
          >
            {i18nService.t('close')}
          </button>
        </div>
      )}

      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
          <input
            type="text"
            placeholder={i18nService.t('metabotSearchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-xl dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text dark:placeholder-claude-darkTextSecondary placeholder-claude-textSecondary border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent"
          />
        </div>
        <button
          type="button"
          onClick={handleAdd}
          className="px-3 py-2 text-sm rounded-xl border transition-colors dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover flex items-center gap-2"
        >
          <PlusCircleIcon className="h-4 w-4" />
          <span>{i18nService.t('metabotAdd')}</span>
        </button>
        <button
          type="button"
          onClick={() => {
            if (list.length >= DEFAULT_METABOT_LIMIT) {
              setShowLimitModal(true);
              return;
            }
            setActionError('');
            setShowRestoreModal(true);
          }}
          className="px-3 py-2 text-sm rounded-xl border transition-colors dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover flex items-center gap-2"
        >
          <ArrowPathIcon className="h-4 w-4" />
          <span>{i18nService.t('metabotRestore')}</span>
        </button>
      </div>

      {loading ? (
        <div className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary py-8 text-center">
          {i18nService.t('loading')}
        </div>
      ) : filteredList.length === 0 ? (
        <div className="col-span-2 text-center py-8 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('metabotNoItems')}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {filteredList.map((m) => (
              <MetaBotListCard
                key={m.id}
                metabot={m}
                onEdit={() => handleEdit(m.id)}
                onToggleEnabled={(enabled) => handleToggleEnabled(m.id, enabled)}
                isChainSynced={!!(m.metabot_info_pinid && m.metabot_info_pinid.trim())}
                onSyncToChain={() => handleSyncUnsyncedMetabot(m)}
                onOpenMetabotInBrowser={onOpenMetabotInBrowser}
              />
            ))}
          </div>
          {renderSuccessModal()}
          {renderDeleteModal()}
          {showRestoreModal && (
            <MetaBotRestoreMnemonicModal
              onClose={() => setShowRestoreModal(false)}
              onRestored={handleRestoreCompleted}
            />
          )}
          {showLimitModal && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
              onClick={() => setShowLimitModal(false)}
              role="dialog"
              aria-modal="true"
            >
              <div
                className="w-full max-w-sm mx-4 rounded-2xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border shadow-2xl p-5"
                onClick={(e) => e.stopPropagation()}
              >
                <p className="text-sm dark:text-claude-darkText text-claude-text">
                  {formatMetabotLimitReached()}
                </p>
                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setShowLimitModal(false)}
                    className="btn-idchat-primary-filled px-3 py-1.5 text-sm font-medium"
                  >
                    {i18nService.t('close')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default MetabotsManager;
