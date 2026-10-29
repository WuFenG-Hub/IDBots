import type { IdbotsNativeBridge, MobileNativeCapabilities } from './idbotsNative';

const CAPABILITY_KEYS = [
  'camera',
  'photos',
  'files',
  'share',
  'appState',
  'backButton',
  'externalUrls',
  'secureScreen',
] as const;

const WEB_CAPABILITIES: MobileNativeCapabilities = Object.freeze({
  camera: false,
  photos: false,
  files: false,
  share: false,
  appState: false,
  backButton: false,
  externalUrls: false,
  secureScreen: false,
});

export interface MobileNativeAdapter {
  readonly isNative: boolean;
  getCapabilities(): MobileNativeCapabilities;
  openExternal(url: string): Promise<void>;
  onAppStateChange(callback: (active: boolean) => void): () => void;
  onBackButton(callback: () => boolean): () => void;
}

function nativeBridge(target: Window): IdbotsNativeBridge | null {
  try {
    if (target.Capacitor?.isNativePlatform?.() !== true) return null;
  } catch {
    return null;
  }
  const bridge = target.idbotsNative;
  if (bridge?.nativeBridgeVersion !== 1 || typeof bridge.getCapabilities !== 'function') return null;
  return bridge;
}

function readCapabilities(bridge: IdbotsNativeBridge | null): MobileNativeCapabilities {
  if (!bridge) return { ...WEB_CAPABILITIES };
  try {
    const value = bridge.getCapabilities();
    return Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, value?.[key] === true])) as unknown as MobileNativeCapabilities;
  } catch {
    return { ...WEB_CAPABILITIES };
  }
}

function approvedExternalUrl(value: string): { url: string; protocol: string } {
  const trimmed = value.trim();
  const parsed = new URL(trimmed);
  const allowed = parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'alipays:';
  if (!allowed || !parsed.host || parsed.username || parsed.password) throw new Error('External URL is not allowed');
  return { url: trimmed, protocol: parsed.protocol };
}

function openWithWebFallback(target: Window, url: string, protocol: string): void {
  if (protocol === 'alipays:') {
    target.location.assign(url);
    return;
  }
  target.open?.(url, '_blank', 'noopener,noreferrer');
}

function unavailable(): () => void {
  return () => undefined;
}

export function createNativeAdapter(target: Window): MobileNativeAdapter {
  const bridge = nativeBridge(target);
  const hasCapability = (key: keyof MobileNativeCapabilities): boolean => readCapabilities(bridge)[key];
  return {
    isNative: bridge !== null,
    getCapabilities: () => readCapabilities(bridge),
    openExternal: async (value) => {
      const { url, protocol } = approvedExternalUrl(value);
      if (bridge && hasCapability('externalUrls') && typeof bridge.openExternal === 'function') {
        await bridge.openExternal(url);
        return;
      }
      openWithWebFallback(target, url, protocol);
    },
    onAppStateChange: (callback) => {
      if (!bridge || !hasCapability('appState') || typeof bridge.onAppStateChange !== 'function') return unavailable();
      try {
        return bridge.onAppStateChange(callback);
      } catch {
        return unavailable();
      }
    },
    onBackButton: (callback) => {
      if (!bridge || !hasCapability('backButton') || typeof bridge.onBackButton !== 'function') return unavailable();
      try {
        return bridge.onBackButton(callback);
      } catch {
        return unavailable();
      }
    },
  };
}

let adapter: MobileNativeAdapter | null = null;

export function getNativeAdapter(): MobileNativeAdapter {
  if (!adapter) adapter = createNativeAdapter(window);
  return adapter;
}
