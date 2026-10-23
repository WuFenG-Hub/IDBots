import { getMobileElectron } from '../appBridge';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BundleMeters, BundlePlan } from '../../bridge/types';

/**
 * Plans + payment demo state (REQ-E-8): fixture plans from `bundle:getPlans`,
 * a mock Alipay order that credits after the bridge's 10 s delay, and the
 * balance meters that rise when crediting happens.
 */

export interface DemoOrderView {
  orderId: string;
  qrCode: string;
  status: number;
}

const POLL_INTERVAL_MS = 1000;

export function usePlansMeters(): {
  plans: BundlePlan[];
  meters: BundleMeters | null;
  order: DemoOrderView | null;
  buy: (planId: string) => Promise<void>;
  refreshMeters: () => Promise<void>;
} {
  const [plans, setPlans] = useState<BundlePlan[]>([]);
  const [meters, setMeters] = useState<BundleMeters | null>(null);
  const [order, setOrder] = useState<DemoOrderView | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshMeters = useCallback(async () => {
    const result = await getMobileElectron().bundle.getMeters();
    if (result?.success && result.meters) {
      setMeters(result.meters);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const result = await getMobileElectron().bundle.getPlans();
      if (result?.success && Array.isArray(result.plans)) {
        setPlans(result.plans);
      }
    })();
    void refreshMeters();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refreshMeters]);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const buy = useCallback(
    async (planId: string) => {
      const result = await getMobileElectron().bundle.createOrder({ planId });
      if (!result?.success || !result.order) return;
      // createOrder returns BundleOrderInfo: no status/paidAt yet — a fresh
      // order is status 1 (created) by definition (C4).
      const created = result.order;
      setOrder({ orderId: created.orderId, qrCode: created.gatewayParams.qrCode ?? '', status: 1 });
      stopPolling();
      pollRef.current = setInterval(() => {
        void (async () => {
          const latest = await getMobileElectron().bundle.getOrder({ orderId: created.orderId });
          if (!latest?.success || !latest.order) return;
          // BundleOrderStatusInfo carries no gatewayParams: the QR code is
          // returned once at creation and kept from there.
          setOrder((prev) => ({
            orderId: latest.order.orderId,
            qrCode: prev?.qrCode ?? '',
            status: latest.order.status,
          }));
          if (latest.order.status === 3 || latest.order.status === 4) {
            stopPolling();
            await refreshMeters();
          }
        })();
      }, POLL_INTERVAL_MS);
    },
    [refreshMeters],
  );

  return { plans, meters, order, buy, refreshMeters };
}
