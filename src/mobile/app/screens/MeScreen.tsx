import { useEffect, useState } from 'react';
import { ChevronRightIcon } from '@heroicons/react/24/outline';
import { t } from '../../i18n';
import type { MobileLanguage } from '../../i18n';
import { CONTRACT_VERSION } from '../../bridge/types';
import { getMobileElectron } from '../appBridge';
import { logout, requestAccountDeletion } from '../../login/loginApi';
import { useIdentity } from '../hooks/useIdentity';
import { useMeters } from '../hooks/useMeters';
import { useSettings } from '../hooks/useSettings';
import { useMemorySettings } from '../hooks/useMemorySettings';
import { useSkills } from '../hooks/useSkills';
import { formatBytes, formatCount } from '../format';
import { BottomSheet } from '../components/BottomSheet';
import { BotManagementSection } from '../components/BotManagementSection';
import { Section } from '../components/Section';
import { Switch } from '../components/Switch';

function Segmented<T extends string>(props: {
  value: T;
  options: Array<{ value: T; labelKey: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <div className="flex gap-2">
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={props.disabled}
          onClick={() => props.onChange(option.value)}
          className={`min-h-[44px] flex-1 rounded-xl border px-2 text-sm disabled:opacity-40 ${
            props.value === option.value
              ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-black'
              : 'border-[var(--border-color)] text-[var(--text-secondary)]'
          }`}
        >
          {t(option.labelKey)}
        </button>
      ))}
    </div>
  );
}

function BalanceCard(props: { onOpenRecharge: () => void; resyncCounter?: number; rechargeAllowed?: boolean }): JSX.Element {
  const { meters, loading, error, reload } = useMeters(props.resyncCounter);
  return (
    <Section title={t('mobile.me.balanceTitle')}>
      <div className="mb-3 flex gap-3">
        <div className="flex-1 rounded-xl bg-[var(--bg-main)] p-3">
          <p className="text-xs text-[var(--text-secondary)]">{t('mobile.me.trafficLabel')}</p>
          <p className="text-lg font-semibold text-[var(--text-primary)]">
            {meters?.traffic ? formatBytes(meters.traffic.balanceBytes) : '—'}
          </p>
        </div>
        <div className="flex-1 rounded-xl bg-[var(--bg-main)] p-3">
          <p className="text-xs text-[var(--text-secondary)]">{t('mobile.me.llmLabel')}</p>
          <p className="text-lg font-semibold text-[var(--text-primary)]">
            {meters ? `${formatCount(meters.llm.quotaRemaining)} ${meters.llm.unit}` : '—'}
          </p>
        </div>
      </div>
      {loading ? <p className="mb-2 text-xs text-[var(--text-secondary)]">{t('mobile.common.loading')}</p> : null}
      {error ? (
        <div className="mb-2 flex items-center justify-between gap-2" data-testid="balance-load-error">
          <p className="text-xs text-red-600">{t('mobile.me.balanceLoadFailed')}</p>
          <button type="button" onClick={() => void reload()} className="min-h-[44px] px-2 text-xs text-[var(--text-primary)]">
            {t('mobile.common.retry')}
          </button>
        </div>
      ) : null}
      <div className="flex gap-2">
        {props.rechargeAllowed !== false ? (
          <button
            type="button"
            onClick={props.onOpenRecharge}
            className="min-h-[44px] flex-1 rounded-xl bg-[var(--color-primary)] py-2 text-sm font-medium text-black active:opacity-80"
          >
            {t('mobile.me.rechargeEntry')}
          </button>
        ) : null}
        <RedeemButton />
      </div>
    </Section>
  );
}

function RedeemButton(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const { meters, reload } = useMeters();

  const submit = async () => {
    const result = await getMobileElectron().traffic.redeemCode({ code });
    if (result?.success && result.result) {
      setFeedback({ ok: true, message: t('mobile.me.redeemSuccess', { amount: formatBytes(result.result.trafficBytes) }) });
      await reload();
      setCode('');
    } else {
      setFeedback({ ok: false, message: t('mobile.me.redeemError') });
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="min-h-[44px] flex-1 rounded-xl border border-[var(--border-color)] py-2 text-sm text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
      >
        {t('mobile.me.redeemEntry')}
      </button>
      {open ? (
        <BottomSheet title={t('mobile.me.redeemTitle')} onClose={() => setOpen(false)}>
          <div className="flex flex-col gap-3">
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder={t('mobile.me.redeemPlaceholder')}
              className="min-h-[44px] w-full rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-2.5 text-[15px] text-[var(--text-primary)] outline-none"
            />
            {feedback ? (
              <p className={`text-sm ${feedback.ok ? 'text-emerald-600' : 'text-red-600'}`}>{feedback.message}</p>
            ) : null}
            <p className="text-xs text-[var(--text-secondary)]">
              {`${t('mobile.me.trafficLabel')}: ${meters?.traffic ? formatBytes(meters.traffic.balanceBytes) : '—'}`}
            </p>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!code.trim()}
              className="min-h-[44px] rounded-xl bg-[var(--color-primary)] py-2 text-sm font-medium text-black active:opacity-80 disabled:opacity-40"
            >
              {t('mobile.me.redeemSubmit')}
            </button>
          </div>
        </BottomSheet>
      ) : null}
    </>
  );
}

