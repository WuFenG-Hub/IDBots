/**
 * Mobile attachment upload (REQ-E-6): `POST /upload?name=…` with progress.
 *
 * C2 Upload (docs/cloud-mobile/01-interface-contracts.md): raw file bytes as
 * the body, the file's Content-Type, stored at
 * `/data/workspace/uploads/{yyyy-mm-dd}/{uuid}-{sanitized name}`. The dev
 * proxy and the control plane forward `/upload` to
 * `/gateway/v1/upload` (REQ-E-9), so the client posts to the same origin.
 *
 * - Files over 25 MB are refused before anything is sent (`TOO_LARGE`).
 * - Photos larger than 4 MB are re-encoded to JPEG (quality 0.85, longest
 *   side 2560 px) via an offscreen canvas before upload. Only raster `image/*`
 *   types are re-encoded: GIFs are skipped (canvas would freeze an animated
 *   GIF on its first frame) and SVGs are skipped (rasterizing a vector
 *   changes its semantics). Re-encoding is best-effort — if the bitmap decode
 *   or canvas encode fails, the original bytes are uploaded as-is.
 * - The browser transport is `XMLHttpRequest` because fetch has no upload
 *   progress events; tests (and any non-DOM host) inject a transport through
 *   `options.fetchImpl`.
 *
 * HTTP error mapping (the UI maps `.code` to i18n strings):
 * `413 → TOO_LARGE`, `415 → BLOCKED_TYPE`, `507 → QUOTA_EXCEEDED`, anything
 * else → `UPLOAD_FAILED` with the HTTP status.
 */

/** Mirror of the C2 server cap (src/main/gateway/upload.ts UPLOAD_MAX_BYTES). */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/** Photos strictly larger than this are re-encoded before upload (REQ-E-6). */
export const PHOTO_REENCODE_THRESHOLD_BYTES = 4 * 1024 * 1024;

/** Longest edge of the re-encoded photo (px); smaller images keep their size. */
export const PHOTO_REENCODE_MAX_EDGE = 2560;

/** JPEG quality of the re-encoded photo. */
export const PHOTO_REENCODE_JPEG_QUALITY = 0.85;

/** Default upload endpoint (same origin; dev proxy / control plane forward it). */
export const DEFAULT_UPLOAD_URL = '/upload';

export type UploadErrorCode =
  | 'TOO_LARGE'
  | 'BLOCKED_TYPE'
  | 'QUOTA_EXCEEDED'
  | 'UPLOAD_FAILED';

/** Typed upload failure; the UI maps `code` to an i18n string. */
export class UploadError extends Error {
  readonly code: UploadErrorCode;
  /** HTTP status, or 0 when the failure never reached the server. */
  readonly status: number;

  constructor(code: UploadErrorCode, status: number, message?: string) {
    super(message || code);
    this.name = 'UploadError';
    this.code = code;
    this.status = status;
  }
}

export interface UploadResult {
  path: string;
  size: number;
  mime: string;
}

export interface UploadTransportRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: Blob;
  onProgress?: (loaded: number, total: number) => void;
}

export interface UploadTransportResponse {
  status: number;
  body: string;
}

/**
 * Pluggable transport. `options.fetchImpl` accepts one despite the legacy
 * name — the default is an XHR transport and tests inject a fake here.
 */
export interface UploadTransport {
  upload(request: UploadTransportRequest): Promise<UploadTransportResponse>;
}

export interface UploadFileOptions {
  /** Filename override for the `?name=` parameter (verbatim, urlencoded). */
  name?: string;
  /** Real upload progress (`XMLHttpRequest.upload.onprogress`). */
  onProgress?: (loaded: number, total: number) => void;
  /** Upload endpoint override; default `/upload` (same origin). */
  url?: string;
  /** Injected transport (tests); defaults to the XHR transport. */
  fetchImpl?: UploadTransport;
}

/**
 * Pure decision for `maybeReencodePhoto`: re-encode only raster photos
 * strictly over the 4 MB threshold. GIF (animated) and SVG (vector) inputs
 * are deliberately left untouched, as are non-image blobs; at/under the
 * threshold nothing is gained by a lossy re-encode.
 */
export function shouldReencodePhoto(input: { mime: string; size: number }): boolean {
  const mime = (input.mime || '').toLowerCase();
  if (!mime.startsWith('image/')) return false;
  if (mime === 'image/gif' || mime === 'image/svg+xml') return false;
  return input.size > PHOTO_REENCODE_THRESHOLD_BYTES;
}

/**
 * Resolve the `?name=` parameter. An explicit `name` option always wins
 * verbatim; otherwise the file's own name is used, switched to a `.jpg`
 * extension when the payload was re-encoded to JPEG.
 */
export function resolveUploadName(
  file: Blob,
  explicitName: string | undefined,
  wasReencoded: boolean,
): string {
  if (explicitName !== undefined) return explicitName;
  const fileName = (file as File).name;
  const base = typeof fileName === 'string' && fileName ? fileName : 'file';
  if (!wasReencoded) return base;
  const stem = base.replace(/\.[^./\\]+$/, '');
  return `${stem || 'file'}.jpg`;
}

