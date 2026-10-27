import { XMarkIcon } from '@heroicons/react/24/outline';
import { useEffect } from 'react';
import { t } from '../../i18n';
import type { BundlePlan } from '../../bridge/types';
import { useRecharge } from '../hooks/useRecharge';
import { isActiveOrder } from '../services/rechargeRecovery';
import { formatBytes, formatCount } from '../format';
import { Section } from '../components/Section';
import { QrCanvas } from './recharge/QrCanvas';

function PlanCard(props: { plan: BundlePlan; disabled: boolean; onSelect: () => void }): JSX.Element {
  const { plan } = props;
  return (
    <button
      type="button"
      onClick={props.onSelect}
      disabled={props.disabled}
      className="flex min-h-[64px] w-full items-center justify-between gap-3 rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)] px-4 py-3 text-left active:bg-[var(--bg-hover)] disabled:opacity-40"
    >
      <div className="min-w-0">
        <p className="text-[15px] font-medium text-[var(--text-primary)]">{plan.nameEn || plan.name}</p>
        <p className="text-xs text-[var(--text-secondary)]">
          {t('mobile.recharge.trafficAmount', { amount: formatBytes(plan.trafficBytes) })}
          {` · ${t('mobile.recharge.llmAmount', { amount: `${formatCount(plan.llmQuota)} ${plan.llmQuotaUnit}` })}`}
        </p>
      </div>
      <span className="shrink-0 text-[15px] font-semibold text-[var(--text-primary)]">
        {`${plan.payCurrency} ${plan.payAmount}`}
      </span>
    </button>
  );
}

function StatusMessage(props: { degraded: boolean; timedOut: boolean; onCheck: () => void }): JSX.Element | null {
  if (!props.degraded && !props.timedOut) return null;
  return (
    <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3" data-testid="recharge-poll-degraded">
      <p className="text-xs text-amber-800">
        {t(props.timedOut ? 'mobile.recharge.pollTimedOut' : 'mobile.recharge.pollDegraded')}
      </p>
      <button type="button" onClick={props.onCheck} className="mt-1 min-h-[44px] text-sm font-medium text-amber-900">
        {t('mobile.recharge.checkStatus')}
      </button>
    </div>
  );
}