function BotsSection(): JSX.Element {
  return <BotManagementSection />;
}

/**
 * UX batch 2026-10-28: skills are deprioritized for the mobile MVP, so the
 * Me-page skills list is HIDDEN behind this reversible flag (no code is
 * deleted: flip to `true` to restore the section).
 */
const SHOW_SKILLS_SECTION = false;

function SkillsSection(): JSX.Element {
  const { skills, setEnabled } = useSkills();
  return (
    <Section title={t('mobile.me.skillsTitle')}>
      {skills.map((skill) => (
        <div key={skill.id} className="flex min-h-[44px] items-center gap-2 border-b border-[var(--border-color)] py-2 last:border-b-0">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] text-[var(--text-primary)]">{skill.name}</p>
            <p className="truncate text-xs text-[var(--text-secondary)]">{skill.description}</p>
          </div>
          <Switch checked={skill.enabled} onChange={(checked) => void setEnabled(skill.id, checked)} label={`${skill.name} · ${t('mobile.tasks.enabled')}`} />
        </div>
      ))}
    </Section>
  );
}

function SettingsSection(): JSX.Element {
  const { language, theme, saveState, changeLanguage, changeTheme } = useSettings();
  const memory = useMemorySettings();
  const memoryRows = [
    { field: 'memoryEnabled' as const, labelKey: 'mobile.me.memoryEnabled' },
    { field: 'memoryImplicitUpdateEnabled' as const, labelKey: 'mobile.me.memoryImplicitUpdate' },
    { field: 'memoryLlmJudgeEnabled' as const, labelKey: 'mobile.me.memoryLlmJudge' },
  ];
  return (
    <Section title={t('mobile.me.settingsTitle')}>
      <p className="mb-2 text-xs font-medium uppercase text-[var(--text-secondary)]">{t('mobile.me.languageLabel')}</p>
      <Segmented<MobileLanguage>
        value={language}
        options={[
          { value: 'zh', labelKey: 'mobile.me.languageZh' },
          { value: 'en', labelKey: 'mobile.me.languageEn' },
        ]}
        disabled={saveState.status === 'saving'}
        onChange={(value) => void changeLanguage(value)}
      />
      <p className="mb-2 mt-4 text-xs font-medium uppercase text-[var(--text-secondary)]">{t('mobile.me.themeLabel')}</p>
      <Segmented<'light' | 'dark' | 'system'>
        value={theme}
        options={[
          { value: 'light', labelKey: 'mobile.me.themeLight' },
          { value: 'dark', labelKey: 'mobile.me.themeDark' },
          { value: 'system', labelKey: 'mobile.me.themeSystem' },
        ]}
        disabled={saveState.status === 'saving'}
        onChange={(value) => void changeTheme(value)}
      />
      {saveState.status !== 'idle' ? (
        <p aria-live="polite" className={`mt-2 text-xs ${saveState.status === 'error' ? 'text-red-600' : 'text-[var(--text-secondary)]'}`}>
          {t(`mobile.me.settings${saveState.status === 'saving' ? 'Saving' : saveState.status === 'saved' ? 'Saved' : 'SaveFailed'}`)}
        </p>
      ) : null}

      <p className="mb-2 mt-5 text-xs font-medium uppercase text-[var(--text-secondary)]">{t('mobile.me.memoryTitle')}</p>
      {memory.loading ? <p className="py-2 text-sm text-[var(--text-secondary)]">{t('mobile.common.loading')}</p> : null}
      {memoryRows.map((row) => (
        <div key={row.field} className="flex min-h-[44px] items-center justify-between gap-3 border-b border-[var(--border-color)] py-2 last:border-b-0">
          <span className="text-sm text-[var(--text-primary)]">{t(row.labelKey)}</span>
          <Switch
            checked={memory.config?.[row.field] ?? false}
            disabled={memory.loading || !memory.config || memory.saving !== null}
            onChange={(checked) => void memory.setEnabled(row.field, checked)}
            label={t(row.labelKey)}
          />
        </div>
      ))}
      {memory.error ? (
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-xs text-red-600">{memory.error}</p>
          <button type="button" onClick={() => void memory.reload()} className="min-h-[44px] px-2 text-xs text-[var(--text-primary)]">
            {t('mobile.common.retry')}
          </button>
        </div>
      ) : null}
      {memory.saved ? <p aria-live="polite" className="mt-2 text-xs text-emerald-600">{t('mobile.me.settingsSaved')}</p> : null}
    </Section>
  );
}

