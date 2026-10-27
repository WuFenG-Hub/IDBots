import { useCallback, useEffect, useRef, useState } from 'react';
import type { BundleMeters, BundlePlan } from '../../bridge/types';
import { getAppBridge, getMobileElectron } from '../appBridge';
import {
  isActiveOrder,
  isCurrentOrderOperation,
  isDefinitiveCreateRejection,
  isOrderExpired,
  isUncertainCreateBlocked,
  loadRechargeRecovery,
  makeCreationAttempt,
  persistCreationAttempt,
  persistRechargeOrder,
  type RechargeCreationAttempt,
  type RechargeOrderView,
} from '../services/rechargeRecovery';

export { isOrderExpired } from '../services/rechargeRecovery';
export type { RechargeOrderView } from '../services/rechargeRecovery';

export type RechargeStage = 'plans' | 'paying' | 'success' | 'expired' | 'closed' | 'error' | 'uncertain';
export type AlipayOpenState = 'opening' | 'offer-browser' | 'qr';

const POLL_INTERVAL_MS = 4_000;
const POLL_BUDGET_MS = 10 * 60_000;
const APP_OPEN_GRACE_MS = 1_800;

function initialStage(order: RechargeOrderView | null, attempt: RechargeCreationAttempt | null): RechargeStage {
  if (isActiveOrder(order)) return order?.qrCode ? 'paying' : 'uncertain';
  if (order?.status === 3) return 'success';
  if (order?.status === 4) return 'closed';
  if (order && isOrderExpired(order.expiresAt)) return 'expired';
  if (isUncertainCreateBlocked(attempt)) return 'uncertain';
  return 'plans';
}

