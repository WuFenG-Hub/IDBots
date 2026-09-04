#!/usr/bin/env node
/**
 * Live vision-relay regression probe (2026-09-04 describe_image incident).
 *
 * End-to-end acceptance for the restored describe_image tool: generates a
 * FIXED probe image (deterministic bytes, pure Node — no deps), calls the
 * compiled describe_image tool through the real vision relay, and asserts
 * the description actually saw the pixels (OCR of the embedded text).
 *
 * Prerequisites:
 *   npm run compile:electron          (build dist-electron first)
 *   IDBOTS_VISION_RELAY_KEY=...       (relay apiKey; the app persists it under
 *   IDBOTS_VISION_RELAY_BASE_URL=...   kv visionRelay.apiKey/visionRelay.baseUrl
 *                                      after any free-quota bootstrap)
 *
 * Exit codes: 0 = pass, 1 = regression detected, 2 = skipped (no credentials
 * or dist-electron not built).
 *
 * Unit-level coverage (model-limits table, read-image guard, catalog
 * registration) lives in tests/visionRelayAgentTools.test.mjs,
 * tests/coworkModelLimits.test.mjs and tests/coworkReadImageGuard.test.mjs;
 * this script is the live counterpart proving the relay path itself.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------
// Deterministic probe image: large white text "VISION 42" on a dark blue
// background, plus a red square and a green rectangle. Re-generated with
// identical bytes on every run, so the expected description points are fixed.
// The text is rendered on a 5x7 bitmap font at 4x supersampling and box-
// downscaled, because the relay's flash-class VLM misreads hard pixel edges;
// even so, only "VISION" (largest, common word) is a HARD OCR assertion —
// the digits and shape nouns are soft warns, since small-VLM exact OCR of
// synthetic text is inherently flaky ("VISION PROBE 42" came back as
// "VISION ARISE #2" in the 2026-09-04 dry run).
// ---------------------------------------------------------------------------

const PROBE_TEXT = 'VISION 42';

// 5x7 bitmap font, rows top-to-bottom, bit4 = leftmost pixel.
const FONT = {
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  4: [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  2: [0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111],
  ' ': [0, 0, 0, 0, 0, 0, 0],
};

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function buildProbePng() {
  const width = 864;
  const height = 256;
  const SS = 4; // supersampling factor — downscaled edges fake antialiasing
  const rw = width * SS;
  const rh = height * SS;
  const bg = [26, 34, 84];
  const render = new Uint8Array(rw * rh * 3);
  for (let i = 0; i < rw * rh; i += 1) render.set(bg, i * 3);

  // fillRect takes FINAL-pixel coordinates; the supersample grid does the rest.
  const fillRect = (x, y, w, h, rgb) => {
    for (let row = y * SS; row < (y + h) * SS; row += 1) {
      for (let col = x * SS; col < (x + w) * SS; col += 1) {
        if (row < 0 || row >= rh || col < 0 || col >= rw) continue;
        render.set(rgb, (row * rw + col) * 3);
      }
    }
  };

  // White text, scale 13 final px per font pixel (large glyphs OCR far more
  // reliably on the relay's flash-class VLM), one advance column between
  // glyphs.
  const scale = 13;
  const advance = 6 * scale;
  const textX = Math.floor((width - PROBE_TEXT.length * advance) / 2);
  const textY = 28;
  [...PROBE_TEXT].forEach((ch, index) => {
    const glyph = FONT[ch] ?? FONT[' '];
    glyph.forEach((bits, row) => {
      for (let col = 0; col < 5; col += 1) {
        if (bits & (1 << (4 - col))) {
          fillRect(textX + index * advance + col * scale, textY + row * scale, scale, scale, [255, 255, 255]);
        }
      }
    });
  });

  fillRect(72, 172, 88, 64, [216, 52, 56]); // red square
  fillRect(692, 172, 116, 56, [56, 168, 82]); // green rectangle

  // Box-downsample SSxSS blocks back to final resolution (antialiased edges).
  const pixels = new Uint8Array(width * height * 3);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        let sum = 0;
        for (let dr = 0; dr < SS; dr += 1) {
          for (let dc = 0; dc < SS; dc += 1) {
            sum += render[((row * SS + dr) * rw + col * SS + dc) * 3 + channel];
          }
        }
        pixels[(row * width + col) * 3 + channel] = Math.round(sum / (SS * SS));
      }
    }
  }

  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const rowStart = row * (width * 3 + 1);
    raw[rowStart] = 0; // filter: none
    Buffer.from(pixels.buffer, row * width * 3, width * 3).copy(raw, rowStart + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Compiled-module loading with the same electron stub the unit tests use.
// ---------------------------------------------------------------------------

const require = Module.createRequire(import.meta.url);

function loadCompiledModule(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'vision-relay-regression-')),
        },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function skip(reason) {
  console.log(`SKIP: ${reason}`);
  process.exit(2);
}

async function main() {
  const apiKey = (process.env.IDBOTS_VISION_RELAY_KEY ?? '').trim();
  const baseUrl = (process.env.IDBOTS_VISION_RELAY_BASE_URL ?? '').trim();
  if (!apiKey || !baseUrl) {
    skip('set IDBOTS_VISION_RELAY_KEY and IDBOTS_VISION_RELAY_BASE_URL (persisted in the app store under visionRelay.apiKey / visionRelay.baseUrl after a free-quota bootstrap)');
  }
  const servicePath = path.join(process.cwd(), 'dist-electron/main/services/visionRelayService.js');
  const toolsPath = path.join(process.cwd(), 'dist-electron/main/libs/visionRelayAgentTools.js');
  if (!fs.existsSync(servicePath) || !fs.existsSync(toolsPath)) {
    skip('dist-electron is not built — run `npm run compile:electron` first');
  }

  const service = loadCompiledModule(servicePath);
  const { buildVisionRelayAgentTools } = loadCompiledModule(toolsPath);
  service.initVisionRelayService({
    getStore: () => null,
    bootstrapImpl: async () => ({ apiKey, baseUrl }),
  });

  // The probe image is small (well under the 8 MiB cap), so feed it as
  // pre-encoded base64: the local downscale/ffmpeg path is covered by unit
  // tests and is not what regressed.
  const probePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vision-probe-')), 'vision-probe.png');
  fs.writeFileSync(probePath, buildProbePng());
  console.log(`probe image: ${probePath} (${fs.statSync(probePath).size} bytes, text "${PROBE_TEXT}")`);

  const control = {
    recognize: ({ imagePath, prompt }) => service.recognizeImageViaRelay({
      imageBase64: fs.readFileSync(imagePath).toString('base64'),
      mimeType: 'image/png',
      prompt,
    }),
    recognizeVideo: async () => {
      throw new Error('not under test');
    },
  };

  const captured = [];
  const tools = buildVisionRelayAgentTools({
    tool: (name, description, schema, handler) => {
      const entry = { name, description, schema, handler };
      captured.push(entry);
      return entry;
    },
    visionRelay: control,
  });

  // Catalog contract: BOTH relay vision tools exist on every route (the
  // regression removed describe_image from vision-resolved routes).
  assert.deepEqual(tools.map((t) => t.name), ['describe_image', 'describe_video']);
  console.log('PASS catalog: describe_image + describe_video both registered');

  const describeImage = captured.find((t) => t.name === 'describe_image');

  // Contract: relative paths are rejected before any relay call.
  const relative = await describeImage.handler({ image_path: 'vision-probe.png' });
  assert.equal(relative.isError, true);
  assert.match(relative.content[0].text, /ABSOLUTE/);
  console.log('PASS contract: relative path rejected without a relay call');

  // Live call: the relay VLM must actually see the pixels.
  const result = await describeImage.handler({
    image_path: probePath,
    question: `Read the text in this image exactly, and list the background color and the two colored shapes.`,
  });
  const text = result.content?.[0]?.text ?? '';
  console.log('--- describe_image result ---');
  console.log(text);
  console.log('-----------------------------');
  assert.equal(result.isError, undefined, `describe_image returned an error: ${text}`);
  // Hard points that prove the relay actually saw THIS image: the anchor
  // word (largest text), the background, and both colored shapes.
  assert.match(text, /VISION/i, 'OCR must read the anchor word (VISION)');
  assert.match(text, /blue|navy/i, 'must see the dark blue background');
  assert.match(text, /red/i, 'must see the red square');
  assert.match(text, /green/i, 'must see the green rectangle');
  console.log('PASS live relay: anchor OCR + background + both shapes matched');
  // Soft points: exact digit OCR and shape nouns vary on flash-class VLMs.
  for (const soft of [/42/, /square/i, /rectangle/i, /white/i]) {
    if (!soft.test(text)) {
      console.log(`WARN: description does not mention ${soft} — check the printed result above`);
    }
  }
  console.log('PASS: vision relay regression probe complete');
}

main().catch((error) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
