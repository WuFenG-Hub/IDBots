import { useEffect, useState } from 'react';
import { PencilSquareIcon, PlusIcon } from '@heroicons/react/24/outline';
import { t } from '../../i18n';
import type { MobileMetabot } from '../../bridge/types';
import { useMetabots, type BotOperationResult, type MobileBotInput } from '../hooks/useMetabots';
import { BottomSheet } from './BottomSheet';
import { Section } from './Section';
import { Switch } from './Switch';

interface BrainOption {
  providerKey: string;
  modelId: string;
  label: string;
}

interface BotFormState {
  bot: MobileMetabot | null;
  busy: boolean;
  outcome: BotOperationResult | null;
}

function outcomeCopy(state: BotOperationResult['state']): string {
  return t(`mobile.me.botOutcome.${state}`);
}

function BotFormSheet(props: {
  state: BotFormState;
  brainOptions: BrainOption[];
  skills: Array<{ id: string; name: string; description?: string }>;
  catalogError: string | null;
  onSave: (input: MobileBotInput) => Promise<void>;
  onClose: () => void;
  getBalance: (id: number) => Promise<{ success: boolean; value?: string; error?: string }>;
}): JSX.Element {
  const { bot, busy, outcome } = props.state;
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
  const [brain, setBrain] = useState<BrainOption | null>(() => {
    const current = options.find((option) => option.modelId === bot?.llm_id && option.providerKey === (bot.llm_provider ?? ''));
    return current ?? options[0] ?? null;
  });
  const [effort, setEffort] = useState(bot?.llm_effort ?? '');
  const [selectedSkills, setSelectedSkills] = useState<string[]>(bot?.allow_chat_skills ?? []);
  const [balance, setBalance] = useState<{ loading: boolean; value?: string; error?: string }>({ loading: Boolean(bot) });
  const inputClass =
    'min-h-[44px] w-full rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-2.5 text-[15px] text-[var(--text-primary)] outline-none';

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

  return (
    <BottomSheet title={bot ? t('mobile.me.botEdit') : t('mobile.me.botCreate')} onClose={busy ? () => undefined : props.onClose}>
      <div className="flex flex-col gap-3" data-testid="bot-form">
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('mobile.me.botNamePlaceholder')} className={inputClass} />
        <input value={role} onChange={(event) => setRole(event.target.value)} placeholder={t('mobile.me.botRolePlaceholder')} className={inputClass} />
        <textarea value={soul} onChange={(event) => setSoul(event.target.value)} placeholder={t('mobile.me.botSoulPlaceholder')} rows={2} className={`${inputClass} resize-none`} />
        <textarea value={bio} onChange={(event) => setBio(event.target.value)} placeholder={t('mobile.me.botBioPlaceholder')} rows={2} className={`${inputClass} resize-none`} />

        <label className="text-xs font-medium text-[var(--text-secondary)]" htmlFor="mobile-bot-brain">{t('mobile.me.botBrainLabel')}</label>
        <select
          id="mobile-bot-brain"
          value={brain ? `${brain.providerKey}\n${brain.modelId}` : ''}
          disabled={busy || options.length === 0}
          onChange={(event) => {
            const [providerKey, modelId] = event.target.value.split('\n');
            setBrain(options.find((option) => option.providerKey === providerKey && option.modelId === modelId) ?? null);
          }}
          className={inputClass}
        >
          {!brain ? <option value="">{t('mobile.me.botBrainUnavailable')}</option> : null}
          {options.map((option) => (
            <option key={`${option.providerKey}\n${option.modelId}`} value={`${option.providerKey}\n${option.modelId}`}>
              {option.label}
            </option>
          ))}
        </select>
        <label className="text-xs font-medium text-[var(--text-secondary)]" htmlFor="mobile-bot-effort">{t('mobile.me.botEffortLabel')}</label>
        <select id="mobile-bot-effort" value={effort} disabled={busy} onChange={(event) => setEffort(event.target.value)} className={inputClass}>
          {['', 'off', 'low', 'high', 'max'].map((value) => (
            <option key={value || 'default'} value={value}>{t(`mobile.me.botEffort.${value || 'default'}`)}</option>
          ))}
        </select>
        <p className="text-xs text-[var(--text-secondary)]">{t('mobile.me.botModelBindingNote')}</p>

        <fieldset className="rounded-xl border border-[var(--border-color)] p-3">
          <legend className="px-1 text-xs font-medium text-[var(--text-secondary)]">{t('mobile.me.botSkillsLabel')}</legend>
          {props.skills.map((skill) => (
            <label key={skill.id} className="flex min-h-[44px] items-center gap-3 text-sm text-[var(--text-primary)]">
              <input
                type="checkbox"
                checked={selectedSkills.includes(skill.id)}
                disabled={busy}
                onChange={(event) => setSelectedSkills((current) => event.target.checked
                  ? [...new Set([...current, skill.id])]
                  : current.filter((id) => id !== skill.id))}
                className="h-5 w-5"
              />
              <span>{skill.name}</span>
            </label>
          ))}
        </fieldset>

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
          disabled={busy || !name.trim() || !brain?.modelId || Boolean(props.catalogError)}
          onClick={() => void props.onSave({
            name: name.trim(),
            role: role.trim(),
            soul: soul.trim(),
            bio: bio.trim(),
            llmId: brain?.modelId ?? '',
            llmProvider: brain?.providerKey ?? '',
            llmEffort: effort || null,
            allowChatSkills: selectedSkills,
          })}
          className="min-h-[44px] rounded-xl bg-[var(--color-primary)] py-2 font-medium text-black active:opacity-80 disabled:opacity-40"
          data-testid="bot-save"
        >
          {t('mobile.me.botSave')}
        </button>
      </div>
    </BottomSheet>
  );
}

