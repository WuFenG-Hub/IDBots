/**
 * Traffic Settings panel (traffic-ized gas fee).
 * Sections in one tab: mode toggle (traffic vs self-pay + fallback policy),
 * balance with the free-grant claim banner and the recharge entry, the
 * recharge flow (code redemption; the pricing table stays as an informational
 * display), and usage (per-bot daily table, 30-day summary, ledger).
 * Chain writes stay on the self-paid path until the user switches the mode
 * here. UI copy goes through i18nService (zh/en), same as Settings/UserSettings.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowPathIcon,
  BoltIcon,
  CheckCircleIcon,
  CheckIcon,
  ClipboardDocumentIcon,
  ExclamationTriangleIcon,
  UserCircleIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';

type TrafficSettingsInfo = {
  mode: 'traffic' | 'selfpay';
  fallbackPolicy: 'selfpay' | 'strict';
  /** Configured assist-service base URL override; '' = production default. */
  apiBase: string;
};
type TrafficAccountInfo = {
  accountId: string;
  identityAddress: string;
  balanceBytes: number;
  reservedBytes: number;
  grantedBytesTotal: number;
  spentBytesTotal: number;
  status: number;
};
type TrafficPricingPlanInfo = {
  planId: string;
  chain: string;
  payCurrency: string;
  payAmount: number;
  trafficBytes: number;
  status: number;
  remark: string;
};
type TrafficFreeGrantCampaignInfo = {
  enabled: boolean;
  grantBytes: number;
  claimed: boolean;
  claimable: boolean;
};
type TrafficRedeemResultInfo = {
  codeId: number;
  trafficBytes: number;
  balanceAfter: number;
};
type TrafficBindSummaryInfo = {
  accountId: string;
  results: Array<{ botAddress: string; status: 'bound' | 'conflict' | 'failed'; error?: string }>;
  boundCount: number;
  conflictCount: number;
  failedCount: number;
};
type TrafficDailyUsageRowInfo = { date: string; botAddress: string; bytes: number; txCount: number };
type TrafficLedgerEntryInfo = {
  id: number;
  direction: number;
  amountBytes: number;
  balanceAfter: number;
  sourceType: string;
  sourceId: string;
  remark: string;
  timestamp: number;
  /** Local-journal enrichment (this-device sponsored commits only). */
  txId?: string;
  botAddress?: string;
  kind?: string;
};

const LOW_BALANCE_BYTES = 5 * 1024 * 1024; // low-balance banner threshold (5 MB)

// Ledger direction values delivered by the backend (models/traffic_ledger_model.go).
const LEDGER_DIRECTION_KEYS: Record<number, string> = {
  1: 'trafficLedgerCredit',
  2: 'trafficLedgerSpend',
  3: 'trafficLedgerReserve',
  4: 'trafficLedgerRelease',
};

// Locally journaled pin paths mapped to friendly business names; anything
// else falls back to a shortened raw path (see resolveLedgerKindLabel).
const LEDGER_KIND_KEYS: Record<string, string> = {
  '/protocols/simplemsg': 'trafficKindSimplemsg',
  '/protocols/simplebuzz': 'trafficKindSimplebuzz',
  '/file': 'trafficKindFile',
};

// Ledger credit sourceType values mapped to friendly labels (Phase 3b).
const LEDGER_SOURCE_TYPE_KEYS: Record<string, string> = {
  free_grant: 'trafficSourceFreeGrant',
  recharge_code: 'trafficSourceRechargeCode',
};

// Backend data.errorCode values mapped to friendly i18n copy (Phase 3b).
const TRAFFIC_ERROR_CODE_KEYS: Record<string, string> = {
  CAMPAIGN_DISABLED: 'trafficErrCampaignDisabled',
  ALREADY_CLAIMED: 'trafficErrAlreadyClaimed',
  CLIENT_NOT_ALLOWED: 'trafficErrClientNotAllowed',
  CODE_NOT_FOUND: 'trafficErrCodeNotFound',
  CODE_USED: 'trafficErrCodeUsed',
  CODE_DISABLED: 'trafficErrCodeDisabled',
  CODE_EXPIRED: 'trafficErrCodeExpired',
};

const resolveLedgerKindLabel = (kind: string): string => {
  const normalized = String(kind || '').trim().toLowerCase();
  if (!normalized) return '';
  const key = LEDGER_KIND_KEYS[normalized];
  if (key) return i18nService.t(key);
  // Unknown kind: shorthand for the raw path ('/protocols/paycomment' -> 'paycomment').
  if (normalized.startsWith('/protocols/')) return normalized.slice('/protocols/'.length);
  return normalized;
};

