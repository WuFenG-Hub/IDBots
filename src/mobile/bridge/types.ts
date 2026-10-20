/**
 * Shared types for the mobile bridge (mock now, real gateway shim in T3).
 *
 * The mock bridge (REQ-E-8) backs `window.electron` with fixtures and timers
 * so the mobile UI and its Playwright suite can run without a tenant. The
 * real C2 gateway shim (T3) replaces the same `window.electron` surface, so
 * screens written against the mock need no changes.
 */

/** Connection lifecycle of the gateway client, mirrored into the UI banner. */
export type ConnectionState =
  | 'connecting'
  | 'online'
  | 'reconnecting'
  | 'offline'
  | 'upgrading';

export type IdbotsMobileOs = 'ios' | 'android' | 'web';

export type IdbotsMobileShell = 'pwa' | 'capacitor' | 'browser';

/** Client facts exposed next to `window.electron` (C2/REQ-E-3 shape). */
export interface IdbotsMobileInfo {
  isMobile: true;
  os: IdbotsMobileOs;
  shell: IdbotsMobileShell;
}

/**
 * C4 bundle plan (docs/cloud-mobile/01-interface-contracts.md, "Bundle
 * Plans"). `payAmount` is a decimal string, as in the C4 envelope.
 */
export interface BundlePlan {
  planId: string;
  name: string;
  nameEn: string;
  payCurrency: string;
  payAmount: string;
  trafficBytes: number;
  llmQuota: number;
  llmQuotaUnit: string;
  /** 1 = on sale. */
  status: number;
  sort: number;
  remark: string;
}

/**
 * C4 bundle order. `status`: 1 created, 2 paid, 3 credited, 4 closed (same
 * codes as traffic recharge orders).
 */
export interface BundleOrder {
  orderId: string;
  planId: string;
  payAmount: string;
  payCurrency: string;
  trafficBytes: number;
  llmQuota: number;
  status: number;
  gatewayParams: {
    qrCode: string;
    alipayOutTradeNo: string;
  };
  paidAt: number | null;
  creditedAt: number | null;
  expiresAt: number;
  createdAt: number;
}

/** C4 meters: the balance card data behind `bundle:getMeters`. */
export interface BundleMeters {
  /** Shape-compatible with the desktop `TrafficAccountInfo`. */
  traffic: {
    accountId: string;
    identityAddress: string;
    balanceBytes: number;
    reservedBytes: number;
    grantedBytesTotal: number;
    spentBytesTotal: number;
    status: number;
  };
  /** Shape-compatible with the C4 `GET /v2/assist/llm/quota` additions. */
  llm: {
    quotaTotal: number;
    quotaUsed: number;
    quotaRemaining: number;
    quotaFree: number;
    quotaPurchased: number;
    unit: 'tokens';
  };
}

/** Pending tool-permission request as returned by `mobile:permission:listPending`. */
export interface PendingPermissionRequest {
  sessionId: string;
  request: {
    sessionId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    requestId: string;
    toolUseId: string | null;
  };
  createdAt: number;
}

/**
 * Extension channels added by WS-A (docs/cloud-mobile/02-ipc-allowlist-v1.md,
 * "New Channels Added by WS-A"). They do not exist in `IElectronAPI` yet —
 * REQ-A-24 adds the matching preload methods — so the mock types them here
 * and hangs them off `window.electron` under `bundle` and `mobile`.
 */
export interface BundleChannelAPI {
  getPlans: () => Promise<{ success: boolean; plans?: BundlePlan[]; error?: string }>;
  createOrder: (input: { planId: string }) => Promise<{ success: boolean; order?: BundleOrder; error?: string }>;
  getOrder: (input: { orderId: string }) => Promise<{ success: boolean; order?: BundleOrder; error?: string }>;
  getMeters: () => Promise<{ success: boolean; meters?: BundleMeters; error?: string }>;
}

export interface MobileChannelAPI {
  permission: {
    listPending: () => Promise<{ success: boolean; pending?: PendingPermissionRequest[]; error?: string }>;
  };
  bootstrap: {
    status: () => Promise<{ success: boolean; onboarding?: Record<string, unknown>; error?: string }>;
  };
  file: {
    sign: (input: { path: string; disposition?: 'inline' | 'attachment' }) => Promise<{
      success: boolean;
      url?: string;
      expiresAt?: number;
      size?: number;
      mime?: string;
      error?: string;
    }>;
  };
}

/**
 * The full mock surface: the desktop `IElectronAPI` (referenced through the
 * global declaration in src/renderer/types/electron.d.ts) plus the WS-A
 * extension channels.
 */
export type MockElectronAPI = Window['electron'] & {
  bundle: BundleChannelAPI;
  mobile: MobileChannelAPI;
};

/** Offline rejection handed to invokes made while the mock is "disconnected". */
export interface OfflineError extends Error {
  code: 'OFFLINE';
  retryable: true;
}

/** Controls the mock exposes to the demo page and the tests. */
export interface MobileMockControl {
  /** Flips connection state online -> reconnecting -> online over the blackout delay. */
  simulateReconnect: () => void;
  getConnectionState: () => ConnectionState;
  /** URLs passed to shell:openExternal while http(s) (for test assertions). */
  getOpenedUrls: () => string[];
}

/** Timer/scenario knobs; tests shrink these to keep the suite fast. */
export interface MockBridgeOptions {
  /** Delay between streamed reply tokens. Default 40 ms. */
  streamTokenIntervalMs?: number;
  /** Order goes from status 1 (created) to 3 (credited) after this delay. Default 10 s. */
  orderCompleteDelayMs?: number;
  /** How long simulateReconnect() stays disconnected. Default 3 s. */
  reconnectBlackoutMs?: number;
  /** The scheduled-task demo run fires this long after bridge creation. Default 15 s. */
  scheduledRunDelayMs?: number;
  /** System locale behind appInfo.getSystemLocale. Default: detected. */
  systemLocale?: string;
}

export interface MobileMockBridge {
  electron: MockElectronAPI;
  connection: {
    getState: () => ConnectionState;
    onChange: (callback: (state: ConnectionState) => void) => () => void;
  };
  control: MobileMockControl;
  /** Tears down pending timers; call in tests to avoid open handles. */
  destroy: () => void;
}
