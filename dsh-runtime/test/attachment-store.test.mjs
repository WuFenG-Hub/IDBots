// Unit tests for the idbots-attachment-store image inspector: magic-signature
// validation and intrinsic-dimension decoding for every supported media type,
// plus rejection of corrupted/misdeclared bytes. The durable save/read round
// trip is covered end-to-end by host-tool-bridge (content-addressed file +
// image_url upstream).
//
// Run: node test/attachment-store.test.mjs   (from dsh-runtime/)

import assert from 'node:assert/strict'
import { inspectImage } from '../plugins/idbots-attachment-store.mjs'

let passed = 0
let failed = 0
const check = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${name} — ${error.message}`)
  }
}

// Real 1x1 PNG.
const PNG_1x1 = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
))

// Minimal synthetic GIF89a logical screen 6x4.
const gif = (width, height) => Uint8Array.from([
  ...Buffer.from('GIF89a'),
  width & 0xff, width >> 8 & 0xff,
  height & 0xff, height >> 8 & 0xff,
  0x00, 0x00, 0x00,
])

// Minimal WebP containers around VP8L / VP8X / VP8 chunks.
const le32 = (value) => Buffer.from([value & 0xff, value >> 8 & 0xff, value >> 16 & 0xff, value >> 24 & 0xff])
const riff = (fourcc, payload) => {
  // RIFF layout: RIFF + riffSize + WEBP + fourcc + chunkSize + chunk data.
  const chunk = Buffer.concat([Buffer.from(fourcc), le32(payload.length), Buffer.from(payload)])
  const out = Buffer.concat([Buffer.from('RIFF'), le32(4 + chunk.length), Buffer.from('WEBP'), chunk])
  return Uint8Array.from(out)
}
const vp8l = (width, height) => {
  const bits = (width - 1) | ((height - 1) << 14)
  return riff('VP8L', [0x2f, bits & 0xff, bits >> 8 & 0xff, bits >> 16 & 0xff, bits >> 24 & 0xff])
}
const vp8x = (width, height) => riff('VP8X', [
  0x10, 0x00, 0x00, 0x00,
  (width - 1) & 0xff, (width - 1) >> 8 & 0xff, (width - 1) >> 16 & 0xff,
  (height - 1) & 0xff, (height - 1) >> 8 & 0xff, (height - 1) >> 16 & 0xff,
])
const vp8 = (width, height) => riff('VP8 ', [
  0x30, 0x01, 0x00,           // frame tag
  0x9d, 0x01, 0x2a,           // start code
  width & 0xff, width >> 8 & 0xff,
  height & 0xff, height >> 8 & 0xff,
])

// Minimal JPEG with one SOF0 frame 4x3 (height precedes width in the segment).
const jpeg = (width, height) => Uint8Array.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x11, 0x08,
  height >> 8 & 0xff, height & 0xff,
  width >> 8 & 0xff, width & 0xff,
  0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  0xff, 0xd9,
])

check('png decodes 1x1', () => {
  assert.deepEqual(inspectImage(PNG_1x1, 'image/png'), { mediaType: 'image/png', width: 1, height: 1 })
})

check('gif decodes logical screen size', () => {
  assert.deepEqual(inspectImage(gif(6, 4), 'image/gif'), { mediaType: 'image/gif', width: 6, height: 4 })
})

check('webp vp8l decodes', () => {
  assert.deepEqual(inspectImage(vp8l(5, 3), 'image/webp'), { mediaType: 'image/webp', width: 5, height: 3 })
})

check('webp vp8x decodes', () => {
  assert.deepEqual(inspectImage(vp8x(258, 9), 'image/webp'), { mediaType: 'image/webp', width: 258, height: 9 })
})

check('webp vp8 decodes', () => {
  assert.deepEqual(inspectImage(vp8(2, 3), 'image/webp'), { mediaType: 'image/webp', width: 2, height: 3 })
})

check('jpeg decodes sofm frame size', () => {
  assert.deepEqual(inspectImage(jpeg(4, 3), 'image/jpeg'), { mediaType: 'image/jpeg', width: 4, height: 3 })
})

check('unsupported media type is rejected', () => {
  assert.throws(() => inspectImage(PNG_1x1, 'image/bmp'), /unsupported media type/)
})

check('png signature mismatch is rejected', () => {
  assert.throws(() => inspectImage(gif(1, 1), 'image/png'), /not a PNG/)
})

check('misdeclared gif bytes are rejected', () => {
  assert.throws(() => inspectImage(PNG_1x1, 'image/gif'), /not a GIF/)
})

check('truncated jpeg is rejected', () => {
  assert.throws(() => inspectImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xc0]), 'image/jpeg'), /frame header|too short/)
})

check('too-short bytes are rejected', () => {
  assert.throws(() => inspectImage(Uint8Array.from([1, 2, 3]), 'image/png'), /too short|missing/)
})

console.log(`\n${passed}/${passed + failed} checks passed`)
process.exit(failed === 0 ? 0 : 1)
