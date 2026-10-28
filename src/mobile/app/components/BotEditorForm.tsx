import { useEffect, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { t } from '../../i18n';
import type { MobileMetabot } from '../../bridge/types';
import type { BotOperationResult, MobileBotInput } from '../hooks/useMetabots';

/**
 * Tabbed MetaBot editor used by the Me screen's create/edit bottom sheet
 * (UX batch 2026-10-28).
 *
 * Design contract (owner-approved, desktop-aligned):
 * - Edit mode: four tabs (Basic / Model / Skills / Other). Tab panels stay
 *   mounted and are only CSS-hidden, so edits survive tab switches — the
 *   same rule the desktop tabbed form follows.
 * - All inputs carry visible labels (label + htmlFor) — no bare inputs.
 * - The chat-skills block starts COLLAPSED and must be expanded before use.
 * - Model & reasoning effort merge into one block; a fallback model
 *   (fallback_llm, desktop-aligned with provider + effort) is selectable.
 * - Create mode: only Name + Role are required to submit (the primary brain
 *   is auto-filled from the catalog when untouched, because the real
 *   createMetaBotOnChain contract requires one); everything else moves into
 *   a collapsible Advanced section.
 */

export interface EditorBrainOption {
  providerKey: string;
  modelId: string;
  label: string;
}

interface BotEditorState {
  bot: MobileMetabot | null;
  busy: boolean;
  outcome: BotOperationResult | null;
}

type EditorTabKey = 'basic' | 'model' | 'skills' | 'other';

const EFFORT_LEVELS: ReadonlyArray<string> = ['', 'off', 'low', 'high', 'max'];

const TAB_PANEL_CLASS = 'mt-3 flex flex-col gap-3';

const inputClass =
  'min-h-[44px] w-full rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-2.5 text-[15px] text-[var(--text-primary)] outline-none';
const labelClass = 'text-xs font-medium text-[var(--text-secondary)]';

function brainValue(option: EditorBrainOption): string {
  return `${option.providerKey}\n${option.modelId}`;
}

function effortCopyKey(value: string): string {
  return `mobile.me.botEffort.${value || 'default'}`;
}

function outcomeCopy(state: BotOperationResult['state']): string {
  return t(`mobile.me.botOutcome.${state}`);
}

function Field(props: {
  htmlFor: string;
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <label className={labelClass} htmlFor={props.htmlFor}>{props.label}</label>
      {props.children}
    </div>
  );
}

/** Tab strip shared by edit mode and the create-mode advanced section. */
function TabStrip(props: {
  tabs: ReadonlyArray<EditorTabKey>;
  value: EditorTabKey;
  disabled: boolean;
  onChange: (key: EditorTabKey) => void;
}): JSX.Element {
  return (
    <div className="flex gap-2" role="tablist">
      {props.tabs.map((entry) => (
        <button
          key={entry}
          type="button"
          role="tab"
          aria-selected={props.value === entry}
          disabled={props.disabled}
          data-testid={`bot-tab-${entry}`}
          onClick={() => props.onChange(entry)}
          className={`min-h-[40px] flex-1 rounded-xl border px-2 text-sm disabled:opacity-40 ${
            props.value === entry
              ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-black'
              : 'border-[var(--border-color)] text-[var(--text-secondary)]'
          }`}
        >
          {t(`mobile.me.botTab.${entry}`)}
        </button>
      ))}
    </div>
  );
}

/** Collapsible chat-skills block: collapsed by default, edits survive closing. */
function SkillsBlock(props: {
  skills: Array<{ id: string; name: string; description?: string }>;
  selected: string[];
  busy: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onSelect: (updater: (current: string[]) => string[]) => void;
}): JSX.Element {
  return (
    <div className="rounded-xl border border-[var(--border-color)] p-3" data-testid="bot-skills-block">
      <button
        type="button"
        aria-expanded={props.expanded}
        data-testid="bot-skills-toggle"
        onClick={props.onToggleExpand}
        className="flex min-h-[44px] w-full items-center justify-between gap-2 text-left"
      >
        <span className="text-xs font-medium text-[var(--text-secondary)]">
          {t('mobile.me.botSkillsToggle')}
          <span className="ml-1 text-[var(--text-primary)]">({props.selected.length})</span>
        </span>
        {props.expanded
          ? <ChevronDownIcon className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" aria-hidden />
          : <ChevronRightIcon className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" aria-hidden />}
      </button>
      <p className="mt-1 text-[11px] text-[var(--text-secondary)]">{t('mobile.me.botSkillsCollapsed')}</p>
      {props.expanded ? (
        <fieldset className="mt-2 border-t border-[var(--border-color)] pt-2">
          {props.skills.map((skill) => (
            <label key={skill.id} className="flex min-h-[44px] items-center gap-3 text-sm text-[var(--text-primary)]">
              <input
                type="checkbox"
                checked={props.selected.includes(skill.id)}
                disabled={props.busy}
                onChange={(event) => props.onSelect((current) => event.target.checked
                  ? [...new Set([...current, skill.id])]
                  : current.filter((id) => id !== skill.id))}
                className="h-5 w-5"
              />
              <span>{skill.name}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
    </div>
  );
}

/** One block holding the primary brain + effort (merged, owner-approved). */
function BrainBlock(props: {
  options: EditorBrainOption[];
  brain: EditorBrainOption | null;
  effort: string;
  busy: boolean;
  selectable: boolean;
  onBrainChange: (option: EditorBrainOption | null) => void;
  onEffortChange: (value: string) => void;
}): JSX.Element {
  return (
    <div className="rounded-xl border border-[var(--border-color)] p-3">
      <p className={`mb-2 ${labelClass}`}>{t('mobile.me.botBrainSectionLabel')}</p>
      <Field htmlFor="bot-primary-model" label={t('mobile.me.botModelLabel')}>
        <select
          id="bot-primary-model"
          data-testid="bot-model"
          value={props.brain ? brainValue(props.brain) : ''}
          disabled={props.busy || !props.selectable || props.options.length === 0}
          onChange={(event) => {
            const [providerKey, modelId] = event.target.value.split('\n');
            props.onBrainChange(
              props.options.find((option) => option.providerKey === providerKey && option.modelId === modelId) ?? null,
            );
          }}
          className={inputClass}
        >
          {!props.brain ? <option value="">{t('mobile.me.botBrainUnavailable')}</option> : null}
          {props.options.map((option) => (
            <option key={`${option.providerKey}\n${option.modelId}`} value={brainValue(option)}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="mt-2">
        <Field htmlFor="bot-primary-effort" label={t('mobile.me.botEffortShortLabel')}>
          <select
            id="bot-primary-effort"
            data-testid="bot-effort"
            value={props.effort}
            disabled={props.busy}
            onChange={(event) => props.onEffortChange(event.target.value)}
            className={inputClass}
          >
            {EFFORT_LEVELS.map((value) => (
              <option key={value || 'default'} value={value}>{t(effortCopyKey(value))}</option>
            ))}
          </select>
          <p className="text-[11px] text-[var(--text-secondary)]">{t('mobile.me.botEffortMainHint')}</p>
        </Field>
      </div>
    </div>
  );
}

/** Fallback brain block, desktop-aligned: model (with provider) + effort. */
function FallbackBrainBlock(props: {
  options: EditorBrainOption[];
  brain: EditorBrainOption | null;
  effort: string;
  busy: boolean;
  onBrainChange: (option: EditorBrainOption | null) => void;
  onEffortChange: (value: string) => void;
}): JSX.Element {
  return (
    <div className="rounded-xl border border-[var(--border-color)] p-3">
      <Field htmlFor="bot-fallback-model" label={t('mobile.me.botFallbackLabel')}>
        <select
          id="bot-fallback-model"
          data-testid="bot-fallback-model"
          value={props.brain ? brainValue(props.brain) : ''}
          disabled={props.busy || props.options.length === 0}
          onChange={(event) => {
            const [providerKey, modelId] = event.target.value.split('\n');
            props.onBrainChange(
              props.options.find((option) => option.providerKey === providerKey && option.modelId === modelId) ?? null,
            );
          }}
          className={inputClass}
        >
          <option value="">{t('mobile.me.botFallbackNone')}</option>
          {props.options
            .filter((option) => !props.brain || brainValue(option) !== brainValue(props.brain))
            .map((option) => (
              <option key={`${option.providerKey}\n${option.modelId}`} value={brainValue(option)}>
                {option.label}
              </option>
            ))}
        </select>
      </Field>
      {props.brain ? (
        <div className="mt-2">
          <Field htmlFor="bot-fallback-effort" label={t('mobile.me.botEffortShortLabel')}>
            <select
              id="bot-fallback-effort"
              data-testid="bot-fallback-effort"
              value={props.effort}
              disabled={props.busy}
              onChange={(event) => props.onEffortChange(event.target.value)}
              className={inputClass}
            >
              {EFFORT_LEVELS.map((value) => (
                <option key={value || 'default'} value={value}>{t(effortCopyKey(value))}</option>
              ))}
            </select>
            <p className="text-[11px] text-[var(--text-secondary)]">{t('mobile.me.botEffortFallbackHint')}</p>
          </Field>
        </div>
      ) : null}
      <p className="mt-2 text-[11px] text-[var(--text-secondary)]">{t('mobile.me.botFallbackHint')}</p>
    </div>
  );
}

export function BotEditorForm(props: {
  state: BotEditorState;
  brainOptions: EditorBrainOption[];
  skills: Array<{ id: string; name: string; description?: string }>;
  catalogError: string | null;
  getBalance: (id: number) => Promise<{ success: boolean; value?: string; error?: string }>;
  onSave: (input: MobileBotInput) => Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const { bot, busy, outcome } = props.state;
  const isEdit = Boolean(bot);
  const tabs: ReadonlyArray<EditorTabKey> = ['basic', 'model', 'skills', 'other'];
  const advancedTabs: ReadonlyArray<EditorTabKey> = ['basic', 'model', 'skills', 'other'];

  const [tab, setTab] = useState<EditorTabKey>('basic');
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const options = [...props.brainOptions];
  if (bot?.llm_id && !options.some((option) => option.modelId === bot.llm_id && option.providerKey === (bot.llm_provider ?? ''))) {
    options.unshift({
      providerKey: bot.llm_provider ?? '',
      modelId: bot.llm_id,
      label: t('mobile.me.botCurrentModel', { model: bot.llm_id }),
    });
  }
  const [name, setName] = useState(bot?.name ?? '');
  const [role, setRole] = useState(bot?.role ?? '');
  const [soul, setSoul] = useState(bot?.soul ?? '');
  const [bio, setBio] = useState(bot?.bio ?? '');
  const [brain, setBrain] = useState<EditorBrainOption | null>(() => {
    if (!bot?.llm_id) return options[0] ?? null;
    const current = options.find(
      (option) => option.modelId === bot.llm_id && option.providerKey === (bot.llm_provider ?? ''),
    );
    return current ?? {
      providerKey: bot.llm_provider ?? '',
      modelId: bot.llm_id,
      label: t('mobile.me.botCurrentModel', { model: bot.llm_id }),
    };
  });
  const [effort, setEffort] = useState(bot?.llm_effort ?? '');
  const [fallbackBrain, setFallbackBrain] = useState<EditorBrainOption | null>(() => {
    if (!bot?.fallback_llm_id) return null;
    return {
      providerKey: bot.fallback_llm_provider ?? '',
      modelId: bot.fallback_llm_id,
      label: t('mobile.me.botCurrentModel', { model: bot.fallback_llm_id }),
    };
  });
  const [fallbackEffort, setFallbackEffort] = useState(bot?.fallback_llm_effort ?? '');
  const [selectedSkills, setSelectedSkills] = useState<string[]>(bot?.allow_chat_skills ?? []);
  const [skillsExpanded, setSkillsExpanded] = useState(false);
  const [balance, setBalance] = useState<{ loading: boolean; value?: string; error?: string }>({ loading: Boolean(bot) });
  const [advancedTab, setAdvancedTab] = useState<EditorTabKey>('model');

  useEffect(() => {
    if (!bot) return;
    let active = true;
    void props.getBalance(bot.id).then((result) => {
      if (active) setBalance({ loading: false, value: result.value, error: result.error });
    });
    return () => {
      active = false;
    };
  }, [bot, props.getBalance]);

  const resolveInput = (): MobileBotInput => ({
    name: name.trim(),
    role: role.trim(),
    soul: soul.trim(),
    bio: bio.trim(),
    llmId: brain?.modelId ?? (isEdit ? '' : options[0]?.modelId ?? ''),
    llmProvider: brain?.providerKey ?? (isEdit ? '' : options[0]?.providerKey ?? ''),
    llmEffort: effort || null,
    fallbackLlmId: fallbackBrain?.modelId ?? '',
    fallbackLlmProvider: fallbackBrain?.providerKey ?? '',
    fallbackLlmEffort: fallbackBrain ? (fallbackEffort || null) : null,
    allowChatSkills: selectedSkills,
  });

  // Save gating (parity with the pre-tab form): edit keeps `name + primary
  // brain required`; create accepts `name only` and resolves a default brain
  // from the catalog (the real createMetaBotOnChain contract needs one).
  const saveDisabled = busy
    || !name.trim()
    || Boolean(props.catalogError)
    || (isEdit ? !brain?.modelId : options.length === 0);

  return (
    <div className="flex flex-col gap-3" data-testid="bot-form">
      {/* Basic identity: name + role always visible in both modes. */}
      <Field htmlFor="bot-name" label={t('mobile.me.botNameLabel')}>
        <input
          id="bot-name"
          data-testid="bot-name"
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('mobile.me.botNamePlaceholder')}
          className={inputClass}
        />
      </Field>
      <Field htmlFor="bot-role" label={t('mobile.me.botRoleLabel')}>
        <input
          id="bot-role"
          data-testid="bot-role"
          value={role}
          disabled={busy}
          onChange={(event) => setRole(event.target.value)}
          placeholder={t('mobile.me.botRolePlaceholder')}
          className={inputClass}
        />
      </Field>

      {isEdit ? (
        <>
          <TabStrip tabs={tabs} value={tab} disabled={busy} onChange={setTab} />
          <div data-testid={`bot-panel-basic`} className={TAB_PANEL_CLASS} style={tab === 'basic' ? undefined : { display: 'none' }}>
            <Field htmlFor="bot-soul" label={t('mobile.me.botSoulLabel')}>
              <textarea
                id="bot-soul"
                data-testid="bot-soul"
                value={soul}
                disabled={busy}
                onChange={(event) => setSoul(event.target.value)}
                placeholder={t('mobile.me.botSoulPlaceholder')}
                rows={2}
                className={`${inputClass} resize-none`}
              />
            </Field>
            <Field htmlFor="bot-bio" label={t('mobile.me.botBioLabel')}>
              <textarea
                id="bot-bio"
                data-testid="bot-bio"
                value={bio}
                disabled={busy}
                onChange={(event) => setBio(event.target.value)}
                placeholder={t('mobile.me.botBioPlaceholder')}
                rows={2}
                className={`${inputClass} resize-none`}
              />
            </Field>
          </div>
        </>
      ) : (
        <div data-testid="bot-create-guide" className="rounded-xl bg-[var(--bg-main)] p-3">
          <p className={`mb-1 ${labelClass}`}>{t('mobile.me.botCreateBasicTitle')}</p>
          <p className="text-sm text-[var(--text-primary)]">{t('mobile.me.botNameMinNote')}</p>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">{t('mobile.me.botCreateGuide')}</p>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">{t('mobile.me.botDefaultBrainNote')}</p>
          <button
            type="button"
            aria-expanded={advancedOpen}
            data-testid="bot-advanced-toggle"
            disabled={busy}
            onClick={() => setAdvancedOpen((current) => !current)}
            className="mt-2 flex min-h-[44px] w-full items-center justify-between gap-2 rounded-xl border border-[var(--border-color)] px-3 text-sm text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
          >
            <span>{t('mobile.me.botAdvancedToggle')}</span>
            {advancedOpen
              ? <ChevronDownIcon className="h-4 w-4 text-[var(--text-secondary)]" aria-hidden />
              : <ChevronRightIcon className="h-4 w-4 text-[var(--text-secondary)]" aria-hidden />}
          </button>
          {advancedOpen ? (
            <div data-testid="bot-advanced" className="mt-3 flex flex-col gap-3">
              <p className="text-xs text-[var(--text-secondary)]">{t('mobile.me.botAdvancedHint')}</p>
              <TabStrip tabs={advancedTabs} value={advancedTab} disabled={busy} onChange={setAdvancedTab} />
              <div
                data-testid="bot-panel-advanced-basic"
                className={TAB_PANEL_CLASS}
                style={advancedTab === 'basic' ? undefined : { display: 'none' }}
              >
                <Field htmlFor="bot-soul" label={t('mobile.me.botSoulLabel')}>
                  <textarea
                    id="bot-soul"
                    data-testid="bot-soul"
                    value={soul}
                    disabled={busy}
                    onChange={(event) => setSoul(event.target.value)}
                    placeholder={t('mobile.me.botSoulPlaceholder')}
                    rows={2}
                    className={`${inputClass} resize-none`}
                  />
                </Field>
                <Field htmlFor="bot-bio" label={t('mobile.me.botBioLabel')}>
                  <textarea
                    id="bot-bio"
                    data-testid="bot-bio"
                    value={bio}
                    disabled={busy}
                    onChange={(event) => setBio(event.target.value)}
                    placeholder={t('mobile.me.botBioPlaceholder')}
                    rows={2}
                    className={`${inputClass} resize-none`}
                  />
                </Field>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {/* Model / skills / other panels + hints */}
      <div
        data-testid="bot-panel-model"
        className={TAB_PANEL_CLASS}
        style={(isEdit ? tab === 'model' : advancedOpen && advancedTab === 'model') ? undefined : { display: 'none' }}
      >
        <BrainBlock
          options={options}
          brain={brain}
          effort={effort}
          busy={busy}
          selectable={isEdit || options.length > 0}
          onBrainChange={setBrain}
          onEffortChange={setEffort}
        />
        <FallbackBrainBlock
          options={options}
          brain={fallbackBrain}
          effort={fallbackEffort}
          busy={busy}
          onBrainChange={setFallbackBrain}
          onEffortChange={setFallbackEffort}
        />
      </div>
      <div
        data-testid="bot-panel-skills"
        className={TAB_PANEL_CLASS}
        style={(isEdit ? tab === 'skills' : advancedOpen && advancedTab === 'skills') ? undefined : { display: 'none' }}
      >
        <SkillsBlock
          skills={props.skills}
          selected={selectedSkills}
          busy={busy}
          expanded={skillsExpanded}
          onToggleExpand={() => setSkillsExpanded((current) => !current)}
          onSelect={setSelectedSkills}
        />
      </div>
      <div
        data-testid="bot-panel-other"
        className={TAB_PANEL_CLASS}
        style={(isEdit ? tab === 'other' : advancedOpen && advancedTab === 'other') ? undefined : { display: 'none' }}
      >
        <p className="text-xs text-[var(--text-secondary)]">{t('mobile.me.botModelBindingNote')}</p>
        <p className="text-xs text-[var(--text-secondary)]">{t('mobile.me.botFeeHint')}</p>
        {bot ? (
          <p className="text-xs text-[var(--text-secondary)]" data-testid="bot-balance-hint">
            {balance.loading
              ? t('mobile.common.loading')
              : balance.error
                ? t('mobile.me.botBalanceUnavailable')
                : t('mobile.me.botBalance', { balance: balance.value ?? '' })}
          </p>
        ) : null}
        {props.catalogError ? <p className="text-xs text-red-600">{props.catalogError}</p> : null}
      </div>

      {busy ? (
        <p className="rounded-xl bg-[var(--bg-main)] p-3 text-sm text-[var(--text-secondary)]" data-testid="bot-create-progress" aria-live="polite">
          {t(bot ? 'mobile.me.botUpdating' : 'mobile.me.botCreating')}
        </p>
      ) : null}
      {outcome ? (
        <div
          className={`rounded-xl border p-3 ${outcome.state === 'synced' ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-amber-300 bg-amber-50 text-amber-800'}`}
          data-testid="bot-operation-result"
          data-state={outcome.state}
          aria-live="polite"
        >
          <p className="text-sm font-medium">{outcomeCopy(outcome.state)}</p>
          {outcome.message ? <p className="mt-1 break-words text-xs">{outcome.message}</p> : null}
        </div>
      ) : null}
      <button
        type="button"
        disabled={saveDisabled}
        onClick={() => void props.onSave(resolveInput())}
        className="min-h-[44px] rounded-xl bg-[var(--color-primary)] py-2 font-medium text-black active:opacity-80 disabled:opacity-40"
        data-testid="bot-save"
      >
        {t('mobile.me.botSave')}
      </button>
    </div>
  );
}
