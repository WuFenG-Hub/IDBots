export const SIDEBAR_WIDTH_DEFAULT = 320;
export const SIDEBAR_WIDTH_MIN = 240;
export const SIDEBAR_WIDTH_MAX = 480;
export const SIDEBAR_WIDTH_STORAGE_KEY = 'idbots.sidebarWidth';

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)));
}

export function loadSidebarWidth(getItem: (key: string) => string | null): number {
  const raw = getItem(SIDEBAR_WIDTH_STORAGE_KEY);
  if (raw == null) return SIDEBAR_WIDTH_DEFAULT;
  return clampSidebarWidth(Number(raw));
}
