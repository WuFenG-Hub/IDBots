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
  // 8192 (upstream dsh-attachment-local default; request-side normalization
  // shrinks further per route), maxImageBytes 20 MiB. The capture fit must
  // never exceed them.
  assert.equal(BOT_BROWSER_CAPTURE_MAX_SIDE_PX, 8192);
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
  assert.equal(computeCaptureFitSize(8192, 8192), null);
  // Task #59's rejected figure now passes through unfitted.
  assert.equal(computeCaptureFitSize(2848, 1600), null);
  assert.equal(computeCaptureFitSize(8191, 1), null);
});

test('computeCaptureFitSize fits oversize captures within the side cap, aspect preserved', () => {
  // A 5x capture of a 1400x900 CSS content area blows the 8192 side cap.
  assert.deepEqual(computeCaptureFitSize(14000, 9000), { width: 8192, height: 5266 });
  // Portrait and extreme ratios round instead of re-exceeding the bound.
  assert.deepEqual(computeCaptureFitSize(9000, 14000), { width: 5266, height: 8192 });
  assert.deepEqual(computeCaptureFitSize(100000, 10), { width: 8192, height: 1 });
  const fit = computeCaptureFitSize(16384, 10240);
  assert.deepEqual(fit, { width: 8192, height: 5120 });
});

test('computeCaptureFitSize tolerates degenerate input', () => {
  assert.equal(computeCaptureFitSize(0, 0), null);
  assert.equal(computeCaptureFitSize(Number.NaN, 10), null);
  assert.equal(computeCaptureFitSize(-5, -9), null);
  // A tiny side never collapses to zero.
  assert.deepEqual(computeCaptureFitSize(80000, 1), { width: 8192, height: 1 });
});
