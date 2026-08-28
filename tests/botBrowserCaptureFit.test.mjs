import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const {
  BOT_BROWSER_CAPTURE_MAX_BYTES,
  BOT_BROWSER_CAPTURE_MAX_SIDE_PX,
  computeCaptureFitSize,
  readPngSize,
} = require('../dist-electron/main/services/botBrowserCaptureFit.js');

/** Minimal PNG byte stream carrying the given IHDR dimensions (no IDAT). */
function makePng(width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25); // length(4) + 'IHDR'(4) + 13 data + crc(4, unchecked here)
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt32BE(0, 21); // crc placeholder
  const iend = Buffer.alloc(12);
  iend.write('IEND', 4, 'ascii');
  return Buffer.concat([sig, ihdr, iend]);
}

test('limits mirror the DSH attachment store bounds', () => {
  // dsh-runtime/plugins/idbots-attachment-store.mjs LIMITS: maxImageDimension
  // 2000, maxImageBytes 20 MiB. The capture fit must never exceed them.
  assert.equal(BOT_BROWSER_CAPTURE_MAX_SIDE_PX, 2000);
  assert.equal(BOT_BROWSER_CAPTURE_MAX_BYTES, 20 * 1024 * 1024);
});

test('readPngSize reads intrinsic pixel dimensions from IHDR', () => {
  assert.deepEqual(readPngSize(makePng(2800, 1800)), { width: 2800, height: 1800 });
  assert.deepEqual(readPngSize(makePng(1, 1)), { width: 1, height: 1 });
});

test('readPngSize rejects non-PNG or truncated bytes', () => {
  assert.equal(readPngSize(Buffer.alloc(0)), null);
  assert.equal(readPngSize(Buffer.from('not a png at all, definitely')), null);
  assert.equal(readPngSize(makePng(10, 10).subarray(0, 20)), null);
});

test('computeCaptureFitSize returns null when the capture already fits', () => {
  assert.equal(computeCaptureFitSize(1000, 800), null);
  assert.equal(computeCaptureFitSize(2000, 2000), null);
  assert.equal(computeCaptureFitSize(1999, 1), null);
});

test('computeCaptureFitSize fits oversize captures within the side cap, aspect preserved', () => {
  // The reported hang: a 2x Retina capture of a 1400x900 CSS content area.
  assert.deepEqual(computeCaptureFitSize(2800, 1800), { width: 2000, height: 1286 });
  // Portrait and extreme ratios round instead of re-exceeding the bound.
  assert.deepEqual(computeCaptureFitSize(1800, 2800), { width: 1286, height: 2000 });
  assert.deepEqual(computeCaptureFitSize(10000, 10), { width: 2000, height: 2 });
  const fit = computeCaptureFitSize(2880, 1800);
  assert.ok(fit.width <= 2000 && fit.height <= 2000);
});

test('computeCaptureFitSize tolerates degenerate input', () => {
  assert.equal(computeCaptureFitSize(0, 0), null);
  assert.equal(computeCaptureFitSize(Number.NaN, 10), null);
  assert.equal(computeCaptureFitSize(-5, -9), null);
  // A tiny side never collapses to zero.
  assert.deepEqual(computeCaptureFitSize(8000, 1), { width: 2000, height: 1 });
});
