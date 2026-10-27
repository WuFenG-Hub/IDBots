import { mobileI18n } from '../../i18n';
import type { MobileLanguage } from '../../i18n';
import { getMobileElectron } from '../appBridge';

/**
 * App-level preferences (language, theme) persisted in the R-store's
 * `app_config` key, mirroring the desktop shape. Writes are field patches;
 * the gateway serializes them against the latest stored config. A setting is
 * applied locally only after the tenant confirms the write and readback.
 */

export type ThemeMode = 'light' | 'dark' | 'system';

export interface MobileAppConfig {
  language?: string;
  theme?: string;
  [key: string]: unknown;
}

const listeners = new Set<() => void>();
let themeMode: ThemeMode = 'system';

function normalizeTheme(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' ? value : 'system';
}

function syncDarkClass(): void {
  const prefersDark =
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', themeMode === 'dark' || (themeMode === 'system' && prefersDark));
}

export function getThemeMode(): ThemeMode {
  return themeMode;
}

export function applyThemeMode(mode: ThemeMode): void {
  themeMode = mode;
  syncDarkClass();
  for (const listener of [...listeners]) listener();
}

/** Re-evaluates the dark class when the OS scheme flips (system mode only). */
export function initSystemThemeListener(): void {
  if (typeof window.matchMedia !== 'function') return;
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncDarkClass);
  syncDarkClass();
}

export function onThemeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Hydrates language + theme from `app_config` before first paint. */
export async function loadSettings(): Promise<void> {
  mobileI18n.initFromDeviceLocale();
  try {
    const config = (await getMobileElectron().store.get('app_config')) as MobileAppConfig | null;
    if (config?.language === 'zh' || config?.language === 'en') {
      mobileI18n.setLanguage(config.language as MobileLanguage);
    }
    applyThemeMode(normalizeTheme(config?.theme));
  } catch (error) {
    console.warn('[mobile-settings] hydration failed; using device defaults', error);
    applyThemeMode('system');
  }
}

async function persistSettings(patch: Partial<MobileAppConfig>): Promise<void> {
  await getMobileElectron().store.set('app_config', patch);
  const saved = (await getMobileElectron().store.get('app_config')) as MobileAppConfig | null;
  for (const [key, value] of Object.entries(patch)) {
    if (saved?.[key] !== value) {
      throw new Error(`Settings save could not be confirmed for ${key}`);
    }
  }
}

export async function setLanguage(language: MobileLanguage): Promise<void> {
  await persistSettings({ language });
  mobileI18n.setLanguage(language);
}

export async function setThemeMode(mode: ThemeMode): Promise<void> {
  await persistSettings({ theme: mode });
  applyThemeMode(mode);
}
