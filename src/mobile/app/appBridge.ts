import type { GatewayConnectionState, GatewayVersionMismatch } from '../bridge/gatewayClient';
import type { ConnectionState, MobileMockControl, MockElectronAPI } from '../bridge/types';

/**
 * The app-facing bridge facade (REQ-E-2/E-3 wiring). T1/T2 held the mock
 * bridge directly; T3 generalizes it so screens work against whichever
 * bridge installBridgeFirst installed, unchanged:
 *
 *   - mock path: wraps today's MobileMockBridge (control stays reachable
 *     through `mock` for the demo page and the e2e suite);
 *   - real path: adapts the C2 GatewayClient, mapping its state union onto
 *     the five-state banner ConnectionState and exposing the terminal states
 *     separately (below).
 */

/** The five banner states every bridge shares (mock and real). */
export interface AppBridgeConnection {
  getState: () => ConnectionState;
  onChange: (callback: (state: ConnectionState) => void) => () => void;
}

/**
 * Terminal gateway states (C2 close codes / welcome version guard) that have
 * dedicated full-screen UI instead of a banner:
 *   unauthorized        4001/4003 → navigate to /login
 *   tenant-unavailable  4013     → "your Bot is not available" + getMe poll
 *   too-many-devices    4009     → full-screen message
 *   version-mismatch             → "please update the app"
 */
export type TerminalBridgeState =
  | 'unauthorized'
  | 'tenant-unavailable'
  | 'too-many-devices'
  | 'version-mismatch';

/** Real-gateway extras the shell needs for the terminal-state screens. */
export interface RealGatewayHandle {
  getTerminalState: () => TerminalBridgeState | null;
  onTerminalChange: (callback: (state: TerminalBridgeState | null) => void) => () => void;
  getVersionMismatch: () => GatewayVersionMismatch | null;
  /** Fires after every successful (re)connect, first connect included. */
  onReconnected: (callback: () => void) => () => void;
  reconnectNow: () => void;
  close: () => void;
}

export interface AppBridge {
  electron: MockElectronAPI;
  connection: AppBridgeConnection;
  /** Present only when the mock bridge (REQ-E-8) is installed. */
  mock?: MobileMockControl;
  /** Present only when the real gateway client (REQ-E-3) is installed. */
  gateway?: RealGatewayHandle;
}

let appBridge: AppBridge | null = null;

export function setAppBridge(bridge: AppBridge | null): void {
  appBridge = bridge;
}

/** False only when neither mock nor real bridge installed: BridgeUnavailable. */
export function hasAppBridge(): boolean {
  return appBridge !== null;
}

export function getAppBridge(): AppBridge {
  if (!appBridge) {
    throw new Error('mobile bridge is not installed (run with VITE_MOBILE_MOCK=1 or a reachable gateway)');
  }
  return appBridge;
}

/**
 * window.electron typed as the app bridge surface, including the `mobile`
 * helper channels (`mobile.listPendingPermissions`, `mobile.getBootstrapStatus`)
 * that the generated IPC contract and both bridges implement.
 */
export function getMobileElectron(): MockElectronAPI {
  return window.electron as unknown as MockElectronAPI;
}

// ---------------------------------------------------------------------------
// State mapping (gateway client union → banner / terminal)
// ---------------------------------------------------------------------------

const TERMINAL_STATES: ReadonlySet<GatewayConnectionState> = new Set([
  'unauthorized',
  'tenant-unavailable',
  'too-many-devices',
  'version-mismatch',
]);

/**
 * Maps the gateway client's nine-state union onto the five banner states.
 * Terminal states have their own screens; where a banner is unavoidable the
 * mapping lands on 'offline' (per the gatewayClient docblock contract).
 */
export function toBannerState(state: GatewayConnectionState): ConnectionState {
  switch (state) {
    case 'connecting':
    case 'online':
    case 'reconnecting':
    case 'offline':
    case 'upgrading':
      return state;
    default:
      return 'offline';
  }
}

/** Terminal state for dedicated screens, or null while in a base state. */
export function toTerminalState(state: GatewayConnectionState): TerminalBridgeState | null {
  return TERMINAL_STATES.has(state) ? (state as TerminalBridgeState) : null;
}
