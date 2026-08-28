/**
 * Output bounds for Bot Browser pixel captures (botBrowser:capturePage).
 *
 * Tool-result images ride the DSH host-tool bridge and are committed through
 * the runtime's attachment store
 * (dsh-runtime/plugins/idbots-attachment-store.mjs), which rejects images over
 * 2000px per side, 33.4 MP total, or 20 MiB. A store rejection used to wedge
 * the bridge for good (the pending tool call never settled, killing the
 * session), so captures are fitted to these bounds BEFORE they leave the main
 * process. Retina capturePage output is 2x the CSS rect, so even modest
 * windows blow past the per-side limit without fitting.
 *
 * The constants mirror the attachment store's LIMITS; keep them in sync.
 */

/** Mirrors idbots-attachment-store.mjs LIMITS.maxImageDimension. */
export const BOT_BROWSER_CAPTURE_MAX_SIDE_PX = 2000;
/** Mirrors idbots-attachment-store.mjs LIMITS.maxImageBytes. */
export const BOT_BROWSER_CAPTURE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Intrinsic pixel size of an encoded PNG stream (IHDR), or null when the
 * bytes are not a PNG. Used instead of nativeImage.getSize() because
 * capturePage images carry the display scaleFactor in DIP units, while the
 * attachment store measures the ENCODED pixels.
 */
export function readPngSize(png: Buffer): { width: number; height: number } | null {
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.length < 24) return null;
  if (!PNG_SIG.every((byte, index) => png[index] === byte)) return null;
  if (png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * The size a capture must be scaled to so both sides fit `maxSide`, aspect
 * ratio preserved (the long side lands exactly on the bound, the short side
 * rounds and never re-exceeds it). Returns null when the capture already fits.
 */
export function computeCaptureFitSize(
  width: number,
  height: number,
  maxSide: number = BOT_BROWSER_CAPTURE_MAX_SIDE_PX,
): { width: number; height: number } | null {
  const largest = Math.max(width, height);
  if (!(largest > maxSide)) return null; // also covers NaN / non-positive input
  // Pin the long side to exactly maxSide (integer division, no float fuzz from
  // largest * (maxSide / largest)) and scale only the short side.
  if (width >= height) {
    return { width: maxSide, height: Math.max(1, Math.round((height * maxSide) / width)) };
  }
  return { width: Math.max(1, Math.round((width * maxSide) / height)), height: maxSide };
}