export function BotManagementSection(): JSX.Element {
  const manager = useMetabots();
  const [formState, setFormState] = useState<BotFormState | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<BotOperationResult | null>(null);
  const brainOptions = manager.modelGroups.flatMap((group) => group.models.map((model) => ({
    providerKey: group.id,
    modelId: model.id,
    label: `${group.name} · ${model.name}`,
  })));

  const runRowAction = async (id: number, action: () => Promise<BotOperationResult>) => {
    setBusyId(id);
    setProblem(null);
    try {
      const result = await action();
      if (result.state === 'synced') setNotice(t('mobile.me.botSyncConfirmed'));
      else setProblem(result);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Section title={t('mobile.me.botsTitle')}>
      {notice ? <p className="mb-2 text-sm text-emerald-600" aria-live="polite">{notice}</p> : null}
      {problem ? (
        <div className="mb-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-amber-800" data-testid="bot-row-problem">
          <p className="text-sm font-medium">{outcomeCopy(problem.state)}</p>
          {problem.message ? <p className="mt-1 break-words text-xs">{problem.message}</p> : null}
        </div>
      ) : null}
      {manager.loading ? <p className="py-2 text-sm text-[var(--text-secondary)]">{t('mobile.common.loading')}</p> : null}
      {manager.error ? (
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-xs text-red-600">{manager.error}</p>
          <button type="button" onClick={() => void manager.reload()} className="min-h-[44px] px-2 text-xs text-[var(--text-primary)]">
            {t('mobile.common.retry')}
          </button>
        </div>
      ) : null}
      {manager.bots.map((bot) => {
        const chainState = bot.chain_sync_state ?? (bot.metabot_info_pinid ? 'synced' : 'partial');
        const pendingSteps = bot.chain_sync_pending_steps ?? [];
        return (
          <div key={bot.id} className="border-b border-[var(--border-color)] py-3 last:border-b-0" data-testid={`bot-row-${bot.id}`}>
            <div className="flex min-h-[44px] items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] text-[var(--text-primary)]">{bot.name}</p>
                <p className="truncate text-xs text-[var(--text-secondary)]">
                  {t(bot.metabot_type === 'twin' ? 'mobile.me.botType.twin' : 'mobile.me.botType.worker')}
                  {bot.llm_id ? ` · ${bot.llm_id}` : bot.role ? ` · ${bot.role}` : ''}
                </p>
                <p
                  className={`mt-1 text-xs ${chainState === 'synced' ? 'text-emerald-600' : 'text-amber-600'}`}
                  data-testid={`bot-chain-${bot.id}`}
                  data-state={chainState}
                >
                  {chainState === 'synced'
                    ? t('mobile.me.botChainSynced')
                    : t('mobile.me.botChainPending', { steps: pendingSteps.join(', ') })}
                </p>
              </div>
              <Switch
                checked={bot.enabled}
                disabled={busyId === bot.id}
                onChange={(checked) => void runRowAction(bot.id, () => manager.setBotEnabled(bot.id, checked))}
                label={`${bot.name} · ${t(bot.enabled ? 'mobile.tasks.enabled' : 'mobile.tasks.disabled')}`}
              />
              <button
                type="button"
                onClick={() => setFormState({ bot, busy: false, outcome: null })}
                aria-label={`${t('mobile.me.botEdit')} · ${bot.name}`}
                className="flex min-h-[44px] min-w-[44px] items-center justify-center text-[var(--text-secondary)] active:text-[var(--text-primary)]"
              >
                <PencilSquareIcon className="h-5 w-5" aria-hidden />
              </button>
            </div>
            {chainState === 'partial' ? (
              <div className="mt-1 flex flex-wrap gap-2">
                {bot.subsidy_state === 'failed' ? (
                  <>
                    <button
                      type="button"
                      disabled={busyId === bot.id}
                      onClick={() => void runRowAction(bot.id, () => manager.resumeBot(bot.id, 'subsidized'))}
                      className="min-h-[44px] rounded-lg border border-amber-400 px-3 text-xs text-amber-700"
                    >
                      {t('mobile.me.botResume')}
                    </button>
                    <button
                      type="button"
                      disabled={busyId === bot.id}
                      onClick={() => void runRowAction(bot.id, () => manager.resumeBot(bot.id, 'self-funded'))}
                      className="min-h-[44px] rounded-lg border border-amber-400 px-3 text-xs text-amber-700"
                    >
                      {t('mobile.me.botSelfFundResume')}
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  disabled={busyId === bot.id}
                  onClick={() => void runRowAction(bot.id, () => manager.syncBot(bot.id))}
                  className="min-h-[44px] rounded-lg border border-[var(--border-color)] px-3 text-xs text-[var(--text-primary)]"
                >
                  {t('mobile.me.botSync')}
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => setFormState({ bot: null, busy: false, outcome: null })}
        className="mt-2 flex min-h-[44px] w-full items-center justify-center gap-1 rounded-xl border border-[var(--border-color)] py-2 text-sm text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
        data-testid="bot-create"
      >
        <PlusIcon className="h-4 w-4" aria-hidden />
        {t('mobile.me.botCreate')}
      </button>
      {formState ? (
        <BotFormSheet
          key={formState.bot?.id ?? 'new'}
          state={formState}
          brainOptions={brainOptions}
          skills={manager.skills}
          catalogError={manager.catalogError}
          getBalance={manager.getBotBalance}
          onClose={() => setFormState(null)}
          onSave={async (input) => {
            const editing = formState.bot;
            setFormState((current) => current ? { ...current, busy: true, outcome: null } : current);
            const result = editing ? await manager.updateBot(editing.id, input) : await manager.createBot(input);
            if (result.state === 'synced') {
              setNotice(t(editing ? 'mobile.me.botUpdated' : 'mobile.me.botCreatedSynced'));
              setFormState(null);
              return;
            }
            setFormState((current) => current ? { ...current, busy: false, outcome: result } : current);
          }}
        />
      ) : null}
    </Section>
  );
}