// Deterministic local-time ledger timestamp (YYYY-MM-DD HH:mm:ss).
const formatLedgerTimestamp = (timestamp: number): string => {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

// Copyable short TXID badge (same interaction as the group-task TxIdBadge):
// click copies the full id, the hover tooltip always shows it in full.
const LedgerTxIdBadge: React.FC<{ txId: string }> = ({ txId }) => {
  const [copied, setCopied] = useState(false);
  const short = txId.length > 16 ? `${txId.slice(0, 8)}…${txId.slice(-6)}` : txId;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(txId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable (permissions) — the title tooltip still shows the full id
    }
  };

  return (
    <span className="inline-flex shrink-0 items-center gap-0.5" title={txId}>
      <span className="font-mono text-[10px] dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">
        {short}
      </span>
      <button
        type="button"
        onClick={() => void handleCopy()}
        title={i18nService.t(copied ? 'trafficLedgerTxidCopied' : 'trafficLedgerCopyTxid')}
        aria-label={i18nService.t(copied ? 'trafficLedgerTxidCopied' : 'trafficLedgerCopyTxid')}
        className="rounded p-0.5 dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover hover:text-claude-text dark:hover:text-claude-darkText transition-colors"
      >
        {copied
          ? <CheckIcon className="h-3 w-3 text-emerald-500" />
          : <ClipboardDocumentIcon className="h-3 w-3" />}
      </button>
    </span>
  );
};

const cardClass = 'rounded-xl dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted px-4 py-3';
const labelClass = 'block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary';
const hintClass = 'text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary';
const primaryButtonClass = 'px-3 py-2 text-sm rounded-xl bg-claude-accent text-white hover:bg-claude-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const ghostButtonClass = 'px-3 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

// Renderer-side network failures (assistant-service unreachable, bad endpoint
// override, ...) surface as raw TypeError text such as "fetch failed"; match
// those so users get the friendly copy instead.
const NETWORK_ERROR_PATTERN = /fetch failed|failed to fetch|networkerror|network request failed|econnrefused|enotfound|etimedout|econnreset|socket hang up/i;