/**
 * Best-effort photo re-encode (REQ-E-6): `createImageBitmap` → canvas
 * (downscale to 2560 px on the longest side) → `toBlob('image/jpeg', 0.85)`.
 * Returns the original blob whenever the input is not a re-encode candidate
 * or the canvas pipeline is unavailable/fails — upload must never break
 * because of the optimizer.
 */
export async function maybeReencodePhoto(file: Blob): Promise<Blob> {
  if (!shouldReencodePhoto({ mime: file.type || '', size: file.size })) {
    return file;
  }
  try {
    return await reencodePhotoToJpeg(file);
  } catch (error) {
    console.warn('[upload] photo re-encode failed, uploading original:', error);
    return file;
  }
}

async function reencodePhotoToJpeg(file: Blob): Promise<Blob> {
  if (typeof createImageBitmap !== 'function') return file;
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(
      1,
      PHOTO_REENCODE_MAX_EDGE / Math.max(bitmap.width, bitmap.height),
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    let canvas: OffscreenCanvas | HTMLCanvasElement;
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(width, height);
    } else {
      canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    // JPEG has no alpha channel: flatten on white so screenshots keep a sane
    // background instead of JPEG's default black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob = await canvasToBlob(canvas, 'image/jpeg', PHOTO_REENCODE_JPEG_QUALITY);
    return blob ?? file;
  } finally {
    bitmap.close?.();
  }
}

function canvasToBlob(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type, quality });
  }
  return new Promise((resolve) =>
    (canvas as HTMLCanvasElement).toBlob(resolve, type, quality),
  );
}

/** Default browser transport: XHR for real upload progress events. */
function xhrUploadTransport(): UploadTransport {
  return {
    upload(request) {
      return new Promise<UploadTransportResponse>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(request.method, request.url);
        for (const [header, value] of Object.entries(request.headers)) {
          xhr.setRequestHeader(header, value);
        }
        const onProgress = request.onProgress;
        if (onProgress) {
          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
              onProgress(event.loaded, event.total);
            }
          };
        }
        xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText ?? '' });
        xhr.onerror = () =>
          reject(new UploadError('UPLOAD_FAILED', 0, 'network error during upload'));
        xhr.onabort = () => reject(new UploadError('UPLOAD_FAILED', 0, 'upload aborted'));
        xhr.send(request.body);
      });
    },
  };
}

function mapHttpError(status: number, body: string): UploadError {
  if (status === 413) return new UploadError('TOO_LARGE', status, body || 'file too large');
  if (status === 415) return new UploadError('BLOCKED_TYPE', status, body || 'file type blocked');
  if (status === 507) {
    return new UploadError('QUOTA_EXCEEDED', status, body || 'storage quota exceeded');
  }
  return new UploadError('UPLOAD_FAILED', status, body || `upload failed with status ${status}`);
}

function parseUploadResult(status: number, body: string): UploadResult {
  let parsed: Partial<UploadResult> | null = null;
  try {
    parsed = JSON.parse(body) as Partial<UploadResult>;
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed.path === 'string') {
    return {
      path: parsed.path,
      size: typeof parsed.size === 'number' ? parsed.size : 0,
      mime: typeof parsed.mime === 'string' ? parsed.mime : '',
    };
  }
  throw new UploadError('UPLOAD_FAILED', status, 'malformed upload response');
}

/**
 * Upload one file/photo, returning the server path in the shape the desktop
 * dialog returns (`{ path, size, mime }`) so callers can pass it wherever a
 * local file path would go.
 */
export async function uploadFile(file: Blob, options: UploadFileOptions = {}): Promise<UploadResult> {
  if (file.size > UPLOAD_MAX_BYTES) {
    throw new UploadError(
      'TOO_LARGE',
      0,
      `file exceeds the ${UPLOAD_MAX_BYTES}-byte upload limit`,
    );
  }

  const payload = await maybeReencodePhoto(file);
  if (payload.size > UPLOAD_MAX_BYTES) {
    throw new UploadError('TOO_LARGE', 0, 'file exceeds the upload limit even after re-encode');
  }

  const name = resolveUploadName(file, options.name, payload !== file);
  const url = `${options.url ?? DEFAULT_UPLOAD_URL}?name=${encodeURIComponent(name)}`;
  const transport = options.fetchImpl ?? xhrUploadTransport();

  let response: UploadTransportResponse;
  try {
    response = await transport.upload({
      url,
      method: 'POST',
      headers: {
        'Content-Type': payload.type || 'application/octet-stream',
      },
      body: payload,
      onProgress: options.onProgress,
    });
  } catch (error) {
    if (error instanceof UploadError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new UploadError('UPLOAD_FAILED', 0, message);
  }

  if (response.status < 200 || response.status >= 300) {
    throw mapHttpError(response.status, response.body);
  }
  return parseUploadResult(response.status, response.body);
}
