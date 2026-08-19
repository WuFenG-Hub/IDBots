import { app } from 'electron';
import type { SqliteStore } from '../sqliteStore';
import { inferLanguageFromLocale, type AppLanguage } from './inferLanguageFromLocale';

export type { AppLanguage };
export { inferLanguageFromLocale };

type AppLanguageConfig = {
  language?: string;
  language_initialized?: boolean;
};

let storeGetter: (() => SqliteStore | null) | null = null;

export function setAppLanguageStoreGetter(getter: () => SqliteStore | null): void {
  storeGetter = getter;
}

export function getOsLocale(): string {
  try {
    const preferred = app.getPreferredSystemLanguages?.();
    if (Array.isArray(preferred) && preferred[0]) {
      return String(preferred[0]);
    }
  } catch {
    // Ignore and try the next locale source.
  }

  try {
    if (typeof app.getSystemLocale === 'function') {
      const locale = app.getSystemLocale();
      if (locale) {
        return locale;
      }
    }
  } catch {
    // Ignore and try Chromium locale.
  }

  try {
    return app.getLocale() || 'en';
  } catch {
    return 'en';
  }
}

export function getPersistedAppLanguage(): AppLanguage {
  try {
    const config = storeGetter?.()?.get<AppLanguageConfig>('app_config');
    if (config?.language === 'en' || config?.language === 'zh') {
      if (config.language_initialized === true) {
        return config.language;
      }
      // First run still has defaultConfig.language = 'zh'. Detect OS instead of
      // treating that placeholder as an explicit Chinese choice.
      if (config.language === 'en') {
        return 'en';
      }
    }
  } catch {
    // Fall through to OS detection.
  }

  return inferLanguageFromLocale(getOsLocale());
}

export function tApp(zh: string, en: string): string {
  return getPersistedAppLanguage() === 'zh' ? zh : en;
}