// Adaptive traffic formatter: single-pin spends are KB-level, so a flat MB
// view rounds them to "0.0 MB". Show B below 1 KB, KB below 1 MB, else MB.
const formatTraffic = (bytes: number): string => {
  const abs = Math.abs(bytes);
  if (abs < 1024) {
    return `${bytes} ${i18nService.t('trafficUnitBytes')}`;
  }
  if (abs < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} ${i18nService.t('trafficUnitKb')}`;
  }
  const mb = bytes / (1024 * 1024);
  const value = mb >= 100 ? String(Math.round(mb)) : mb.toFixed(1);
  return `${value} ${i18nService.t('trafficUnitMb')}`;
};

const formatBytesExact = (bytes: number): string =>
  `${bytes.toLocaleString()} ${i18nService.t('trafficUnitBytes')}`;

const shortAddress = (address: string): string => {
  const text = String(address || '');
  return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
};

const formatAmountWithSign = (direction: number, amountBytes: number): string => {
  const sign = direction === 1 || direction === 4 ? '+' : '-';
  return `${sign}${formatTraffic(amountBytes)}`;
};

// Single funnel for error text shown in this panel: backend error codes
// (data.errorCode) map to friendly copy first; network-level failures get the
// friendly copy with the raw message appended; everything else (backend error
// strings, translated fallbacks) passes through unchanged.
const describeTrafficError = (raw: string, fallbackKey: string, errorCode?: string): string => {
  const codeKey = errorCode ? TRAFFIC_ERROR_CODE_KEYS[errorCode] : undefined;
  if (codeKey) return i18nService.t(codeKey);
  const text = String(raw || '').trim();
  if (!text) return i18nService.t(fallbackKey);
  if (NETWORK_ERROR_PATTERN.test(text)) {
    return `${i18nService.t('trafficErrFriendly')} (${text})`;
  }
  return text;
};

const TrafficSettings: React.FC = () => {
  const [, setLanguage] = useState(i18nService.getLanguage());
  const [identityChecked, setIdentityChecked] = useState(false);
  const [identityAddress, setIdentityAddress] = useState<string>('');
  const [settings, setSettings] = useState<TrafficSettingsInfo | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [bindState, setBindState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [bindSummary, setBindSummary] = useState<TrafficBindSummaryInfo | null>(null);
  const [bindError, setBindError] = useState('');
  const [balance, setBalance] = useState<TrafficAccountInfo | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState('');
  const [campaign, setCampaign] = useState<TrafficFreeGrantCampaignInfo | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState('');
  const [claimNotice, setClaimNotice] = useState('');
  const [rechargeOpen, setRechargeOpen] = useState(false);
  const [plans, setPlans] = useState<TrafficPricingPlanInfo[]>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [plansError, setPlansError] = useState('');
  const [redeemCodeInput, setRedeemCodeInput] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [redeemError, setRedeemError] = useState('');
  const [redeemSuccess, setRedeemSuccess] = useState<TrafficRedeemResultInfo | null>(null);
  const [summary, setSummary] = useState<{ todayBytes: number; weekBytes: number; monthBytes: number } | null>(null);
  const [dailyRows, setDailyRows] = useState<TrafficDailyUsageRowInfo[] | null>(null);
  const [dailyFallbackRows, setDailyFallbackRows] = useState<TrafficDailyUsageRowInfo[] | null>(null);
  const [usageError, setUsageError] = useState('');
  const [ledgerEntries, setLedgerEntries] = useState<TrafficLedgerEntryInfo[]>([]);
  const [ledgerCursor, setLedgerCursor] = useState(0);
  const [ledgerDone, setLedgerDone] = useState(false);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState('');
  const [botNames, setBotNames] = useState<Record<string, string>>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [apiBaseInput, setApiBaseInput] = useState('');
  const [apiBaseSaving, setApiBaseSaving] = useState(false);
  const [apiBaseError, setApiBaseError] = useState('');
  const [apiBaseNotice, setApiBaseNotice] = useState('');

  const trafficApi = window.electron.traffic;

  // Re-render on language switches (same pattern as UserSettings/Settings).
  useEffect(() => {
    const unsubscribe = i18nService.subscribe(() => {
      setLanguage(i18nService.getLanguage());
    });
    return unsubscribe;
  }, []);

  const refreshBalance = useCallback(async (forceRefresh = false) => {
    setBalanceLoading(true);
    setBalanceError('');
    try {
      const res = await trafficApi.getBalance({ forceRefresh });
      if (res.success && res.balance) {
        setBalance(res.balance);
      } else {
        setBalanceError(describeTrafficError(res.error || '', 'trafficErrLoadBalance'));
      }
    } catch (error) {
      setBalanceError(describeTrafficError(error instanceof Error ? error.message : '', 'trafficErrLoadBalance'));
    } finally {
      setBalanceLoading(false);
    }
  }, [trafficApi]);

  // Free-grant campaign status is best-effort: when the backend doesn't ship
  // the endpoint (404) or is unreachable the button simply stays hidden.
  const loadCampaign = useCallback(async () => {
    try {
      const res = await trafficApi.getFreeGrantCampaignStatus();
      if (res.success && res.campaign) {
        setCampaign(res.campaign);
      } else {
        setCampaign(null);
      }
    } catch {
      setCampaign(null);
    }
  }, [trafficApi]);

  const loadUsage = useCallback(async () => {
    const summaryRes = await trafficApi.getUsageSummary().catch(() => null);
    if (summaryRes?.success && summaryRes.summary) {
      setSummary(summaryRes.summary);
    }
    const dailyRes = await trafficApi.getDailyUsage({}).catch(() => null);
    if (dailyRes?.success && dailyRes.rows) {
      setDailyRows(dailyRes.rows);
      setDailyFallbackRows(null);
      setUsageError('');
      return;
    }
    // Backend unreachable: fall back to the local spend journal aggregated by
    // UTC day + bot address so the table stays useful offline.
    setUsageError(describeTrafficError(dailyRes?.error || '', 'trafficUsageUnavailable'));
    const journalRes = await trafficApi.getLocalJournal({ limit: 200 }).catch(() => null);
    if (journalRes?.success && journalRes.entries) {
      const buckets = new Map<string, TrafficDailyUsageRowInfo>();
      for (const entry of journalRes.entries) {
        const date = new Date(entry.createdAt).toISOString().slice(0, 10);
        const key = `${date}|${entry.botAddress}`;
        const bucket = buckets.get(key) ?? { date, botAddress: entry.botAddress, bytes: 0, txCount: 0 };
        bucket.bytes += entry.txSize;
        bucket.txCount += 1;
        buckets.set(key, bucket);
      }
      setDailyRows(null);
      setDailyFallbackRows(Array.from(buckets.values()).sort((a, b) => b.date.localeCompare(a.date)));
    }
  }, [trafficApi]);

  const loadLedger = useCallback(async (cursor: number) => {
    setLedgerLoading(true);
    setLedgerError('');
    try {
      const res = await trafficApi.getLedger({ cursor, limit: 20 });
      if (res.success && res.entries) {
        setLedgerEntries((previous) => (cursor ? [...previous, ...res.entries!] : res.entries!));
        const nextCursor = res.nextCursor ?? 0;
        setLedgerCursor(nextCursor);
        setLedgerDone(!nextCursor || res.entries.length === 0);
      } else {
        setLedgerError(describeTrafficError(res.error || '', 'trafficErrLoadLedger'));
      }
    } catch (error) {
      setLedgerError(describeTrafficError(error instanceof Error ? error.message : '', 'trafficErrLoadLedger'));
    } finally {
      setLedgerLoading(false);
    }
  }, [trafficApi]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const identityRes = await window.electron.userIdentity.get().catch(() => null);
      if (cancelled) return;
      const identity = identityRes?.success ? identityRes.identity : null;
      setIdentityAddress(identity?.mvc_address ?? '');
      setIdentityChecked(true);
      if (!identity) return;

      const settingsRes = await trafficApi.getSettings().catch(() => null);
      if (!cancelled && settingsRes?.success && settingsRes.settings) {
        setSettings(settingsRes.settings);
      }
      window.electron.metabot.list().then((res) => {
        if (cancelled || !res?.success || !res.list) return;
        const names: Record<string, string> = {};
        for (const bot of res.list) {
          if (bot.mvc_address && bot.name) {
            names[bot.mvc_address.toLowerCase()] = bot.name;
          }
        }
        setBotNames(names);
      }).catch(() => {});
      refreshBalance(true);
      loadCampaign();
      loadUsage();
      loadLedger(0);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const resolveBotLabel = useCallback((address: string): string => {
    const normalized = String(address || '').toLowerCase();
    if (!normalized) return '—';
    if (identityAddress && normalized === identityAddress.toLowerCase()) {
      return `${i18nService.t('trafficYouIdentity')} · ${shortAddress(address)}`;
    }
    const name = botNames[normalized];
    return name ? `${name} · ${shortAddress(address)}` : shortAddress(address);
  }, [botNames, identityAddress]);

  // Ledger source column: friendly kind + bot name for locally enriched
  // entries; the raw sourceType/remark pair for everything else.
  const resolveLedgerSourceLabel = useCallback((entry: TrafficLedgerEntryInfo): string => {
    const parts: string[] = [];
    const kindLabel = resolveLedgerKindLabel(entry.kind ?? '');
    if (kindLabel) parts.push(kindLabel);
    const botAddress = String(entry.botAddress || '');
    if (botAddress) {
      const normalized = botAddress.toLowerCase();
      if (identityAddress && normalized === identityAddress.toLowerCase()) {
        parts.push(i18nService.t('trafficYouIdentity'));
      } else {
        parts.push(botNames[normalized] ?? shortAddress(botAddress));
      }
    }
    if (parts.length > 0) return parts.join(' · ');
    const sourceKey = LEDGER_SOURCE_TYPE_KEYS[entry.sourceType];
    const sourceLabel = sourceKey ? i18nService.t(sourceKey) : entry.sourceType;
    return `${sourceLabel}${entry.remark ? ` · ${entry.remark}` : ''}`;
  }, [botNames, identityAddress]);

  const ledgerDirectionLabel = (direction: number): string => {
    const key = LEDGER_DIRECTION_KEYS[direction];
    return key
      ? i18nService.t(key)
      : i18nService.t('trafficLedgerTypeUnknown').replace('{direction}', String(direction));
  };

  const handleSelectMode = async (mode: 'traffic' | 'selfpay') => {
    if (!settings || settingsSaving || settings.mode === mode) return;
    setSettingsSaving(true);
    try {
      const res = await trafficApi.setSettings({ mode });
      if (res.success && res.settings) {
        setSettings(res.settings);
      }
    } finally {
      setSettingsSaving(false);
    }
    if (mode !== 'traffic') return;

    setBindState('running');
    setBindError('');
    setBindSummary(null);
    const ensureRes = await trafficApi.ensureAccount().catch(() => null);
    if (!ensureRes?.success) {
      setBindState('error');
      setBindError(describeTrafficError(ensureRes?.error || '', 'trafficEnsureAccountFailed'));
      return;
    }
    const bindRes = await trafficApi.bindAllBots().catch(() => null);
    if (!bindRes?.success || !bindRes.summary) {
      setBindState('error');
      setBindError(describeTrafficError(bindRes?.error || '', 'trafficBindBotsFailed'));
      return;
    }
    setBindSummary(bindRes.summary);
    setBindState('done');
    refreshBalance(true);
  };

  const handleSelectFallbackPolicy = async (fallbackPolicy: 'selfpay' | 'strict') => {
    if (!settings || settingsSaving || settings.fallbackPolicy === fallbackPolicy) return;
    setSettingsSaving(true);
    try {
      const res = await trafficApi.setSettings({ fallbackPolicy });
      if (res.success && res.settings) {
        setSettings(res.settings);
      }
    } finally {
      setSettingsSaving(false);
    }
  };

  const handleSaveApiBase = async (value: string) => {
    if (apiBaseSaving) return;
    setApiBaseSaving(true);
    setApiBaseError('');
    setApiBaseNotice('');
    try {
      const res = await trafficApi.setSettings({ apiBase: value });
      if (res.success && res.settings) {
        setSettings(res.settings);
        setApiBaseInput('');
        setApiBaseNotice(i18nService.t('trafficApiBaseSaved'));
        refreshBalance(true);
      } else {
        setApiBaseError(describeTrafficError(res.error || '', 'trafficErrSaveApiBase'));
      }
    } catch (error) {
      setApiBaseError(describeTrafficError(error instanceof Error ? error.message : '', 'trafficErrSaveApiBase'));
    } finally {
      setApiBaseSaving(false);
    }
  };

  const loadPlans = useCallback(async () => {
    setPlansLoading(true);
    setPlansError('');
    try {
      const res = await trafficApi.getPricing();
      if (res.success && res.plans) {
        setPlans(res.plans);
      } else {
        setPlansError(describeTrafficError(res.error || '', 'trafficErrLoadPlans'));
      }
    } catch (error) {
      setPlansError(describeTrafficError(error instanceof Error ? error.message : '', 'trafficErrLoadPlans'));
    } finally {
      setPlansLoading(false);
    }
  }, [trafficApi]);

  const openRecharge = () => {
    setRechargeOpen(true);
    setRedeemError('');
    setRedeemSuccess(null);
    if (plans.length === 0) {
      loadPlans();
    }
  };

  const closeRecharge = () => {
    setRechargeOpen(false);
    setRedeemError('');
    setRedeemSuccess(null);
    setRedeemCodeInput('');
  };

  const handleClaimFreeGrant = async () => {
    if (claiming) return;
    setClaiming(true);
    setClaimError('');
    setClaimNotice('');
    try {
      const res = await trafficApi.claimFreeGrant();
      if (res.success && res.claim) {
        setClaimNotice(i18nService.t('trafficFreeGrantClaimSuccess')
          .replace('{amount}', formatTraffic(res.claim.grantBytes)));
        loadCampaign();
        refreshBalance(true);
        loadLedger(0);
      } else {
        setClaimError(describeTrafficError(res.error || '', 'trafficErrClaimFailed', res.errorCode));
      }
    } catch (error) {
      setClaimError(describeTrafficError(error instanceof Error ? error.message : '', 'trafficErrClaimFailed'));
    } finally {
      setClaiming(false);
    }
  };

  const handleRedeemCode = async () => {
    const code = redeemCodeInput.trim();
    if (redeeming || !code) return;
    setRedeeming(true);
    setRedeemError('');
    setRedeemSuccess(null);
    try {
      const res = await trafficApi.redeemCode({ code });
      if (res.success && res.result) {
        setRedeemSuccess(res.result);
        setRedeemCodeInput('');
        refreshBalance(true);
        loadUsage();
        loadLedger(0);
      } else {
        setRedeemError(describeTrafficError(res.error || '', 'trafficRedeemFailed', res.errorCode));
      }
    } catch (error) {
      setRedeemError(describeTrafficError(error instanceof Error ? error.message : '', 'trafficRedeemFailed'));
    } finally {
      setRedeeming(false);
    }
  };

  const visibleDailyRows = dailyRows ?? dailyFallbackRows ?? [];
  const isTrafficMode = settings?.mode === 'traffic';

  if (!identityChecked) {
    return <p className={hintClass}>{i18nService.t('trafficLoading')}</p>;
  }

  if (!identityAddress) {
    return (
      <div className={cardClass}>
        <div className="flex items-start gap-3">
          <UserCircleIcon className="h-6 w-6 dark:text-claude-darkTextSecondary text-claude-textSecondary shrink-0 mt-0.5" />
          <div>
            <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-1">
              {i18nService.t('trafficCreateIdentityFirst')}
            </h4>
            <p className={hintClass}>
              {i18nService.t('trafficCreateIdentityDesc')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Mode */}
      <div>
        <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-1">
          {i18nService.t('trafficModeTitle')}
        </h4>
        <p className={`${hintClass} mb-3`}>
          {i18nService.t('trafficModeDesc')}
        </p>
        <div className="grid grid-cols-2 gap-2">
          {([
            { value: 'selfpay', title: i18nService.t('trafficModeSelfpayTitle'), desc: i18nService.t('trafficModeSelfpayDesc') },
            { value: 'traffic', title: i18nService.t('trafficModeTrafficTitle'), desc: i18nService.t('trafficModeTrafficDesc') },
          ] as const).map((option) => {
            const selected = (settings?.mode ?? 'selfpay') === option.value;
            return (
              <button
                key={option.value}
                type="button"
                disabled={settingsSaving || !settings}
                onClick={() => handleSelectMode(option.value)}
                className={`flex flex-col items-start py-2 px-3 rounded-xl border-2 text-left transition-all cursor-pointer ${
                  selected
                    ? 'border-claude-accent bg-claude-accent/5 dark:bg-claude-accent/10'
                    : 'dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg hover:border-claude-accent/40'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <span className={`text-sm font-semibold ${selected ? 'text-claude-accent' : 'dark:text-claude-darkText text-claude-text'}`}>
                  {option.title}
                </span>
                <span className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {option.desc}
                </span>
              </button>
            );
          })}
        </div>

        {isTrafficMode && (
          <div className="mt-3">
            <span className={labelClass}>{i18nService.t('trafficFallbackLabel')}</span>
            <div className="grid grid-cols-2 gap-2 mt-1.5">
              {([
                { value: 'selfpay', title: i18nService.t('trafficFallbackSelfpayTitle'), desc: i18nService.t('trafficFallbackSelfpayDesc') },
                { value: 'strict', title: i18nService.t('trafficFallbackStrictTitle'), desc: i18nService.t('trafficFallbackStrictDesc') },
              ] as const).map((option) => {
                const selected = settings?.fallbackPolicy === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    disabled={settingsSaving}
                    onClick={() => handleSelectFallbackPolicy(option.value)}
                    className={`flex flex-col items-start py-2 px-3 rounded-xl border-2 text-left transition-all cursor-pointer ${
                      selected
                        ? 'border-claude-accent bg-claude-accent/5 dark:bg-claude-accent/10'
                        : 'dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg hover:border-claude-accent/40'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    <span className={`text-xs font-semibold ${selected ? 'text-claude-accent' : 'dark:text-claude-darkText text-claude-text'}`}>
                      {option.title}
                    </span>
                    <span className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {option.desc}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {bindState === 'running' && (
          <p className={`${hintClass} mt-2`}>{i18nService.t('trafficBindingRunning')}</p>
        )}
        {bindState === 'done' && bindSummary && (
          <p className="text-xs text-claude-accent mt-2">
            {i18nService.t('trafficBindSummary')
              .replace('{bound}', String(bindSummary.boundCount))
              .replace('{boundPlural}', bindSummary.boundCount === 1 ? '' : 'es')
              .replace('{conflictClause}', bindSummary.conflictCount > 0
                ? i18nService.t('trafficBindSummaryConflict').replace('{count}', String(bindSummary.conflictCount))
                : '')}
          </p>
        )}
        {bindState === 'error' && (
          <p className="text-xs text-red-500 mt-2">{bindError || i18nService.t('trafficBindFailed')}</p>
        )}
      </div>

      {/* Balance */}
      <div className={cardClass}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <span className={labelClass}>{i18nService.t('trafficBalanceTitle')}</span>
            <div className="flex items-baseline gap-2 mt-1">
              <span
                className="text-2xl font-bold tabular-nums dark:text-claude-darkText text-claude-text"
                title={balance ? formatBytesExact(balance.balanceBytes) : undefined}
              >
                {balance ? formatTraffic(balance.balanceBytes) : '—'}
              </span>
              {balanceLoading && <ArrowPathIcon className="h-4 w-4 animate-spin dark:text-claude-darkTextSecondary text-claude-textSecondary" />}
            </div>
            {balance && (
              <p className={`${hintClass} mt-1`}>
                {i18nService.t('trafficBalanceStats')
                  .replace('{reserved}', formatTraffic(balance.reservedBytes))
                  .replace('{spent}', formatTraffic(balance.spentBytesTotal))}
              </p>
            )}
          </div>
          <div className="flex gap-2 shrink-0">
            <button
              type="button"
              className={ghostButtonClass}
              onClick={() => refreshBalance(true)}
              disabled={balanceLoading}
            >
              {i18nService.t('trafficRefresh')}
            </button>
            <button
              type="button"
              className={primaryButtonClass}
              onClick={openRecharge}
              disabled={rechargeOpen}
            >
              <span className="inline-flex items-center gap-1">
                <BoltIcon className="h-4 w-4" />
                {i18nService.t('trafficRecharge')}
              </span>
            </button>
          </div>
        </div>
        {campaign?.claimable && (
          <div className="flex items-center gap-2 mt-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-3 py-2">
            <p className="text-xs text-emerald-600 dark:text-emerald-400 flex-1">
              {claimNotice || i18nService.t('trafficFreeGrantHint')}
            </p>
            <button
              type="button"
              className={primaryButtonClass}
              onClick={handleClaimFreeGrant}
              disabled={claiming}
            >
              {claiming
                ? i18nService.t('trafficFreeGrantClaiming')
                : i18nService.t('trafficFreeGrantClaim')
                    .replace('{amount}', formatTraffic(campaign.grantBytes))}
            </button>
          </div>
        )}
        {claimError && <p className="text-xs text-red-500 mt-2">{claimError}</p>}
        {balanceError && (
          <div className="flex items-center gap-2 mt-3">
            <p className="text-xs text-red-500 flex-1">{balanceError}</p>
            <button type="button" className={ghostButtonClass} onClick={() => refreshBalance(true)}>
              {i18nService.t('trafficRetry')}
            </button>
          </div>
        )}
        {balance && balance.balanceBytes < LOW_BALANCE_BYTES && (
          <div className="flex items-center gap-2 mt-3 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2">
            <ExclamationTriangleIcon className="h-4 w-4 text-amber-500 shrink-0" />
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {i18nService.t('trafficLowBalanceWarning')}
            </p>
          </div>
        )}
      </div>

      {/* Recharge (code redemption; pricing table stays as reference) */}
      {rechargeOpen && (
        <div className={cardClass}>
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text">{i18nService.t('trafficRedeemTitle')}</h4>
            <button type="button" className={ghostButtonClass} onClick={closeRecharge}>
              {i18nService.t('trafficClose')}
            </button>
          </div>

          <p className={`${hintClass} mb-2`}>{i18nService.t('trafficRedeemDesc')}</p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={redeemCodeInput}
              onChange={(event) => {
                setRedeemCodeInput(event.target.value.toUpperCase());
                setRedeemError('');
                setRedeemSuccess(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void handleRedeemCode();
                }
              }}
              placeholder={i18nService.t('trafficRedeemPlaceholder')}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              className="flex-1 min-w-0 rounded-lg font-mono dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
            />
            <button
              type="button"
              className={primaryButtonClass}
              onClick={handleRedeemCode}
              disabled={redeeming || !redeemCodeInput.trim()}
            >
              {redeeming ? i18nService.t('trafficRedeeming') : i18nService.t('trafficRedeemButton')}
            </button>
          </div>
          {redeemError && <p className="text-xs text-red-500 mt-2">{redeemError}</p>}
          {redeemSuccess && (
            <div className="flex items-start gap-2 mt-3">
              <CheckCircleIcon className="h-5 w-5 text-claude-accent shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                  {i18nService.t('trafficRedeemSuccess').replace('{traffic}', formatTraffic(redeemSuccess.trafficBytes))}
                </p>
                {balance && (
                  <p className={`${hintClass} mt-1`}>
                    {i18nService.t('trafficNewBalance').replace('{balance}', formatTraffic(balance.balanceBytes))}
                  </p>
                )}
              </div>
            </div>
          )}

          <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mt-4 mb-2">
            {i18nService.t('trafficPricingInfo')}
          </h4>
          {plansLoading && <p className={hintClass}>{i18nService.t('trafficPlansLoading')}</p>}
          {plansError && (
            <div className="flex items-center gap-2">
              <p className="text-xs text-red-500 flex-1">{plansError}</p>
              <button type="button" className={ghostButtonClass} onClick={loadPlans}>
                {i18nService.t('trafficRetry')}
              </button>
            </div>
          )}
          {!plansLoading && !plansError && plans.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {plans.map((plan) => (
                <div
                  key={plan.planId}
                  className="flex flex-col items-center py-2.5 px-2 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg"
                >
                  <span className="text-sm font-bold dark:text-claude-darkText text-claude-text">
                    ¥{plan.payAmount}
                  </span>
                  <span className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {formatTraffic(plan.trafficBytes)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Usage */}
      <div>
        <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-2">{i18nService.t('trafficUsageTitle')}</h4>
        {summary && (
          <div className="grid grid-cols-3 gap-2 mb-3">
            {([
              { label: i18nService.t('trafficSummaryToday'), bytes: summary.todayBytes },
              { label: i18nService.t('trafficSummaryWeek'), bytes: summary.weekBytes },
              { label: i18nService.t('trafficSummaryMonth'), bytes: summary.monthBytes },
            ]).map((item) => (
              <div key={item.label} className={`${cardClass} text-center`}>
                <div className="text-sm font-bold tabular-nums dark:text-claude-darkText text-claude-text">
                  {formatTraffic(item.bytes)}
                </div>
                <div className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {item.label}
                </div>
              </div>
            ))}
          </div>
        )}

        {usageError && <p className={`${hintClass} mb-2`}>{usageError}</p>}
        {visibleDailyRows.length > 0 ? (
          <div className={`${cardClass} overflow-x-auto`}>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  <th className="py-1 pr-3 font-medium">{i18nService.t('trafficTableDate')}</th>
                  <th className="py-1 pr-3 font-medium">{i18nService.t('trafficTableBot')}</th>
                  <th className="py-1 pr-3 font-medium text-right">{i18nService.t('trafficTableTraffic')}</th>
                  <th className="py-1 font-medium text-right">{i18nService.t('trafficTableWrites')}</th>
                </tr>
              </thead>
              <tbody>
                {visibleDailyRows.map((row) => (
                  <tr key={`${row.date}|${row.botAddress}`} className="dark:text-claude-darkText text-claude-text">
                    <td className="py-1 pr-3 tabular-nums">{row.date}</td>
                    <td className="py-1 pr-3">{resolveBotLabel(row.botAddress)}</td>
                    <td className="py-1 pr-3 text-right tabular-nums" title={formatBytesExact(row.bytes)}>
                      {formatTraffic(row.bytes)}
                    </td>
                    <td className="py-1 text-right tabular-nums">{row.txCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          !usageError && <p className={hintClass}>{i18nService.t('trafficUsageEmpty')}</p>
        )}

        <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mt-4 mb-2">{i18nService.t('trafficLedgerTitle')}</h4>
        {ledgerEntries.length > 0 ? (
          <div className={`${cardClass} space-y-1.5`}>
            {ledgerEntries.map((entry) => (
              <div key={entry.id} className="flex items-center gap-3 text-xs">
                <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary tabular-nums shrink-0">
                  {formatLedgerTimestamp(entry.timestamp)}
                </span>
                <span className="dark:text-claude-darkText text-claude-text shrink-0">
                  {ledgerDirectionLabel(entry.direction)}
                </span>
                <span
                  className="dark:text-claude-darkTextSecondary text-claude-textSecondary truncate flex-1"
                  title={[entry.kind, entry.botAddress].filter(Boolean).join(' · ') || undefined}
                >
                  {resolveLedgerSourceLabel(entry)}
                </span>
                {entry.txId ? <LedgerTxIdBadge txId={entry.txId} /> : null}
                <span className="tabular-nums font-medium dark:text-claude-darkText text-claude-text shrink-0">
                  {formatAmountWithSign(entry.direction, entry.amountBytes)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          !ledgerError && <p className={hintClass}>{i18nService.t('trafficLedgerEmpty')}</p>
        )}
        {ledgerError && (
          <div className="flex items-center gap-2 mt-2">
            <p className="text-xs text-red-500 flex-1">{ledgerError}</p>
            <button type="button" className={ghostButtonClass} onClick={() => loadLedger(0)}>
              {i18nService.t('trafficRetry')}
            </button>
          </div>
        )}
        {!ledgerDone && ledgerEntries.length > 0 && (
          <div className="flex justify-center mt-2">
            <button
              type="button"
              className={ghostButtonClass}
              onClick={() => loadLedger(ledgerCursor)}
              disabled={ledgerLoading}
            >
              {ledgerLoading ? i18nService.t('trafficLedgerLoading') : i18nService.t('trafficLedgerLoadMore')}
            </button>
          </div>
        )}
      </div>

      {/* Advanced: assist-service endpoint override (integration testing) */}
      <div className={cardClass}>
        <button
          type="button"
          className="flex items-center justify-between w-full text-left"
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">{i18nService.t('trafficAdvanced')}</span>
          <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {advancedOpen ? i18nService.t('trafficAdvancedHide') : i18nService.t('trafficAdvancedShow')}
          </span>
        </button>
        {advancedOpen && (
          <div className="mt-3">
            <span className={labelClass}>{i18nService.t('trafficApiBaseLabel')}</span>
            <p className={`${hintClass} mt-1`}>
              {i18nService.t('trafficApiBaseCurrent').replace('{value}', settings?.apiBase ? settings.apiBase : i18nService.t('trafficApiBaseDefault'))}
            </p>
            <p className={`${hintClass} mt-1`}>
              {i18nService.t('trafficApiBaseDesc')}
            </p>
            <div className="flex items-center gap-2 mt-2">
              <input
                type="text"
                value={apiBaseInput}
                onChange={(event) => {
                  setApiBaseInput(event.target.value);
                  setApiBaseError('');
                  setApiBaseNotice('');
                }}
                placeholder={i18nService.t('trafficApiBasePlaceholder')}
                className="flex-1 min-w-0 rounded-lg dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
              />
              <button
                type="button"
                className={primaryButtonClass}
                onClick={() => handleSaveApiBase(apiBaseInput)}
                disabled={apiBaseSaving || !apiBaseInput.trim()}
              >
                {apiBaseSaving ? i18nService.t('trafficApiBaseSaving') : i18nService.t('trafficApiBaseSave')}
              </button>
              {settings?.apiBase ? (
                <button
                  type="button"
                  className={ghostButtonClass}
                  onClick={() => handleSaveApiBase('')}
                  disabled={apiBaseSaving}
                >
                  {i18nService.t('trafficApiBaseReset')}
                </button>
              ) : null}
            </div>
            {apiBaseError && <p className="text-xs text-red-500 mt-2">{apiBaseError}</p>}
            {apiBaseNotice && <p className="text-xs text-claude-accent mt-2">{apiBaseNotice}</p>}
          </div>
        )}
      </div>
    </div>
  );
};

export default TrafficSettings;
