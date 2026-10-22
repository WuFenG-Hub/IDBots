import { t } from '../../i18n';
import { formatBytes, formatCount } from '../format';
import { usePlansMeters } from '../hooks/usePlansMeters';

/** Plans/payment demo: fixture plans, a mock order that credits after 10 s, and the meters card. */
export function PlansDemo(): JSX.Element {
  const { plans, meters, order, buy, refreshMeters } = usePlansMeters();

  return (
    <div className="space-y-3">
      {meters ? (
        <div className="flex items-center justify-between rounded-xl bg-[var(--bg-main)] p-3">
          <div>
            <div className="text-sm font-medium text-[var(--text-primary)]">{t('mobile.demo.metersTitle')}</div>
            <div className="text-xs text-[var(--text-secondary)]">
              {t('mobile.demo.metersTraffic', { amount: formatBytes(meters.traffic.balanceBytes) })}
            </div>
            <div className="text-xs text-[var(--text-secondary)]">
              {t('mobile.demo.metersLlm', {
                amount: `${formatCount(meters.llm.quotaRemaining)} / ${formatCount(meters.llm.quotaTotal)} ${meters.llm.unit}`,
              })}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void refreshMeters()}
            className="rounded-full border border-[var(--border-color)] px-3 py-1 text-xs text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
          >
            {t('mobile.demo.metersRefresh')}
          </button>
        </div>
      ) : null}

      <ul className="space-y-2">
        {plans.map((plan) => (
          <li
            key={plan.planId}
            className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border-color)] p-3"
          >
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-[var(--text-primary)]">
                {plan.nameEn} · {plan.name}
              </div>
              <div className="text-xs text-[var(--text-secondary)]">
                {plan.payCurrency === 'CNY' ? `¥${plan.payAmount}` : `${plan.payAmount} ${plan.payCurrency}`} ·{' '}
                {formatBytes(plan.trafficBytes)} · {formatCount(plan.llmQuota)} {plan.llmQuotaUnit}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void buy(plan.planId)}
              className="shrink-0 rounded-xl bg-[var(--color-primary)] px-4 py-2 text-xs font-medium text-black"
            >
              {t('mobile.demo.buy')}
            </button>
          </li>
        ))}
      </ul>

      {order ? (
        <div className="rounded-xl border border-[var(--border-color)] p-3">
          <div className="mb-1 text-sm font-medium text-[var(--text-primary)]">
            {order.status === 3
              ? t('mobile.demo.orderCredited')
              : order.status === 1
                ? t('mobile.demo.orderWaiting')
                : t('mobile.demo.orderCreated')}
          </div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">
            {t('mobile.demo.payUrl')}
          </div>
          <div className="break-all rounded-lg bg-[var(--bg-main)] p-2 font-mono text-[11px] text-[var(--text-primary)]">
            {order.qrCode}
          </div>
        </div>
      ) : null}
    </div>
  );
}
