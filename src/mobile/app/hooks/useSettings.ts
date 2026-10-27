import { useCallback, useEffect, useState } from 'react';
import type { MobileLanguage } from '../../i18n';
import { mobileI18n } from '../../i18n';
import { getThemeMode, onThemeChange, setLanguage, setThemeMode } from '../services/settings';
import type { ThemeMode } from '../services/settings';

export interface SettingsSaveState {
  field: 'language' | 'theme' | null;
  status: 'idle' | 'saving' | 'saved' | 'error';
}

/** Binds the persisted language/theme settings to React state. */
export function useSettings(): {
  language: MobileLanguage;
  theme: ThemeMode;
  saveState: SettingsSaveState;
  changeLanguage: (language: MobileLanguage) => Promise<boolean>;
  changeTheme: (mode: ThemeMode) => Promise<boolean>;
} {
  const [language, setLanguageState] = useState<MobileLanguage>(() => mobileI18n.getLanguage());
  const [theme, setThemeState] = useState<ThemeMode>(() => getThemeMode());
  const [saveState, setSaveState] = useState<SettingsSaveState>({ field: null, status: 'idle' });

  useEffect(
    () =>
      mobileI18n.subscribe(() => {
        setLanguageState(mobileI18n.getLanguage());
      }),
    [],
  );

  useEffect(() => onThemeChange(() => setThemeState(getThemeMode())), []);

  const changeLanguage = useCallback(async (next: MobileLanguage) => {
    setSaveState({ field: 'language', status: 'saving' });
    try {
      await setLanguage(next);
      setLanguageState(next);
      setSaveState({ field: 'language', status: 'saved' });
      return true;
    } catch {
      setSaveState({ field: 'language', status: 'error' });
      return false;
    }
  }, []);

  const changeTheme = useCallback(async (mode: ThemeMode) => {
    setSaveState({ field: 'theme', status: 'saving' });
    try {
      await setThemeMode(mode);
      setThemeState(mode);
      setSaveState({ field: 'theme', status: 'saved' });
      return true;
    } catch {
      setSaveState({ field: 'theme', status: 'error' });
      return false;
    }
  }, []);

  return { language, theme, saveState, changeLanguage, changeTheme };
}
