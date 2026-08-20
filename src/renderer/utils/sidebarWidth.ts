export type SidebarWidthMode = 'home' | 'browser';

export const SIDEBAR_WIDTH_HOME_DEFAULT = 320;
export const SIDEBAR_WIDTH_BROWSER_DEFAULT = 400;
export const SIDEBAR_WIDTH_MIN = 240;
export const SIDEBAR_WIDTH_MAX = 480;

const LEGACY_STORAGE_KEY = 'idbots.sidebarWidth';
const STORAGE_KEYS: Record<SidebarWidthMode, string> = {
  home: 'idbots.sidebarWidth.home',
  browser: 'idbots.sidebarWidth.browser',
};

export function defaultSidebarWidth(mode: SidebarWidthMode): number {
  return mode === 'browser' ? SIDEBAR_WIDTH_BROWSER_DEFAULT : SIDEBAR_WIDTH_HOME_DEFAULT;
}

export function sidebarWidthStorageKey(mode: SidebarWidthMode): string {
  return STORAGE_KEYS[mode];
}

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return defaultSidebarWidth('home');
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)));
}

/**
 * Load the persisted width for a surface mode. Bot Home and Bot Internet keep
 * independent widths so each surface restores its own comfortable size on
 * switch. A legacy single-key value (pre per-mode) seeds the home width.
 */
export function loadSidebarWidth(getItem: (key: string) => string | null, mode: SidebarWidthMode): number {
  const raw = getItem(STORAGE_KEYS[mode]);
  if (raw != null) return clampSidebarWidth(Number(raw));
  if (mode === 'home') {
    const legacy = getItem(LEGACY_STORAGE_KEY);
    if (legacy != null) return clampSidebarWidth(Number(legacy));
  }
  return defaultSidebarWidth(mode);
}
