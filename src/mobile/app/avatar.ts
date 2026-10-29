/**
 * Avatar renderability gate (UE rework 2026-10-29, A1).
 *
 * Why this exists: over the real C2 bridge every invoke result passes the
 * main-process sanitizer (`src/main/ipc/sanitize.ts`), which hard-truncates
 * any string longer than IPC_STRING_MAX_CHARS (4000 chars) and appends the
 * marker `\n...[truncated in main IPC forwarding]`. MetaBot avatars travel
 * as base64 `data:image/...` URLs that are routinely 2K–150K characters
 * (measured: 12 real bots, blobs 1.4 KB–110 KB), so on the real bridge a
 * truncated, undecodable data URL arrives and the `<img>` renders broken.
 * The desktop never truncates (direct IPC), and mock fixtures use small or
 * null avatars — which is exactly why the defect only shows on real devices.
 *
 * Until the contract-side fix lands (exempt `data:image/` URLs from the
 * 4000-char cap), the renderer must treat any truncation marker — or any
 * non-image scheme — as "no avatar" and fall back to the initial letter.
 */

/** Marker appended by the main-process IPC sanitizer (ipc/sanitize.ts). */
export const IPC_TRUNCATION_MARKER = '...[truncated in main IPC forwarding]';

const IMAGE_DATA_URL_PREFIX = 'data:image/';
const HTTP_URL_PREFIX = /^https?:\/\//i;

/**
 * True only when the value looks like an avatar the browser can actually
 * decode: a complete `data:image/...` URL or an absolute http(s) URL, with
 * no sanitizer truncation marker anywhere in the string.
 */
export function isRenderableAvatar(avatar: unknown): avatar is string {
  if (typeof avatar !== 'string') return false;
  const trimmed = avatar.trim();
  if (!trimmed) return false;
  if (trimmed.includes(IPC_TRUNCATION_MARKER)) return false;
  return trimmed.startsWith(IMAGE_DATA_URL_PREFIX) || HTTP_URL_PREFIX.test(trimmed);
}
