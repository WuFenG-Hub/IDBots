import { useCallback, useEffect, useRef, useState } from 'react';
import type { BundleMeters, BundlePlan } from '../../bridge/types';
import { getMobileElectron } from '../appBridge';

/**
 * Recharge flow (REQ-E-15): plan list, C4 order creation, the three-tier
 * Alipay hand-off and status polling.
 *
 * Contract notes honored here (do not regress):
 *   - `createOrder` returns NO status: a fresh order is status 1 (created).
 *   - `getOrder` returns NO gatewayParams: the QR code is captured once at
 *     creation via functional setState and never re-fetched.
 *   - Polling runs every 4 s up to 10 min, plus an immediate poll whenever
 *     the page becomes visible again; status 3 = credited, 4 = closed.
 */

export type RechargeStage = 'plans' | 'paying' | 'success' | 'expired' | 'closed' | 'error';
export type AlipayOpenState = 'opening' | 'offer-browser' | 'qr';

export interface RechargeOrderView {
  orderId: string;
  qrCode: string;
  plan: BundlePlan;
  expiresAt: number;
}

const POLL_INTERVAL_MS = 4_000;
const POLL_BUDGET_MS = 10 * 60_000;
/** How long we wait for the Alipay app to open before offering fallbacks. */
const APP_OPEN_GRACE_MS = 1_800;

/**
 * Contract 01 §C4 sends `expiresAt` as Unix SECONDS (example value
 * 1760000000, docs/cloud-mobile/01-interface-contracts.md line 497), while
 * Date.now() is milliseconds — convert before comparing or every fresh order
 * is judged expired on the first poll.
 */
export function isOrderExpired(expiresAt: number, nowMs: number = Date.now()): boolean {
  return nowMs > expiresAt * 1000;
}

