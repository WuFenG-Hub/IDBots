/**
 * Output bounds for Bot Browser pixel captures (botBrowser:capturePage).
 *
 * Tool-result images ride the DSH host-tool bridge and are committed through
 * the runtime's attachment store
 * (dsh-runtime/plugins/idbots-attachment-store.mjs), which rejects images over
 * 8192px per side, 33.4 MP total, or 20 MiB. A store rejection used to wedge
 * the bridge for good (the pending tool call never settled, killing the
 * session), so captures are fitted to these bounds BEFORE they leave the main
 * process.
 *
 * The constants mirror the attachment store's LIMITS; keep them in sync.
 */

/** Mirrors idbots-attachment-store.mjs LIMITS.maxImageDimension. */
export const BOT_BROWSER_CAPTURE_MAX_SIDE_PX = 8192;
/** Mirrors idbots-attachment-store.mjs LIMITS.maxImagePixels. */
export const BOT_BROWSER_CAPTURE_MAX_PIXELS = 33_400_000;
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
 * The size a capture must be scaled to so it fits both `maxSide` per side and
 * the `maxPixels` total budget, aspect ratio preserved (the side fit pins the
 * long side exactly on the bound; the pixel fit floors so the rounded product
 * can never re-exceed the budget). Returns null when the capture already fits.
 */
export function computeCaptureFitSize(
  width: number,
  height: number,
  maxSide: number = BOT_BROWSER_CAPTURE_MAX_SIDE_PX,
  maxPixels: number = BOT_BROWSER_CAPTURE_MAX_PIXELS,
): { width: number; height: number } | null {
  const largest = Math.max(width, height);
  const overSide = largest > maxSide; // false also covers NaN / non-positive input
  const overPixels = width * height > maxPixels;
  if (!overSide && !overPixels) return null;
  let fittedWidth = width;
  let fittedHeight = height;
  if (overSide) {
    // Pin the long side to exactly maxSide (integer division, no float fuzz
    // from largest * (maxSide / largest)) and scale only the short side.
    if (width >= height) {
      fittedWidth = maxSide;
      fittedHeight = Math.max(1, Math.round((height * maxSide) / width));
    } else {
      fittedWidth = Math.max(1, Math.round((width * maxSide) / height));
      fittedHeight = maxSide;
    }
  }
  if (fittedWidth * fittedHeight > maxPixels) {
    // Near-square captures can clear the side cap yet still blow the store's
    // total-pixel budget (e.g. a 2x Retina clip fitted to 8192x4194), which
    // re-opens the admission rejection this pre-fit exists to prevent.
    const scale = Math.sqrt(maxPixels / (fittedWidth * fittedHeight));
    fittedWidth = Math.max(1, Math.floor(fittedWidth * scale));
    fittedHeight = Math.max(1, Math.floor(fittedHeight * scale));
  }
  return { width: fittedWidth, height: fittedHeight };
}
