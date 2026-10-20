/**
 * Pure parts of the C2 upload route (`POST /gateway/v1/upload?name=…`).
 *
 * - `sanitizeUploadName` — reduce an attacker-controlled filename to a safe
 *   basename (directory traversal stripped, control chars removed, unicode
 *   letters kept).
 * - `isBlockedUploadType` — the 415 blocked-type check for executables.
 * - `uploadTargetPath` — the `/data/workspace/uploads/{yyyy-mm-dd}/{uuid}-{name}`
 *   storage layout.
 *
 * Pure module: node:path only, loadable from plain node. Streaming the body,
 * quota checks (507), and the HTTP response live in the server layer.
 */

import * as path from 'node:path';

/** C2 Upload: "Maximum 25 MB". */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/** Executable extensions blocked from upload (`02`/C2: 415 blocked type). */
export const BLOCKED_UPLOAD_EXTENSIONS: ReadonlySet<string> = new Set([
  '.exe',
  '.dll',
  '.com',
  '.bat',
  '.cmd',
  '.sh',
  '.msi',
  '.scr',
  '.ps1',
  '.app',
  '.deb',
  '.rpm',
]);

/** Executable MIME types blocked from upload. */
export const BLOCKED_UPLOAD_MIMES: ReadonlySet<string> = new Set([
  'application/x-executable',
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-bat',
  'application/x-sh',
  'application/x-shellscript',
  'application/x-msi',
  'application/x-debian-package',
  'application/x-rpm',
  'application/x-mach-binary',
  'application/vnd.microsoft.portable-executable',
]);

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/**
 * Reduce a caller-supplied filename to a safe basename: strip directories
 * (both separator styles — names arrive urlencoded from phones), strip ASCII
 * control characters, trim, and fall back to 'file' when nothing remains.
 * Unicode letters/symbols survive untouched.
 */
export function sanitizeUploadName(name: string): string {
  const base = (typeof name === 'string' ? name : '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(CONTROL_CHARS, '').trim();
  return cleaned.length > 0 ? cleaned : 'file';
}

/** True when the name or MIME type is a blocked executable type (→ 415). */
export function isBlockedUploadType(name: string, mime?: string | null): boolean {
  const extension = path.extname(typeof name === 'string' ? name : '').toLowerCase();
  if (BLOCKED_UPLOAD_EXTENSIONS.has(extension)) return true;
  if (typeof mime === 'string' && mime.trim().length > 0) {
    const normalized = mime.toLowerCase().split(';')[0].trim();
    if (BLOCKED_UPLOAD_MIMES.has(normalized)) return true;
  }
  return false;
}

/**
 * Storage path for one uploaded file: `{uploadsRoot}/{yyyy-mm-dd}/{uuid}-{sanitized}`
 * (local date of `now`; the container pins TZ=Asia/Shanghai, C1).
 */
export function uploadTargetPath(uploadsRoot: string, name: string, now: Date, uuid: string): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return path.join(uploadsRoot, `${yyyy}-${mm}-${dd}`, `${uuid}-${sanitizeUploadName(name)}`);
}
