export type AppLanguage = 'zh' | 'en';

/**
 * Map an OS/Chromium locale to the app language.
 * Only Simplified Chinese locales use zh; Traditional Chinese and every other
 * locale fall back to English.
 *
 * Keep this logic in sync with src/renderer/services/i18n.ts.
 */
export function inferLanguageFromLocale(systemLocale: string): AppLanguage {
  const normalized = String(systemLocale || '').trim().replace(/_/g, '-').toLowerCase();
  if (!normalized) {
    return 'en';
  }

  const tags = normalized.split('-').filter(Boolean);
  if (tags[0] !== 'zh') {
    return 'en';
  }

  if (tags.includes('hant') || tags[1] === 'tw' || tags[1] === 'hk' || tags[1] === 'mo') {
    return 'en';
  }

  return 'zh';
}
