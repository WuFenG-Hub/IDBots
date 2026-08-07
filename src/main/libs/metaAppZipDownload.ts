/**
 * Download-side integrity guards for MetaApp ZIP archives.
 *
 * The metafile-indexer accelerate endpoint can answer with 307 redirects to
 * OSS, and proxied/CDN downloads can be cut short mid-stream. A truncated or
 * invalid archive must be rejected here, before it reaches extraction or the
 * local artifact cache; otherwise the first broken download poisons every
 * later resolve with a confusing ADM-ZIP "No END header" extraction error.
 */

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50; // PK\x03\x04
const ZIP_EOCD_SIGNATURE = 0x06054b50; // PK\x05\x06
const ZIP_EOCD_MIN_LENGTH = 22;
const ZIP_EOCD_MAX_COMMENT_LENGTH = 0xffff;

type HeaderLookup = {
  get(name: string): string | null;
};

export type MetaAppZipDownloadResponse = {
  headers?: HeaderLookup | null;
};

/**
 * Assert that a downloaded MetaApp archive is complete and structurally sound:
 * - When the response declares Content-Length, the received byte count must
 *   match exactly (covers interrupted CDN/proxy downloads).
 * - The archive must start with the ZIP local-file-header magic PK\x03\x04.
 * - The archive must end with a coherent end-of-central-directory (EOCD)
 *   record (covers chunked/no-Content-Length truncation).
 */
export function assertMetaAppZipDownloadIntegrity(
  buffer: Buffer,
  response?: MetaAppZipDownloadResponse | null,
): void {
  const declaredHeader = response?.headers?.get?.('content-length');
  if (declaredHeader) {
    const declaredBytes = Number(declaredHeader);
    if (!Number.isFinite(declaredBytes) || declaredBytes < 0) {
      throw new Error('MetaApp ZIP download content-length is invalid.');
    }
    if (buffer.length !== declaredBytes) {
      throw new Error(
        `MetaApp ZIP download was truncated (received ${buffer.length} of ${declaredBytes} bytes).`,
      );
    }
  }
  assertZipArchiveIntegrity(buffer);
}

export function assertZipArchiveIntegrity(buffer: Buffer): void {
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(
      'MetaApp ZIP download is not a valid ZIP archive (missing PK\\x03\\x04 header).',
    );
  }
  if (!hasZipEndOfCentralDirectory(buffer)) {
    throw new Error(
      'MetaApp ZIP download is truncated (missing end-of-central-directory record).',
    );
  }
}

function hasZipEndOfCentralDirectory(buffer: Buffer): boolean {
  if (buffer.length < ZIP_EOCD_MIN_LENGTH) {
    return false;
  }
  const searchStart = Math.max(
    0,
    buffer.length - (ZIP_EOCD_MIN_LENGTH + ZIP_EOCD_MAX_COMMENT_LENGTH),
  );
  for (let index = buffer.length - ZIP_EOCD_MIN_LENGTH; index >= searchStart; index -= 1) {
    if (buffer.readUInt32LE(index) !== ZIP_EOCD_SIGNATURE) {
      continue;
    }
    // A real EOCD record must describe a central directory that fits inside
    // the received file. This rejects fake PK\x05\x06 bytes inside payload
    // data of a truncated download.
    const centralDirectorySize = buffer.readUInt32LE(index + 12);
    const centralDirectoryOffset = buffer.readUInt32LE(index + 16);
    if (centralDirectoryOffset + centralDirectorySize <= buffer.length) {
      return true;
    }
  }
  return false;
}

export function isMetaAppZipIntegrityError(error: unknown): boolean {
  return (
    error instanceof Error
    && /truncat|not a valid ZIP|missing end-of-central-directory|content-length is invalid/iu.test(error.message)
  );
}

/**
 * Re-throw extraction-stage failures with a stable user-facing message while
 * keeping the original adm-zip error as the cause. Path-safety errors raised
 * by our own extraction loop are passed through untouched.
 */
export function wrapMetaAppZipExtractionError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/MetaApp zip contains unsafe path|escapes destination/iu.test(message)) {
    throw error instanceof Error ? error : new Error(message);
  }
  const wrapped = new Error('MetaApp ZIP archive is invalid or damaged.');
  (wrapped as { cause?: unknown }).cause = error;
  throw wrapped;
}
