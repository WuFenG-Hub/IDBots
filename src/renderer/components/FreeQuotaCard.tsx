import React, { useCallback, useEffect, useState } from 'react';
import { i18nService } from '../services/i18n';
import { enableFreeQuotaManually } from '../services/llmFreeQuotaBootstrap';
import { isFreeProviderConfigured, LLM_FREE_PROVIDER_KEY } from '../services/llmFreeQuotaGate.js';
import type { AppConfig } from '../config';

interface FreeQuotaCardProps {
  providers: NonNullable<AppConfig['providers']>;
  /** Called after a successful manual enable so the parent can reload config/redux. */
  onProvisioned: () => void;
}

interface QuotaState {
  loading: boolean;
  quotaTotal: number;
  quotaUsed: number;
  quotaRemaining: number;
  unavailable: boolean;
}

const INITIAL_QUOTA: QuotaState = {
  loading: true,
  quotaTotal: 0,
  quotaUsed: 0,
  quotaRemaining: 0,
  unavailable: false,
};

const formatTokenCount = (value: number): string => new Intl.NumberFormat().format(Math.max(0, Math.floor(value)));

/**
 * Free LLM quota card for the Model settings tab. Shows the remaining free
 * quota of the built-in `metaid-free` provider when provisioned, or an
 * enable button (manual opt-in) when it is not.
 */
const FreeQuotaCard: React.FC<FreeQuotaCardProps> = ({ providers, onProvisioned }) => {
  const provider = providers[LLM_FREE_PROVIDER_KEY];
  const configured = isFreeProviderConfigured(provider);
  const [quota, setQuota] = useState<QuotaState>(INITIAL_QUOTA);
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);

  const loadQuota = useCallback(async (apiKey: string, forceRefresh: boolean) => {
    setQuota((prev) => ({ ...prev, loading: true }));
    try {
      const response = await window.electron.llmRelay.getQuota({ apiKey, forceRefresh });
      if (response?.success && response.quota) {
        setQuota({
          loading: false,
          quotaTotal: response.quota.quotaTotal,
          quotaUsed: response.quota.quotaUsed,
          quotaRemaining: response.quota.quotaRemaining,
          unavailable: false,
        });
      } else {
        setQuota({ ...INITIAL_QUOTA, loading: false, unavailable: true });
      }
    } catch {
      setQuota({ ...INITIAL_QUOTA, loading: false, unavailable: true });
    }
  }, []);

  useEffect(() => {
    if (configured && provider.apiKey) {
      void loadQuota(provider.apiKey, false);
    }
  }, [configured, provider.apiKey, loadQuota]);

  const handleEnable = useCallback(async () => {
    setEnabling(true);
    setEnableError(null);
    const result = await enableFreeQuotaManually();
    setEnabling(false);
    if (result.success) {
      onProvisioned();
    } else {
      setEnableError(result.error ?? 'unknown error');
    }
  }, [onProvisioned]);

  const remainingRatio = quota.quotaTotal > 0 ? quota.quotaRemaining / quota.quotaTotal : 0;
  const exhausted = configured && !quota.loading && !quota.unavailable && quota.quotaRemaining <= 0;
  const runningLow = configured && !quota.loading && !quota.unavailable && !exhausted && remainingRatio < 0.1;

  return (
    <div className="mb-2 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium dark:text-claude-darkText text-claude-text">
          {i18nService.t('freeQuotaTitle')}
        </span>
        {configured && (
          <button
            type="button"
            onClick={() => void loadQuota(provider.apiKey, true)}
            disabled={quota.loading}
            className="text-[11px] text-claude-accent hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {i18nService.t('freeQuotaRefresh')}
          </button>
        )}
      </div>

      {configured ? (
        <div className="mt-2 space-y-1.5">
          {quota.unavailable ? (
            <p className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('freeQuotaUnavailable')}
            </p>
          ) : (
            <>
              <div className="h-1.5 w-full rounded-full dark:bg-claude-darkBorder bg-claude-border overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${exhausted ? 'bg-red-500' : runningLow ? 'bg-amber-500' : 'bg-claude-accent'}`}
                  style={{ width: `${Math.max(0, Math.min(100, remainingRatio * 100))}%` }}
                />
              </div>
              <p className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('freeQuotaUsedOf')
                  .replace('{used}', formatTokenCount(quota.quotaUsed))
                  .replace('{total}', formatTokenCount(quota.quotaTotal))}
              </p>
              {exhausted && (
                <p className="text-[11px] text-red-500">{i18nService.t('freeQuotaExhausted')}</p>
              )}
              {runningLow && (
                <p className="text-[11px] text-amber-500">{i18nService.t('freeQuotaLowWarning')}</p>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="mt-2 space-y-1.5">
          <p className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('freeQuotaEnableHint')}
          </p>
          <button
            type="button"
            onClick={() => void handleEnable()}
            disabled={enabling}
            className="btn-idchat-primary-filled inline-flex items-center justify-center px-2 py-1 text-[11px] font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {enabling ? i18nService.t('freeQuotaEnabling') : i18nService.t('freeQuotaEnable')}
          </button>
          {enableError && (
            <p className="text-[11px] text-red-500">
              {i18nService.t('freeQuotaEnableFailed').replace('{error}', enableError)}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default FreeQuotaCard;