function AccountSection(): JSX.Element {
  const [sheet, setSheet] = useState<'logout' | 'delete' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const doLogout = async () => {
    setBusy(true);
    try {
      await logout();
      window.location.assign('/login');
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    setBusy(true);
    try {
      await requestAccountDeletion(reason.trim() || undefined);
      setDone(true);
      setTimeout(() => window.location.assign('/login'), 1200);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t('mobile.me.accountTitle')}>
      <button
        type="button"
        onClick={() => setSheet('logout')}
        className="flex min-h-[44px] w-full items-center justify-between border-b border-[var(--border-color)] py-2 text-[15px] text-[var(--text-primary)] last:border-b-0"
      >
        {t('mobile.me.logout')}
        <ChevronRightIcon className="h-4 w-4 text-[var(--text-secondary)]" aria-hidden />
      </button>
      <button
        type="button"
        onClick={() => {
          setDone(false);
          setReason('');
          setSheet('delete');
        }}
        className="flex min-h-[44px] w-full items-center justify-between py-2 text-[15px] text-red-600"
      >
        {t('mobile.me.deleteAccount')}
        <ChevronRightIcon className="h-4 w-4" aria-hidden />
      </button>
      {sheet === 'logout' ? (
        <BottomSheet title={t('mobile.me.logoutTitle')} onClose={() => setSheet(null)}>
          <p className="mb-4 text-sm text-[var(--text-secondary)]">{t('mobile.me.logoutBody')}</p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setSheet(null)}
              className="min-h-[44px] flex-1 rounded-xl border border-[var(--border-color)] py-2 text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
            >
              {t('mobile.me.botCancel')}
            </button>
            <button
              type="button"
              onClick={() => void doLogout()}
              disabled={busy}
              className="min-h-[44px] flex-1 rounded-xl bg-[var(--color-primary)] py-2 font-medium text-black active:opacity-80 disabled:opacity-40"
            >
              {t('mobile.me.logoutConfirm')}
            </button>
          </div>
        </BottomSheet>
      ) : null}
      {sheet === 'delete' ? (
        <BottomSheet title={t('mobile.me.deleteTitle')} onClose={() => setSheet(null)}>
          {done ? (
            <p className="min-h-[44px] py-3 text-center text-sm font-medium text-emerald-600">
              {t('mobile.me.deleteDone')}
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-[var(--text-secondary)]">{t('mobile.me.deleteBody')}</p>
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={t('mobile.me.deleteReasonPlaceholder')}
                className="min-h-[44px] w-full rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-2.5 text-[15px] text-[var(--text-primary)] outline-none"
              />
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setSheet(null)}
                  className="min-h-[44px] flex-1 rounded-xl border border-[var(--border-color)] py-2 text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
                >
                  {t('mobile.me.botCancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void doDelete()}
                  disabled={busy}
                  className="min-h-[44px] flex-1 rounded-xl bg-red-600 py-2 font-medium text-white active:opacity-80 disabled:opacity-40"
                >
                  {t('mobile.me.deleteConfirm')}
                </button>
              </div>
            </div>
          )}
        </BottomSheet>
      ) : null}
    </Section>
  );
}

function AboutSection(): JSX.Element {
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    void getMobileElectron()
      .appInfo.getVersion()
      .then((version) => setAppVersion(version))
      .catch(() => setAppVersion(null));
  }, []);
  return (
    <Section title={t('mobile.me.aboutTitle')}>
      <p className="text-sm text-[var(--text-secondary)]">{t('mobile.me.appVersion', { version: appVersion ?? '—' })}</p>
      <p className="text-sm text-[var(--text-secondary)]">{t('mobile.me.contractVersion', { version: CONTRACT_VERSION })}</p>
    </Section>
  );
}

/** Me tab (REQ-E-14). */
export default function MeScreen(props: {
  resyncCounter?: number;
  onOpenRecharge: () => void;
  rechargeAllowed?: boolean;
}): JSX.Element {
  const identity = useIdentity(props.resyncCounter);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-[var(--border-color)] bg-[var(--bg-panel)] px-4 py-3">
        <h1 className="text-base font-semibold text-[var(--text-primary)]">{t('mobile.me.title')}</h1>
        <p className="truncate text-sm text-[var(--text-secondary)]">{identity.name ?? ''}</p>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <BalanceCard
          resyncCounter={props.resyncCounter}
          onOpenRecharge={props.onOpenRecharge}
          rechargeAllowed={props.rechargeAllowed}
        />
        <BotsSection />
        {SHOW_SKILLS_SECTION ? <SkillsSection /> : null}
        <SettingsSection />
        <AccountSection />
        <AboutSection />
      </div>
    </div>
  );
}
