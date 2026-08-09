/**
 * Traffic Settings panel (traffic-ized gas fee).
 * Sections in one tab: mode toggle (traffic vs self-pay + fallback policy),
 * balance with the recharge entry, the recharge flow (mock payment during
 * development), and usage (per-bot daily table, 30-day summary, ledger).
 * Chain writes stay on the self-paid path until the user switches the mode
 * here. UI copy is English per project convention (same as P2PConfigPanel).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowPathIcon,
  BoltIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  UserCircleIcon,
} from '@heroicons/react/24/outline';

type TrafficSettingsInfo = {
  mode: 'traffic' | 'selfpay';
  fallbackPolicy: 'selfpay' | 'strict';
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
type TrafficRechargeOrderInfo = {
  orderId: string;
  payAmount: number;
  payCurrency: string;
  trafficBytes: number;
  gatewayParams: unknown;
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
};

type RechargeStage =
  | 'hidden'
  | 'plans'
  | 'creating'
  | 'mockPay'
  | 'confirming'
  | 'polling'
  | 'success'
  | 'failed';

const LOW_BALANCE_BYTES = 5 * 1024 * 1024; // low-balance banner threshold (5 MB)
const RECHARGE_POLL_INTERVAL_MS = 1500;
const RECHARGE_POLL_MAX_ATTEMPTS = 20;
const RECHARGE_STATUS_CREDITED = 3;
const RECHARGE_STATUS_CLOSED = 4;

// Ledger direction values delivered by the backend (models/traffic_ledger_model.go).
const LEDGER_DIRECTION_LABELS: Record<number, string> = {
  1: 'Credit',
  2: 'Spend',
  3: 'Reserve',
  4: 'Release',
};

const cardClass = 'rounded-xl dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted px-4 py-3';
const labelClass = 'block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary';
const hintClass = 'text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary';
const primaryButtonClass = 'px-3 py-2 text-sm rounded-xl bg-claude-accent text-white hover:bg-claude-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const ghostButtonClass = 'px-3 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

const formatMb = (bytes: number): string => {
  const mb = bytes / (1024 * 1024);
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
};

const formatBytesExact = (bytes: number): string => `${bytes.toLocaleString()} bytes`;

const shortAddress = (address: string): string => {
  const text = String(address || '');
  return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
};

const formatAmountWithSign = (direction: number, amountBytes: number): string => {
  const sign = direction === 1 || direction === 4 ? '+' : '-';
  return `${sign}${formatMb(amountBytes)}`;
};

const TrafficSettings: React.FC = () => {
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
  const [rechargeStage, setRechargeStage] = useState<RechargeStage>('hidden');
  const [plans, setPlans] = useState<TrafficPricingPlanInfo[]>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [plansError, setPlansError] = useState('');
  const [selectedPlanId, setSelectedPlanId] = useState('');
  const [activeOrder, setActiveOrder] = useState<TrafficRechargeOrderInfo | null>(null);
  const [rechargeError, setRechargeError] = useState('');
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
  const pollTimerRef = useRef<number | null>(null);

  const trafficApi = window.electron.traffic;

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const refreshBalance = useCallback(async (forceRefresh = false) => {
    setBalanceLoading(true);
    setBalanceError('');
    try {
      const res = await trafficApi.getBalance({ forceRefresh });
      if (res.success && res.balance) {
        setBalance(res.balance);
      } else {
        setBalanceError(res.error || 'Failed to load traffic balance.');
      }
    } catch (error) {
      setBalanceError(error instanceof Error ? error.message : 'Failed to load traffic balance.');
    } finally {
      setBalanceLoading(false);
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
    setUsageError(dailyRes?.error || 'Usage service unavailable; showing locally recorded spends.');
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
        setLedgerError(res.error || 'Failed to load the ledger.');
      }
    } catch (error) {
      setLedgerError(error instanceof Error ? error.message : 'Failed to load the ledger.');
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
      return `You (identity) · ${shortAddress(address)}`;
    }
    const name = botNames[normalized];
    return name ? `${name} · ${shortAddress(address)}` : shortAddress(address);
  }, [botNames, identityAddress]);

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
      setBindError(ensureRes?.error || 'Failed to create the traffic account.');
      return;
    }
    const bindRes = await trafficApi.bindAllBots().catch(() => null);
    if (!bindRes?.success || !bindRes.summary) {
      setBindState('error');
      setBindError(bindRes?.error || 'Failed to bind local MetaBot addresses.');
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

  const loadPlans = useCallback(async () => {
    setPlansLoading(true);
    setPlansError('');
    try {
      const res = await trafficApi.getPricing();
      if (res.success && res.plans) {
        setPlans(res.plans);
      } else {
        setPlansError(res.error || 'Failed to load pricing plans.');
      }
    } catch (error) {
      setPlansError(error instanceof Error ? error.message : 'Failed to load pricing plans.');
    } finally {
      setPlansLoading(false);
    }
  }, [trafficApi]);

  const openRecharge = () => {
    setRechargeError('');
    setActiveOrder(null);
    setRechargeStage('plans');
    if (plans.length === 0) {
      loadPlans();
    }
  };

  const handleCreateOrder = async () => {
    if (!selectedPlanId) return;
    setRechargeStage('creating');
    setRechargeError('');
    const res = await trafficApi.createRechargeOrder({ planId: selectedPlanId }).catch(() => null);
    if (!res?.success || !res.order) {
      setRechargeError(res?.error || 'Failed to create the recharge order.');
      setRechargeStage('failed');
      return;
    }
    setActiveOrder(res.order);
    setRechargeStage('mockPay');
  };

  const startOrderPolling = useCallback((orderId: string) => {
    stopPolling();
    let attempts = 0;
    const tick = async () => {
      attempts += 1;
      const res = await trafficApi.getRechargeOrder({ orderId }).catch(() => null);
      if (res?.success && res.order) {
        if (res.order.status === RECHARGE_STATUS_CREDITED) {
          setRechargeStage('success');
          refreshBalance(true);
          loadUsage();
          loadLedger(0);
          return;
        }
        if (res.order.status === RECHARGE_STATUS_CLOSED) {
          setRechargeError('The recharge order was closed before crediting.');
          setRechargeStage('failed');
          return;
        }
      }
      if (attempts >= RECHARGE_POLL_MAX_ATTEMPTS) {
        setRechargeError('Timed out waiting for the credit. Refresh the balance to check again.');
        setRechargeStage('failed');
        return;
      }
      pollTimerRef.current = window.setTimeout(tick, RECHARGE_POLL_INTERVAL_MS);
    };
    void tick();
  }, [loadLedger, loadUsage, refreshBalance, stopPolling, trafficApi]);

  // PHASE-4: replace this mock confirmation with the real payment gateway flow
  // (Stripe/Alipay). Only this handler and the mockPay card below change; the
  // order creation and credit polling stay as-is.
  const handleMockConfirm = async () => {
    if (!activeOrder) return;
    setRechargeStage('confirming');
    const res = await trafficApi.mockConfirmRechargeOrder({ orderId: activeOrder.orderId }).catch(() => null);
    if (!res?.success || !res.order) {
      setRechargeError(res?.error || 'Mock payment confirmation failed.');
      setRechargeStage('failed');
      return;
    }
    if (res.order.status === RECHARGE_STATUS_CREDITED) {
      setRechargeStage('success');
      refreshBalance(true);
      loadUsage();
      loadLedger(0);
      return;
    }
    setRechargeStage('polling');
    startOrderPolling(res.order.orderId);
  };

  const closeRecharge = () => {
    stopPolling();
    setRechargeStage('hidden');
    setActiveOrder(null);
    setRechargeError('');
  };

  const selectedPlan = useMemo(
    () => plans.find((plan) => plan.planId === selectedPlanId) ?? null,
    [plans, selectedPlanId],
  );

  const visibleDailyRows = dailyRows ?? dailyFallbackRows ?? [];
  const isTrafficMode = settings?.mode === 'traffic';

  if (!identityChecked) {
    return <p className={hintClass}>Loading traffic settings…</p>;
  }

  if (!identityAddress) {
    return (
      <div className={cardClass}>
        <div className="flex items-start gap-3">
          <UserCircleIcon className="h-6 w-6 dark:text-claude-darkTextSecondary text-claude-textSecondary shrink-0 mt-0.5" />
          <div>
            <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-1">
              Create your identity first
            </h4>
            <p className={hintClass}>
              Traffic accounts are bound to your local user identity. Create or import an identity
              in the User tab, then come back to enable traffic mode and recharge.
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
          Gas fee payment mode
        </h4>
        <p className={`${hintClass} mb-3`}>
          Choose how on-chain writes are paid. Traffic mode lets the sponsor service pay gas from
          your traffic balance; self-pay spends each MetaBot&apos;s own SPACE.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {([
            { value: 'selfpay', title: 'Self-pay', desc: 'Each MetaBot pays its own gas' },
            { value: 'traffic', title: 'Traffic', desc: 'Sponsor pays from your traffic balance' },
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
            <span className={labelClass}>When traffic is unavailable or insufficient</span>
            <div className="grid grid-cols-2 gap-2 mt-1.5">
              {([
                { value: 'selfpay', title: 'Fall back to self-pay', desc: 'Writes keep going, paid by the MetaBot' },
                { value: 'strict', title: 'Strict mode', desc: 'Fail the write with an error instead' },
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
          <p className={`${hintClass} mt-2`}>Creating the traffic account and binding local MetaBot addresses…</p>
        )}
        {bindState === 'done' && bindSummary && (
          <p className="text-xs text-claude-accent mt-2">
            Bound {bindSummary.boundCount} address{bindSummary.boundCount === 1 ? '' : 'es'} to your traffic account
            {bindSummary.conflictCount > 0 ? ` (${bindSummary.conflictCount} already bound elsewhere)` : ''}.
          </p>
        )}
        {bindState === 'error' && (
          <p className="text-xs text-red-500 mt-2">{bindError || 'Account setup failed.'}</p>
        )}
      </div>

      {/* Balance */}
      <div className={cardClass}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <span className={labelClass}>Traffic balance</span>
            <div className="flex items-baseline gap-2 mt-1">
              <span
                className="text-2xl font-bold tabular-nums dark:text-claude-darkText text-claude-text"
                title={balance ? formatBytesExact(balance.balanceBytes) : undefined}
              >
                {balance ? formatMb(balance.balanceBytes) : '—'}
              </span>
              {balanceLoading && <ArrowPathIcon className="h-4 w-4 animate-spin dark:text-claude-darkTextSecondary text-claude-textSecondary" />}
            </div>
            {balance && (
              <p className={`${hintClass} mt-1`}>
                Reserved {formatMb(balance.reservedBytes)} · Lifetime used {formatMb(balance.spentBytesTotal)}
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
              Refresh
            </button>
            <button
              type="button"
              className={primaryButtonClass}
              onClick={openRecharge}
              disabled={rechargeStage !== 'hidden'}
            >
              <span className="inline-flex items-center gap-1">
                <BoltIcon className="h-4 w-4" />
                Recharge
              </span>
            </button>
          </div>
        </div>
        {balanceError && (
          <div className="flex items-center gap-2 mt-3">
            <p className="text-xs text-red-500 flex-1">{balanceError}</p>
            <button type="button" className={ghostButtonClass} onClick={() => refreshBalance(true)}>
              Retry
            </button>
          </div>
        )}
        {balance && balance.balanceBytes < LOW_BALANCE_BYTES && (
          <div className="flex items-center gap-2 mt-3 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2">
            <ExclamationTriangleIcon className="h-4 w-4 text-amber-500 shrink-0" />
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Traffic balance is below 5 MB. Recharge soon to keep traffic-mode writes flowing.
            </p>
          </div>
        )}
      </div>

      {/* Recharge */}
      {rechargeStage !== 'hidden' && (
        <div className={cardClass}>
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text">Recharge traffic</h4>
            <button type="button" className={ghostButtonClass} onClick={closeRecharge}>
              Close
            </button>
          </div>

          {(rechargeStage === 'plans' || rechargeStage === 'creating') && (
            <div>
              {plansLoading && <p className={hintClass}>Loading pricing plans…</p>}
              {plansError && (
                <div className="flex items-center gap-2">
                  <p className="text-xs text-red-500 flex-1">{plansError}</p>
                  <button type="button" className={ghostButtonClass} onClick={loadPlans}>
                    Retry
                  </button>
                </div>
              )}
              {!plansLoading && !plansError && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {plans.map((plan) => {
                    const selected = plan.planId === selectedPlanId;
                    return (
                      <button
                        key={plan.planId}
                        type="button"
                        onClick={() => setSelectedPlanId(plan.planId)}
                        className={`flex flex-col items-center py-2.5 px-2 rounded-xl border-2 transition-all cursor-pointer ${
                          selected
                            ? 'border-claude-accent bg-claude-accent/5 dark:bg-claude-accent/10'
                            : 'dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg hover:border-claude-accent/40'
                        }`}
                      >
                        <span className={`text-sm font-bold ${selected ? 'text-claude-accent' : 'dark:text-claude-darkText text-claude-text'}`}>
                          ¥{plan.payAmount}
                        </span>
                        <span className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                          {formatMb(plan.trafficBytes)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="flex justify-end mt-3">
                <button
                  type="button"
                  className={primaryButtonClass}
                  onClick={handleCreateOrder}
                  disabled={!selectedPlan || rechargeStage === 'creating'}
                >
                  {rechargeStage === 'creating' ? 'Creating order…' : 'Create order'}
                </button>
              </div>
            </div>
          )}

          {(rechargeStage === 'mockPay' || rechargeStage === 'confirming' || rechargeStage === 'polling') && activeOrder && (
            <div>
              <div className="rounded-lg border border-dashed border-amber-500/50 bg-amber-500/5 px-3 py-2 mb-3">
                <p className="text-xs font-semibold text-amber-600 dark:text-amber-400">
                  Mock payment (development)
                </p>
                <p className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary mt-0.5">
                  No real charge. Real payment gateways replace this step in Phase 4.
                </p>
              </div>
              <p className="text-sm dark:text-claude-darkText text-claude-text">
                Pay ¥{activeOrder.payAmount} for {formatMb(activeOrder.trafficBytes)} of traffic?
              </p>
              <p className={`${hintClass} mt-1`}>Order {activeOrder.orderId}</p>
              {rechargeStage === 'polling' && (
                <p className={`${hintClass} mt-2`}>Waiting for the credit to land…</p>
              )}
              <div className="flex justify-end gap-2 mt-3">
                <button
                  type="button"
                  className={ghostButtonClass}
                  onClick={() => {
                    stopPolling();
                    setRechargeStage('plans');
                    setActiveOrder(null);
                  }}
                  disabled={rechargeStage !== 'mockPay'}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={primaryButtonClass}
                  onClick={handleMockConfirm}
                  disabled={rechargeStage !== 'mockPay'}
                >
                  {rechargeStage === 'mockPay' ? 'Confirm mock payment' : 'Processing…'}
                </button>
              </div>
            </div>
          )}

          {rechargeStage === 'success' && activeOrder && (
            <div className="flex items-start gap-2">
              <CheckCircleIcon className="h-5 w-5 text-claude-accent shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                  {formatMb(activeOrder.trafficBytes)} credited to your traffic balance.
                </p>
                {balance && (
                  <p className={`${hintClass} mt-1`}>New balance: {formatMb(balance.balanceBytes)}</p>
                )}
                <div className="flex justify-end mt-2">
                  <button type="button" className={primaryButtonClass} onClick={closeRecharge}>
                    Done
                  </button>
                </div>
              </div>
            </div>
          )}

          {rechargeStage === 'failed' && (
            <div>
              <p className="text-xs text-red-500">{rechargeError || 'Recharge failed.'}</p>
              <div className="flex justify-end gap-2 mt-3">
                <button type="button" className={ghostButtonClass} onClick={closeRecharge}>
                  Close
                </button>
                <button
                  type="button"
                  className={primaryButtonClass}
                  onClick={() => {
                    setRechargeError('');
                    setActiveOrder(null);
                    setRechargeStage('plans');
                  }}
                >
                  Try again
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Usage */}
      <div>
        <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-2">Usage</h4>
        {summary && (
          <div className="grid grid-cols-3 gap-2 mb-3">
            {([
              { label: 'Today', bytes: summary.todayBytes },
              { label: 'Last 7 days', bytes: summary.weekBytes },
              { label: 'Last 30 days', bytes: summary.monthBytes },
            ]).map((item) => (
              <div key={item.label} className={`${cardClass} text-center`}>
                <div className="text-sm font-bold tabular-nums dark:text-claude-darkText text-claude-text">
                  {formatMb(item.bytes)}
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
                  <th className="py-1 pr-3 font-medium">Date (UTC)</th>
                  <th className="py-1 pr-3 font-medium">MetaBot</th>
                  <th className="py-1 pr-3 font-medium text-right">Traffic</th>
                  <th className="py-1 font-medium text-right">Writes</th>
                </tr>
              </thead>
              <tbody>
                {visibleDailyRows.map((row) => (
                  <tr key={`${row.date}|${row.botAddress}`} className="dark:text-claude-darkText text-claude-text">
                    <td className="py-1 pr-3 tabular-nums">{row.date}</td>
                    <td className="py-1 pr-3">{resolveBotLabel(row.botAddress)}</td>
                    <td className="py-1 pr-3 text-right tabular-nums" title={formatBytesExact(row.bytes)}>
                      {formatMb(row.bytes)}
                    </td>
                    <td className="py-1 text-right tabular-nums">{row.txCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          !usageError && <p className={hintClass}>No traffic usage recorded yet.</p>
        )}

        <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mt-4 mb-2">Ledger</h4>
        {ledgerEntries.length > 0 ? (
          <div className={`${cardClass} space-y-1.5`}>
            {ledgerEntries.map((entry) => (
              <div key={entry.id} className="flex items-center gap-3 text-xs">
                <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary tabular-nums shrink-0">
                  {entry.timestamp ? new Date(entry.timestamp).toISOString().slice(0, 10) : '—'}
                </span>
                <span className="dark:text-claude-darkText text-claude-text">
                  {LEDGER_DIRECTION_LABELS[entry.direction] ?? `Type ${entry.direction}`}
                </span>
                <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary truncate flex-1">
                  {entry.sourceType}{entry.remark ? ` · ${entry.remark}` : ''}
                </span>
                <span className="tabular-nums font-medium dark:text-claude-darkText text-claude-text shrink-0">
                  {formatAmountWithSign(entry.direction, entry.amountBytes)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          !ledgerError && <p className={hintClass}>No ledger entries yet.</p>
        )}
        {ledgerError && (
          <div className="flex items-center gap-2 mt-2">
            <p className="text-xs text-red-500 flex-1">{ledgerError}</p>
            <button type="button" className={ghostButtonClass} onClick={() => loadLedger(0)}>
              Retry
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
              {ledgerLoading ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default TrafficSettings;
