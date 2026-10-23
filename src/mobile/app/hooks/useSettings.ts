import { useCallback, useEffect, useState } from 'react';
import type { MobileLanguage } from '../../i18n';
import { mobileI18n } from '../../i18n';
import { getThemeMode, onThemeChange, setLanguage, setThemeMode } from '../services/settings';
import type { ThemeMode } from '../services/settings';

/** Binds the persisted language/theme settings to React state. */
export function useSettings(): {
  language: MobileLanguage;
  theme: ThemeMode;
  changeLanguage: (language: MobileLanguage) => Promise<void>;
  changeTheme: (mode: ThemeMode) => Promise<void>;
} {
  const [language, setLanguageState] = useState<MobileLanguage>(() => mobileI18n.getLanguage());
  const [theme, setThemeState] = useState<ThemeMode>(() => getThemeMode());

  useEffect(
    () =>
      mobileI18n.subscribe(() => {
        setLanguageState(mobileI18n.getLanguage());
      }),
    [],
  );

  useEffect(() => onThemeChange(() => setThemeState(getThemeMode())), []);

  const changeLanguage = useCallback(async (next: MobileLanguage) => {
    await setLanguage(next);
    setLanguageState(next);
  }, []);

  const changeTheme = useCallback(async (mode: ThemeMode) => {
    await setThemeMode(mode);
    setThemeState(mode);
  }, []);

  return { language, theme, changeLanguage, changeTheme };
}