export function useRecharge(onMetersRefreshed?: (meters: BundleMeters) => void): {
  plans: BundlePlan[];
  meters: BundleMeters | null;
  stage: RechargeStage;
  order: RechargeOrderView | null;
  alipayOpen: AlipayOpenState;
  buying: boolean;
  selectPlan: (planId: string) => Promise<void>;
  openAlipayApp: () => void;
  openInBrowser: () => void;
  showQrFallback: () => void;
  backToPlans: () => void;
  refreshMeters: () => Promise<void>;
} {
  const [plans, setPlans] = useState<BundlePlan[]>([]);
  const [meters, setMeters] = useState<BundleMeters | null>(null);
  const [stage, setStage] = useState<RechargeStage>('plans');
  const [order, setOrder] = useState<RechargeOrderView | null>(null);
  const [alipayOpen, setAlipayOpen] = useState<AlipayOpenState>('opening');
  const [buying, setBuying] = useState(false);
  const timersRef = useRef<{
    poll: ReturnType<typeof setInterval> | null;
    appOpen: ReturnType<typeof setTimeout> | null;
    deadline: number;
  }>({ poll: null, appOpen: null, deadline: 0 });
  const orderRef = useRef<RechargeOrderView | null>(null);
  orderRef.current = order;

  const refreshMeters = useCallback(async () => {
    const result = await getMobileElectron().bundle.getMeters();
    if (result?.success && result.meters) {
      setMeters(result.meters);
      onMetersRefreshed?.(result.meters);
    }
  }, [onMetersRefreshed]);

  useEffect(() => {
    void (async () => {
      const result = await getMobileElectron().bundle.getPlans();
      if (result?.success && Array.isArray(result.plans)) {
        setPlans(result.plans);
      }
    })();
    void refreshMeters();
  }, [refreshMeters]);

  const stopPolling = useCallback(() => {
    if (timersRef.current.poll) {
      clearInterval(timersRef.current.poll);
      timersRef.current.poll = null;
    }
  }, []);

  const stopAppOpenWatch = useCallback(() => {
    if (timersRef.current.appOpen) {
      clearTimeout(timersRef.current.appOpen);
      timersRef.current.appOpen = null;
    }
  }, []);

  const finishWithStatus = useCallback(
    (status: number) => {
      stopPolling();
      stopAppOpenWatch();
      if (status === 3) {
        setStage('success');
        void refreshMeters();
      } else if (status === 4) {
        setStage('closed');
      }
    },
    [refreshMeters, stopPolling, stopAppOpenWatch],
  );

  const pollOnce = useCallback(async () => {
    const current = orderRef.current;
    if (!current) return;
    if (isOrderExpired(current.expiresAt)) {
      stopPolling();
      stopAppOpenWatch();
      setStage('expired');
      return;
    }
    try {
      const result = await getMobileElectron().bundle.getOrder({ orderId: current.orderId });
      if (result?.success && result.order && (result.order.status === 3 || result.order.status === 4)) {
        finishWithStatus(result.order.status);
      }
    } catch {
      // Offline tick: the next interval or visibility poll retries.
    }
  }, [finishWithStatus, stopAppOpenWatch, stopPolling]);

  const startPolling = useCallback(() => {
    stopPolling();
    timersRef.current.deadline = Date.now() + POLL_BUDGET_MS;
    timersRef.current.poll = setInterval(() => {
      if (Date.now() > timersRef.current.deadline) {
        stopPolling();
        return;
      }
      void pollOnce();
    }, POLL_INTERVAL_MS);
  }, [pollOnce, stopPolling]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && orderRef.current) {
        void pollOnce();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      stopPolling();
      stopAppOpenWatch();
    };
  }, [pollOnce, stopAppOpenWatch, stopPolling]);

  const selectPlan = useCallback(
    async (planId: string) => {
      const plan = plans.find((entry) => entry.planId === planId);
      if (!plan || buying) return;
      setBuying(true);
      try {
        const result = await getMobileElectron().bundle.createOrder({ planId });
        if (!result?.success || !result.order) {
          setStage('error');
          return;
        }
        const created = result.order;
        // C4: no status on a fresh order (status 1 by definition) and the QR
        // code exists only on this creation payload — capture it via the
        // functional setState and keep it for the whole payment flow.
        setOrder((prev) => ({
          orderId: created.orderId,
          qrCode: created.gatewayParams?.qrCode ?? prev?.qrCode ?? '',
          plan,
          expiresAt: created.expiresAt,
        }));
        setStage('paying');
        setAlipayOpen('opening');
        startPolling();
      } finally {
        setBuying(false);
      }
    },
    [buying, plans, startPolling],
  );

  const openAlipayApp = useCallback(() => {
    const current = orderRef.current;
    if (!current?.qrCode) return;
    setAlipayOpen('opening');
    window.location.href = `alipays://platformapi/startapp?saId=10000007&qrcode=${encodeURIComponent(current.qrCode)}`;
    stopAppOpenWatch();
    timersRef.current.appOpen = setTimeout(() => {
      // Still visible after the grace window: the app did not open.
      if (document.visibilityState === 'visible') {
        setAlipayOpen('offer-browser');
      }
    }, APP_OPEN_GRACE_MS);
  }, [stopAppOpenWatch]);

  const openInBrowser = useCallback(() => {
    const current = orderRef.current;
    if (!current?.qrCode) return;
    window.open(current.qrCode, '_blank', 'noopener,noreferrer');
  }, []);

  const showQrFallback = useCallback(() => setAlipayOpen('qr'), []);

  const backToPlans = useCallback(() => {
    stopPolling();
    stopAppOpenWatch();
    setOrder(null);
    setStage('plans');
    setAlipayOpen('opening');
    void refreshMeters();
  }, [refreshMeters, stopAppOpenWatch, stopPolling]);

  return {
    plans,
    meters,
    stage,
    order,
    alipayOpen,
    buying,
    selectPlan,
    openAlipayApp,
    openInBrowser,
    showQrFallback,
    backToPlans,
    refreshMeters,
  };
}
