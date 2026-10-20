/**
 * Installs the mobile mock bridge (REQ-E-8).
 *
 * Must run before any module touches `window.electron` or a renderer
 * service imports (see src/mobile/app/main.tsx, which dynamically imports
 * the app bootstrap only after this returns). Enabled only when
 * VITE_MOBILE_MOCK=1; otherwise it leaves `window.electron` unset so the
 * failure is loud instead of silently running against an empty surface.
 */

import { createMobileMockBridge } from './mockBridge';
import type { IdbotsMobileOs, IdbotsMobileShell, MobileMockBridge } from './types';

function detectOs(): IdbotsMobileOs {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  return 'web';
}

function detectShell(): IdbotsMobileShell {
  const w = typeof window !== 'undefined' ? (window as unknown as Record<string, unknown>) : {};
  const capacitor = w.Capacitor as { isNativePlatform?: () => boolean } | undefined;
  if (typeof capacitor?.isNativePlatform === 'function' && capacitor.isNativePlatform()) {
    return 'capacitor';
  }
  const standalone = typeof navigator !== 'undefined' ? (navigator as { standalone?: boolean }).standalone : false;
  const displayModeStandalone =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(display-mode: standalone)').matches
      : false;
  if (standalone === true || displayModeStandalone) {
    return 'pwa';
  }
  return 'browser';
}

export function isMobileMockEnabled(): boolean {
  return import.meta.env.VITE_MOBILE_MOCK === '1';
}

export function installMockBridge(): MobileMockBridge | null {
  if (!isMobileMockEnabled()) {
    return null;
  }
  const bridge = createMobileMockBridge();
  window.electron = bridge.electron;
  window.idbotsMobile = {
    isMobile: true,
    os: detectOs(),
    shell: detectShell(),
    mock: bridge.control,
  };
  return bridge;
}