export function useRecharge(onMetersRefreshed?: (meters: BundleMeters) => void): {
  plans: BundlePlan[];
  meters: BundleMeters | null;
  stage: RechargeStage;
  order: RechargeOrderView | null;
  creationAttempt: RechargeCreationAttempt | null;
  creationBlocked: boolean;
  alipayOpen: AlipayOpenState;
  buying: boolean;
  plansError: boolean;
  metersError: boolean;
  pollingDegraded: boolean;
  pollTimedOut: boolean;
  actionError: string | null;
  selectPlan: (planId: string) => Promise<void>;
  resumeOrder: () => void;
  checkStatus: () => void;
  openAlipayApp: () => void;
  openInBrowser: () => void;
  showQrFallback: () => void;
  backToPlans: () => void;
  refreshMeters: () => Promise<void>;
} {
  const [initialRecovery] = useState(loadRechargeRecovery);
  const [plans, setPlans] = useState<BundlePlan[]>([]);
  const [meters, setMeters] = useState<BundleMeters | null>(null);
  const [order, setOrder] = useState<RechargeOrderView | null>(initialRecovery.order);
  const [creationAttempt, setCreationAttempt] = useState<RechargeCreationAttempt | null>(initialRecovery.creationAttempt);
  const [stage, setStage] = useState<RechargeStage>(() => initialStage(initialRecovery.order, initialRecovery.creationAttempt));
  const [alipayOpen, setAlipayOpen] = useState<AlipayOpenState>('opening');
  const [buying, setBuying] = useState(false);
  const [plansError, setPlansError] = useState(false);
  const [metersError, setMetersError] = useState(false);
  const [pollingDegraded, setPollingDegraded] = useState(false);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const timersRef = useRef<{
    poll: ReturnType<typeof setInterval> | null;
    appOpen: ReturnType<typeof setTimeout> | null;
    deadline: number;
  }>({ poll: null, appOpen: null, deadline: 0 });
  const orderRef = useRef<RechargeOrderView | null>(initialRecovery.order);
  const attemptRef = useRef<RechargeCreationAttempt | null>(initialRecovery.creationAttempt);
  const generationRef = useRef(1);
  const buyingRef = useRef(false);
  const pollInFlightRef = useRef(false);
  const metersCallbackRef = useRef(onMetersRefreshed);
  metersCallbackRef.current = onMetersRefreshed;

  const commitOrder = useCallback((next: RechargeOrderView) => {
    orderRef.current = next;
    setOrder(next);
    persistRechargeOrder(next);
  }, []);

  const commitAttempt = useCallback((next: RechargeCreationAttempt | null) => {
    attemptRef.current = next;
    setCreationAttempt(next);
    persistCreationAttempt(next);
  }, []);

  const refreshMeters = useCallback(async () => {
    try {
      const result = await getMobileElectron().bundle.getMeters();
      if (!result?.success || !result.meters) throw new Error('meters unavailable');
      setMeters(result.meters);
      setMetersError(false);
      metersCallbackRef.current?.(result.meters);
    } catch {
      setMetersError(true);
    }
  }, []);

  const refreshPlans = useCallback(async () => {
    try {
      const result = await getMobileElectron().bundle.getPlans();
      if (!result?.success || !Array.isArray(result.plans)) throw new Error('plans unavailable');
      setPlans(result.plans);
      setPlansError(false);
    } catch {
      setPlansError(true);
    }
  }, []);

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
    (expectedOrderId: string, expectedGeneration: number, status: number) => {
      const current = orderRef.current;
      if (!current || !isCurrentOrderOperation(current, generationRef.current, expectedOrderId, expectedGeneration)) return;
      commitOrder({ ...current, status });
      if (status === 3 || status === 4) {
        stopPolling();
        stopAppOpenWatch();
      }
      if (status === 3) {
        setStage('success');
        void refreshMeters();
      } else if (status === 4) {
        setStage('closed');
      }
    },
    [commitOrder, refreshMeters, stopAppOpenWatch, stopPolling],
  );

  const pollOnce = useCallback(async () => {
    const current = orderRef.current;
    if (!current || pollInFlightRef.current) return;
    const expectedGeneration = generationRef.current;
    if (isOrderExpired(current.expiresAt)) {
      stopPolling();
      stopAppOpenWatch();
      setStage('expired');
      return;
    }
    pollInFlightRef.current = true;
    try {
      const result = await getMobileElectron().bundle.getOrder({ orderId: current.orderId });
      if (!result?.success || !result.order) throw new Error('order status unavailable');
      if (generationRef.current !== expectedGeneration) return;
      if (result.order.orderId !== current.orderId) throw new Error('order status identity mismatch');
      if (result.order.status === 3 || result.order.status === 4) {
        finishWithStatus(current.orderId, expectedGeneration, result.order.status);
      } else {
        const latest = orderRef.current;
        if (latest?.orderId === current.orderId && generationRef.current === expectedGeneration) {
          commitOrder({ ...latest, status: result.order.status });
        }
      }
      if (generationRef.current === expectedGeneration) setPollingDegraded(false);
    } catch {
      if (generationRef.current === expectedGeneration) setPollingDegraded(true);
    } finally {
      pollInFlightRef.current = false;
    }
  }, [commitOrder, finishWithStatus, stopAppOpenWatch, stopPolling]);

  const startPolling = useCallback(() => {
    stopPolling();
    setPollTimedOut(false);
    timersRef.current.deadline = Date.now() + POLL_BUDGET_MS;
    void pollOnce();
    timersRef.current.poll = setInterval(() => {
      if (Date.now() > timersRef.current.deadline) {
        stopPolling();
        setPollTimedOut(true);
        return;
      }
      void pollOnce();
    }, POLL_INTERVAL_MS);
  }, [pollOnce, stopPolling]);

  useEffect(() => {
    void refreshPlans();
    void refreshMeters();
    if (isActiveOrder(orderRef.current)) startPolling();
  }, [refreshMeters, refreshPlans, startPolling]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void refreshPlans();
      void refreshMeters();
      if (isActiveOrder(orderRef.current)) startPolling();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      stopPolling();
      stopAppOpenWatch();
    };
  }, [refreshMeters, refreshPlans, startPolling, stopAppOpenWatch, stopPolling]);

  useEffect(() => getAppBridge().connection.onChange((state) => {
    if (state !== 'online') return;
    void refreshPlans();
    void refreshMeters();
    if (isActiveOrder(orderRef.current)) startPolling();
  }), [refreshMeters, refreshPlans, startPolling]);

  const resumeOrder = useCallback(() => {
    const current = orderRef.current;
    if (!isActiveOrder(current)) return;
    setActionError(null);
    setStage(current?.qrCode ? 'paying' : 'uncertain');
    setAlipayOpen('opening');
    startPolling();
  }, [startPolling]);

  const selectPlan = useCallback(
    async (planId: string) => {
      if (isActiveOrder(orderRef.current)) {
        resumeOrder();
        return;
      }
      if (isUncertainCreateBlocked(attemptRef.current)) {
        setStage('uncertain');
        return;
      }
      const plan = plans.find((entry) => entry.planId === planId);
      if (!plan || buyingRef.current) return;
      buyingRef.current = true;
      setBuying(true);
      setActionError(null);
      commitAttempt(makeCreationAttempt(planId));
      try {
        const result = await getMobileElectron().bundle.createOrder({ planId });
        if (!result?.success) {
          if (isDefinitiveCreateRejection(result)) {
            commitAttempt(null);
            setActionError(result?.error || 'Order creation was rejected');
            setStage('error');
          } else {
            setStage('uncertain');
          }
          return;
        }
        const created = result.order;
        if (!created?.orderId || typeof created.orderId !== 'string') {
          setStage('uncertain');
          return;
        }
        const planMatches = created.planId === plan.planId;
        const expiryValid = Number.isFinite(created.expiresAt) && created.expiresAt > 0;
        const qrCode = planMatches && typeof created.gatewayParams?.qrCode === 'string'
          ? created.gatewayParams.qrCode.trim()
          : '';
        const nextOrder: RechargeOrderView = {
          orderId: created.orderId,
          qrCode,
          plan: {
            ...plan,
            planId: created.planId || plan.planId,
            payAmount: created.payAmount || plan.payAmount,
            payCurrency: created.payCurrency || plan.payCurrency,
            trafficBytes: created.trafficBytes || plan.trafficBytes,
            llmQuota: created.llmQuota || plan.llmQuota,
          },
          expiresAt: created.expiresAt,
          status: 1,
          createdAtMs: Date.now(),
        };
        generationRef.current += 1;
        commitOrder(nextOrder);
        commitAttempt(null);
        setStage(nextOrder.qrCode && expiryValid ? 'paying' : 'uncertain');
        setAlipayOpen('opening');
        startPolling();
      } catch {
        setStage('uncertain');
      } finally {
        buyingRef.current = false;
        setBuying(false);
      }
    },
    [commitAttempt, commitOrder, plans, resumeOrder, startPolling],
  );

  const openAlipayApp = useCallback(() => {
    const current = orderRef.current;
    if (!current?.qrCode || !isActiveOrder(current)) {
      if (current) setStage('uncertain');
      return;
    }
    setAlipayOpen('opening');
    window.location.href = `alipays://platformapi/startapp?saId=10000007&qrcode=${encodeURIComponent(current.qrCode)}`;
    stopAppOpenWatch();
    timersRef.current.appOpen = setTimeout(() => {
      if (document.visibilityState === 'visible') setAlipayOpen('offer-browser');
    }, APP_OPEN_GRACE_MS);
  }, [stopAppOpenWatch]);

  const openInBrowser = useCallback(() => {
    const current = orderRef.current;
    if (!current?.qrCode || !isActiveOrder(current)) return;
    window.open(current.qrCode, '_blank', 'noopener,noreferrer');
  }, []);

  const showQrFallback = useCallback(() => {
    if (orderRef.current?.qrCode) setAlipayOpen('qr');
    else setStage('uncertain');
  }, []);

  const backToPlans = useCallback(() => {
    stopPolling();
    stopAppOpenWatch();
    setStage('plans');
    setAlipayOpen('opening');
    setActionError(null);
    void refreshMeters();
  }, [refreshMeters, stopAppOpenWatch, stopPolling]);

  return {
    plans,
    meters,
    stage,
    order,
    creationAttempt,
    creationBlocked: isActiveOrder(order) || isUncertainCreateBlocked(creationAttempt),
    alipayOpen,
    buying,
    plansError,
    metersError,
    pollingDegraded,
    pollTimedOut,
    actionError,
    selectPlan,
    resumeOrder,
    checkStatus: () => {
      void refreshPlans();
      void refreshMeters();
      if (isActiveOrder(orderRef.current)) startPolling();
    },
    openAlipayApp,
    openInBrowser,
    showQrFallback,
    backToPlans,
    refreshMeters,
  };
}
