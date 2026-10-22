import type { MobileMockControl } from './types';

/**
 * Global client-fact object installed next to `window.electron` by the mobile
 * bridge (C2/REQ-E-3). Desktop keeps building `window.electron`; mobile facts
 * live here so renderer code can tell the shells apart without sniffing.
 */
declare global {
  interface Window {
    idbotsMobile: {
      isMobile: true;
      os: 'ios' | 'android' | 'web';
      shell: 'pwa' | 'capacitor' | 'browser';
      /** Present only when the mock bridge (REQ-E-8) is installed. */
      mock?: MobileMockControl;
    };
  }
}

export {};
