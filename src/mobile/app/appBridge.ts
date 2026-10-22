import type { MobileMockBridge, MockElectronAPI } from '../bridge/types';

/**
 * Holds the installed mock bridge for the app demo (T1). T3 replaces this
 * with the real gateway client; hooks read the bridge here instead of
 * reaching into window.idbotsMobile so the swap stays localized.
 */

let appBridge: MobileMockBridge | null = null;

export function setAppBridge(bridge: MobileMockBridge | null): void {
  appBridge = bridge;
}

/** False in a production build before T3's real shim exists: show a
 * "not connected" screen rather than crashing on a missing bridge. */
export function hasAppBridge(): boolean {
  return appBridge !== null;
}

export function getAppBridge(): MobileMockBridge {
  if (!appBridge) {
    throw new Error('mobile bridge is not installed (run with VITE_MOBILE_MOCK=1)');
  }
  return appBridge;
}

/**
 * window.electron typed as the mock surface, including the WS-A extension
 * channels (`bundle`, `mobile`) that IElectronAPI does not declare yet
 * (REQ-A-24 adds them to the desktop preload). T3 swaps this for the shim.
 */
export function getMobileElectron(): MockElectronAPI {
  return window.electron as unknown as MockElectronAPI;
}
