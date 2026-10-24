import { useEffect, useState } from 'react';
import type { GatewayVersionMismatch } from '../../bridge/gatewayClient';
import { getAppBridge, hasAppBridge } from '../appBridge';
import type { TerminalBridgeState } from '../appBridge';

/**
 * Mirrors the real gateway's terminal state (REQ-E-2 close codes:
 * unauthorized / tenant-unavailable / too-many-devices / version-mismatch)
 * into React. Null on the mock bridge, which never enters a terminal state,
 * and whenever the app has no bridge at all.
 */
export function useTerminalBridgeState(): {
  terminal: TerminalBridgeState | null;
  versionMismatch: GatewayVersionMismatch | null;
} {
  const [terminal, setTerminal] = useState<TerminalBridgeState | null>(() =>
    hasAppBridge() ? (getAppBridge().gateway?.getTerminalState() ?? null) : null,
  );
  const [versionMismatch, setVersionMismatch] = useState<GatewayVersionMismatch | null>(() =>
    hasAppBridge() ? (getAppBridge().gateway?.getVersionMismatch() ?? null) : null,
  );

  useEffect(() => {
    if (!hasAppBridge()) return undefined;
    const gateway = getAppBridge().gateway;
    if (!gateway) return undefined;
    const offState = gateway.onTerminalChange(setTerminal);
    const offMismatch = gateway.onTerminalChange(() => setVersionMismatch(gateway.getVersionMismatch()));
    return () => {
      offState();
      offMismatch();
    };
  }, []);

  return { terminal, versionMismatch };
}
