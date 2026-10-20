/**
 * Mobile-runtime detection for renderer code paths that must behave
 * differently in the mobile web app (REQ-A-25).
 *
 * The WS-E mobile shim (not built yet) will expose the desktop preload API
 * over the C2 gateway and marks itself by setting
 * `window.__IDBOTS_MOBILE_SHIM__ = true` before the bundle loads — that
 * marker is the primary signal. Until the shim lands (and for any plain
 * browser pointing at a gateway-served build), the fallback derives the
 * runtime from the page protocol:
 *
 * - Desktop Electron renders from `file:` (production) or
 *   `http://127.0.0.1:5185` (vite dev server), and `window.electron` is the
 *   real preload bridge.
 * - The mobile web app is served over http(s) from the gateway/control-plane
 *   origin, so a NON-`file:` protocol while `window.electron` is absent means
 *   mobile web.
 *
 * No new IPC channel is involved — the frozen `02` allowlist stays untouched.
 */

const MOBILE_SHIM_MARKER = '__IDBOTS_MOBILE_SHIM__';

export function isMobileRuntime(): boolean {
  const shimMarker = (window as unknown as Record<string, unknown>)[MOBILE_SHIM_MARKER];
  if (typeof shimMarker === 'boolean') {
    return shimMarker;
  }
  const hasElectronBridge = typeof (window as unknown as { electron?: unknown }).electron !== 'undefined'
    && (window as unknown as { electron?: unknown }).electron != null;
  if (hasElectronBridge) {
    return false;
  }
  return window.location.protocol !== 'file:';
}