export default function RechargeScreen(props: { onClose: () => void; onMetersUpdated?: () => void }): JSX.Element {
  const recharge = useRecharge(() => props.onMetersUpdated?.());
  const { stage, order, alipayOpen, meters } = recharge;
  const activeOrder = isActiveOrder(order);

  useEffect(() => {
    if (stage === 'paying' && order?.qrCode) recharge.openAlipayApp();
  }, [stage, order?.orderId, order?.qrCode, recharge.openAlipayApp]);

  return (
    <div className="flex h-full flex-col bg-[var(--bg-main)]">
      <div
        className="flex shrink-0 items-center justify-between border-b border-[var(--border-color)] bg-[var(--bg-panel)] px-2 py-1.5"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 6px)' }}
      >
        <h1 className="text-base font-semibold text-[var(--text-primary)]">{t('mobile.recharge.title')}</h1>
        <button
          type="button"
          onClick={props.onClose}
          aria-label={t('mobile.common.close')}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
        >
          <XMarkIcon className="h-6 w-6" aria-hidden />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {recharge.metersError ? (
          <p className="mb-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800" data-testid="recharge-meters-error">
            {t('mobile.recharge.metersFailed')}
          </p>
        ) : null}

        {stage === 'plans' || stage === 'error' ? (
          <div className="space-y-3">
            {activeOrder && order ? (
              <div className="rounded-2xl border border-[var(--color-primary)] bg-[var(--bg-panel)] p-4" data-testid="recharge-pending-order">
                <p className="text-sm font-semibold text-[var(--text-primary)]">{t('mobile.recharge.pendingTitle')}</p>
                <p className="mt-1 text-xs text-[var(--text-secondary)]">
                  {`${order.plan.payCurrency} ${order.plan.payAmount} · ${t('mobile.recharge.expiresAt', { time: new Date(order.expiresAt * 1000).toLocaleString() })}`}
                </p>
                <button
                  type="button"
                  onClick={recharge.resumeOrder}
                  className="mt-3 min-h-[44px] w-full rounded-xl bg-[var(--color-primary)] py-2 text-sm font-medium text-black"
                >
                  {t('mobile.recharge.resumeOrder')}
                </button>
              </div>
            ) : null}
            {recharge.creationAttempt ? (
              <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4" data-testid="recharge-uncertain-attempt">
                <p className="text-sm font-semibold text-amber-800">{t('mobile.recharge.uncertainTitle')}</p>
                <p className="mt-1 text-xs text-amber-800">
                  {t('mobile.recharge.uncertainCreateBody', { time: new Date(recharge.creationAttempt.retryAfterMs).toLocaleString() })}
                </p>
                <button
                  type="button"
                  onClick={() => void recharge.selectPlan(recharge.creationAttempt!.planId)}
                  className="mt-2 min-h-[44px] text-sm font-medium text-amber-900"
                >
                  {t('mobile.recharge.reviewUncertain')}
                </button>
              </div>
            ) : null}
            <Section title={t('mobile.recharge.plansTitle')}>
              <div className="space-y-2">
                {recharge.plans.map((plan) => (
                  <PlanCard
                    key={plan.planId}
                    plan={plan}
                    disabled={recharge.buying || recharge.creationBlocked}
                    onSelect={() => void recharge.selectPlan(plan.planId)}
                  />
                ))}
                {!recharge.plans.length && !recharge.plansError ? (
                  <p className="py-3 text-sm text-[var(--text-secondary)]">{t('mobile.common.loading')}</p>
                ) : null}
              </div>
            </Section>
            {recharge.plansError ? (
              <div className="rounded-xl border border-amber-300 bg-amber-50 p-3">
                <p className="text-xs text-amber-800">{t('mobile.recharge.plansFailed')}</p>
                <button type="button" onClick={recharge.checkStatus} className="min-h-[44px] text-sm font-medium text-amber-900">
                  {t('mobile.common.retry')}
                </button>
              </div>
            ) : null}
            {stage === 'error' ? (
              <div className="rounded-2xl border border-red-300 bg-red-50 p-3" data-testid="recharge-create-error">
                <p className="text-sm font-semibold text-red-700">{t('mobile.recharge.errorTitle')}</p>
                {recharge.actionError ? <p className="mt-1 text-xs text-red-700">{recharge.actionError}</p> : null}
                <button
                  type="button"
                  onClick={recharge.backToPlans}
                  className="mt-2 min-h-[44px] w-full rounded-xl bg-[var(--color-primary)] py-2 text-sm font-medium text-black active:opacity-80"
                >
                  {t('mobile.common.retry')}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {stage === 'uncertain' ? (
          <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4" data-testid="recharge-uncertain">
            <p className="text-sm font-semibold text-amber-800">{t('mobile.recharge.uncertainTitle')}</p>
            <p className="mt-2 text-sm text-amber-800">
              {t(order ? 'mobile.recharge.uncertainOrderBody' : 'mobile.recharge.uncertainCreateBody', {
                time: recharge.creationAttempt ? new Date(recharge.creationAttempt.retryAfterMs).toLocaleString() : '',
              })}
            </p>
            {order ? <StatusMessage degraded={recharge.pollingDegraded} timedOut={recharge.pollTimedOut} onCheck={recharge.checkStatus} /> : null}
            <button
              type="button"
              onClick={order?.qrCode ? recharge.resumeOrder : recharge.checkStatus}
              className="mt-3 min-h-[44px] w-full rounded-xl bg-amber-700 py-2 text-sm font-medium text-white"
            >
              {t(order?.qrCode ? 'mobile.recharge.resumeOrder' : 'mobile.recharge.checkStatus')}
            </button>
            <button
              type="button"
              onClick={recharge.backToPlans}
              className="mt-2 min-h-[44px] w-full rounded-xl border border-amber-400 py-2 text-sm text-amber-900"
            >
              {t('mobile.recharge.backToPlans')}
            </button>
          </div>
        ) : null}

        {stage === 'paying' && order ? (
          <div className="space-y-3">
            <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-panel)] p-4" data-testid="recharge-paying" data-order-id={order.orderId}>
              <p className="mb-1 text-sm text-[var(--text-secondary)]">{t('mobile.recharge.orderCreated')}</p>
              <p className="mb-1 text-base font-semibold text-[var(--text-primary)]">
                {`${order.plan.payCurrency} ${order.plan.payAmount}`}
              </p>
              <p className="mb-3 text-xs text-[var(--text-secondary)]">
                {t('mobile.recharge.expiresAt', { time: new Date(order.expiresAt * 1000).toLocaleString() })}
              </p>

              {alipayOpen === 'opening' ? (
                <div className="flex flex-col items-center gap-2 py-3">
                  <p className="text-sm text-[var(--text-primary)]">{t('mobile.recharge.alipayOpening')}</p>
                  <span className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--border-color)] border-t-[var(--color-primary)]" aria-hidden />
                </div>
              ) : null}

              {alipayOpen === 'offer-browser' ? (
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium text-[var(--text-primary)]">{t('mobile.recharge.alipayFallbackTitle')}</p>
                  <p className="text-xs text-[var(--text-secondary)]">{t('mobile.recharge.alipayFallbackBody')}</p>
                  <button
                    type="button"
                    onClick={recharge.openInBrowser}
                    className="min-h-[44px] rounded-xl bg-[var(--color-primary)] py-2 text-sm font-medium text-black active:opacity-80"
                  >
                    {t('mobile.recharge.openBrowser')}
                  </button>
                  <button
                    type="button"
                    onClick={recharge.showQrFallback}
                    className="min-h-[44px] rounded-xl border border-[var(--border-color)] py-2 text-sm text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
                  >
                    {t('mobile.recharge.showQr')}
                  </button>
                </div>
              ) : null}

              {alipayOpen === 'qr' && order.qrCode ? (
                <div className="flex flex-col items-center gap-2 py-2" data-testid="recharge-qr">
                  <QrCanvas value={order.qrCode} />
                  <p className="text-xs text-[var(--text-secondary)]">{t('mobile.recharge.qrHint')}</p>
                </div>
              ) : null}

              <p className="mt-3 text-center text-xs text-[var(--text-secondary)]">{t('mobile.recharge.waiting')}</p>
              <StatusMessage degraded={recharge.pollingDegraded} timedOut={recharge.pollTimedOut} onCheck={recharge.checkStatus} />
            </div>
            <button
              type="button"
              onClick={recharge.backToPlans}
              className="min-h-[44px] w-full rounded-xl border border-[var(--border-color)] py-2 text-sm text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
            >
              {t('mobile.recharge.backToPlans')}
            </button>
          </div>
        ) : null}

        {stage === 'success' ? (
          <div className="space-y-3" data-testid="recharge-success">
            <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-4">
              <p className="mb-1 text-base font-semibold text-emerald-800">{t('mobile.recharge.successTitle')}</p>
              {order ? (
                <p className="text-sm text-emerald-700">
                  {t('mobile.recharge.successBody', {
                    traffic: formatBytes(order.plan.trafficBytes),
                    llm: `${formatCount(order.plan.llmQuota)} ${order.plan.llmQuotaUnit}`,
                  })}
                </p>
              ) : null}
            </div>
            <Section title={t('mobile.recharge.newMetersTitle')}>
              <div className="flex gap-3">
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
            </Section>
            <button
              type="button"
              onClick={recharge.backToPlans}
              className="min-h-[44px] w-full rounded-xl border border-[var(--border-color)] py-2 text-sm text-[var(--text-primary)]"
            >
              {t('mobile.recharge.backToPlans')}
            </button>
            <button
              type="button"
              onClick={props.onClose}
              className="min-h-[44px] w-full rounded-xl bg-[var(--color-primary)] py-2 text-sm font-medium text-black active:opacity-80"
            >
              {t('mobile.recharge.done')}
            </button>
          </div>
        ) : null}

        {stage === 'expired' || stage === 'closed' ? (
          <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-800">
              {t(stage === 'expired' ? 'mobile.recharge.expired' : 'mobile.recharge.closed')}
            </p>
            <button
              type="button"
              onClick={recharge.backToPlans}
              className="mt-3 min-h-[44px] w-full rounded-xl bg-[var(--color-primary)] py-2 text-sm font-medium text-black active:opacity-80"
            >
              {t('mobile.recharge.backToPlans')}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
