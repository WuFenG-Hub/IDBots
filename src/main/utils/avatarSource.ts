/**
 * Avatar source helpers shared between main-process services.
 *
 * The upstream `@openagentinternet/agent-browser-core` profile fetcher turns
 * the on-chain "no avatar" marker `/content/` into an absolute URL by
 * prepending the P2P base (e.g. `https://so.metaid.io/content/`), which is a
 * 404 and leaks into stored peer profiles. This list mirrors the renderer guard
 * (`src/renderer/utils/avatarSource.ts`) so both layers agree on what counts as
 * "no avatar".
 */

const NO_AVATAR_MARKERS: readonly string[] = [
  '/content/',
  '/content',
  '/metafile-indexer/content',
  '/metafile-indexer/thumbnail',
  '/metafile-indexer/api/v1/files/content',
  '/metafile-indexer/api/v1/files/accelerate/content',
  '/metafile-indexer/api/v1/users/avatar/accelerate',
];

const isNoAvatarMarker = (value: string): boolean => {
  if (!value) return true;
  return NO_AVATAR_MARKERS.some((marker) => value === marker);
};

/**
 * True when `value` is a directly usable avatar source (an absolute `http(s)`
 * URL, a `data:`/`blob:` URL) and **not** a "no avatar" marker.
 */
export const isRenderableAvatarSource = (value: string | null | undefined): boolean => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return false;
  if (isNoAvatarMarker(normalized)) return false;
  if (/^https?:\/\//i.test(normalized)) {
    try {
      const parsed = new URL(normalized);
      const path = parsed.pathname.replace(/\/+$/, '');
      if (isNoAvatarMarker(path)) return false;
    } catch {
      return false;
    }
    return true;
  }
  return normalized.startsWith('data:') || normalized.startsWith('blob:');
};

/**
 * Normalize an avatar URL coming back from a profile fetch: return null when it
 * is a known "no avatar" marker (bare `/content/`, or an absolute URL derived
 * from it such as `https://so.metaid.io/content/`), otherwise return it as-is.
 */
export function normalizeProfileAvatarUrl(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return isRenderableAvatarSource(normalized) ? normalized || null : null;
}
