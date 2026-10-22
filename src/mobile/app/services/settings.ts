import { mobileI18n } from '../../i18n';
import type { MobileLanguage } from '../../i18n';
import { getMobileElectron } from '../appBridge';

/**
 * App-level preferences (language, theme) persisted in the R-store's
 * `app_config` key, mirroring the desktop shape. Reads/writes go through the
 * bridge so the T3 gateway shim keeps working unchanged; failures (e.g. the
 * store is offline) fall back to in-memory values.
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
  } catch {
    // Offline or no stored config: device locale + system theme stay active.
    applyThemeMode('system');
  }
}

async function persistSettings(patch: Partial<MobileAppConfig>): Promise<void> {
  try {
    const current = ((await getMobileElectron().store.get('app_config')) as MobileAppConfig | null) ?? {};
    await getMobileElectron().store.set('app_config', { ...current, ...patch });
  } catch {
    // Persistence is best-effort; the in-memory value still applies.
  }
}

export async function setLanguage(language: MobileLanguage): Promise<void> {
  mobileI18n.setLanguage(language);
  await persistSettings({ language });
}

export async function setThemeMode(mode: ThemeMode): Promise<void> {
  applyThemeMode(mode);
  await persistSettings({ theme: mode });
}
