// idbots-attachment-store: durable content-addressed image store for the
// IDBots runtime.
//
// DSH's ImageBlock carries an ImageAttachmentRef whose bytes live in an
// `attachments` service (ctx.get('attachments')); the @deepseek-ai/dsh-attachment
// package ships only the abstract seam — no concrete store in the rc package
// set. This plugin provides the minimal durable implementation the host tool
// bridge needs: images are validated from their bytes (magic signature +
// intrinsic dimensions), stored under `<root>/<sha256>.bin` with a JSON
// sidecar, and read back with hash re-verification. Content addressing makes
// identical images dedupe naturally and gives `readImage` its integrity check.
//
// Config: { root } — directory under the versioned session root, so
// attachments live exactly as long as the session logs that reference them.

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { AttachmentError, AttachmentStore } from '@deepseek-ai/dsh-attachment'

export const name = 'idbots-attachment-store'

const MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const LIMITS = Object.freeze({
  maxImageBytes: 20 * 1024 * 1024,
  maxImagesPerMessage: 10,
  maxMessageImageBytes: 50 * 1024 * 1024,
  maxImagePixels: 33_400_000,
  mediaTypes: MEDIA_TYPES,
})

/** Decode intrinsic dimensions from encoded bytes; throws AttachmentError on malformed input. */
export function inspectImage(data, declaredMediaType) {
  const fail = (why) => { throw new AttachmentError(why, 'invalid-image') }
  if (!(data instanceof Uint8Array) || data.length < 12) fail('image bytes are missing or too short')
  const mediaType = MEDIA_TYPES.includes(declaredMediaType) ? declaredMediaType : undefined
  if (mediaType === undefined) fail(`unsupported media type ${JSON.stringify(String(declaredMediaType))}`)

  const be32 = (o) => (data[o] << 24 | data[o + 1] << 16 | data[o + 2] << 8 | data[o + 3]) >>> 0
  const be16 = (o) => data[o] << 8 | data[o + 1]
  const le16 = (o) => data[o] | data[o + 1] << 8
  const le24 = (o) => data[o] | data[o + 1] << 8 | data[o + 2] << 16

  if (mediaType === 'image/png') {
    const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    if (!PNG_SIG.every((b, i) => data[i] === b)) fail('bytes are not a PNG stream')
    if (be32(8) !== 13 || String.fromCharCode(...data.subarray(12, 16)) !== 'IHDR') fail('PNG stream has no IHDR header')
    return { mediaType, width: be32(16), height: be32(20) }
  }
  if (mediaType === 'image/gif') {
    const magic = String.fromCharCode(...data.subarray(0, 6))
    if (magic !== 'GIF87a' && magic !== 'GIF89a') fail('bytes are not a GIF stream')
    return { mediaType, width: le16(6), height: le16(8) }
  }
  if (mediaType === 'image/webp') {
    if (String.fromCharCode(...data.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...data.subarray(8, 12)) !== 'WEBP') fail('bytes are not a WebP stream')
    const fourcc = String.fromCharCode(...data.subarray(12, 16))
    if (fourcc === 'VP8 ') {
      if (data[23] !== 0x9d || data[24] !== 0x01 || data[25] !== 0x2a) fail('WebP lossy frame has no start code')
      return { mediaType, width: le16(26) & 0x3fff, height: le16(28) & 0x3fff }
    }
    if (fourcc === 'VP8L') {
      if (data[20] !== 0x2f) fail('WebP lossless frame has no signature')
      const bits = data[21] | data[22] << 8 | data[23] << 16 | data[24] << 24
      return { mediaType, width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (fourcc === 'VP8X') {
      return { mediaType, width: le24(24) + 1, height: le24(27) + 1 }
    }
    fail(`unsupported WebP chunk ${JSON.stringify(fourcc)}`)
  }
  // JPEG: walk segments to the first SOF marker.
  if (mediaType === 'image/jpeg') {
    if (data[0] !== 0xff || data[1] !== 0xd8) fail('bytes are not a JPEG stream')
    const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
    let pos = 2
    while (pos + 9 < data.length) {
      if (data[pos] !== 0xff) { pos += 1; continue }
      const marker = data[pos + 1]
      if (marker === 0xff) { pos += 1; continue }
      if (SOF.has(marker)) return { mediaType, height: be16(pos + 5), width: be16(pos + 7) }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { pos += 2; continue }
      pos += 2 + be16(pos + 2)
    }
    fail('JPEG stream has no frame header')
  }
  fail(`unsupported media type ${JSON.stringify(mediaType)}`)
}

export default class IdbotsAttachmentStore extends AttachmentStore {
  static inject = []

  constructor(ctx, config = {}) {
    super(ctx)
    if (typeof config?.root !== 'string' || config.root.length === 0) {
      throw new Error('idbots-attachment-store: config.root is required')
    }
    this.root = config.root
    fs.mkdir(this.root, { recursive: true }).catch(() => undefined)
  }

  get imageLimits() {
    return LIMITS
  }

  async validateImage(input) {
    const { data } = input
    if (data.byteLength > LIMITS.maxImageBytes) {
      throw new AttachmentError(`image is ${data.byteLength} bytes; the limit is ${LIMITS.maxImageBytes}`, 'too-large')
    }
    const dims = inspectImage(data, input.mediaType)
    if (dims.width * dims.height > LIMITS.maxImagePixels) {
      throw new AttachmentError(`image is ${dims.width}x${dims.height}; the pixel limit is ${LIMITS.maxImagePixels}`, 'too-large')
    }
  }

  async saveImage(input) {
    await this.validateImage(input)
    const bytes = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data)
    const id = createHash('sha256').update(bytes).digest('hex')
    const bin = path.join(this.root, `${id}.bin`)
    if (!existsSync(bin)) await fs.writeFile(bin, bytes)
    const dims = inspectImage(bytes, input.mediaType)
    await fs.writeFile(path.join(this.root, `${id}.json`), JSON.stringify({
      mediaType: dims.mediaType,
      bytes: bytes.byteLength,
      width: dims.width,
      height: dims.height,
      ...(typeof input.name === 'string' && input.name.length > 0 ? { name: input.name } : {}),
    }))
    return {
      attachmentId: id,
      mediaType: dims.mediaType,
      bytes: bytes.byteLength,
      width: dims.width,
      height: dims.height,
      ...(typeof input.name === 'string' && input.name.length > 0 ? { name: input.name } : {}),
    }
  }

  async readImage(ref, signal) {
    const id = String(ref?.attachmentId ?? '')
    if (!/^[0-9a-f]{64}$/.test(id)) {
      throw new AttachmentError('attachment id is not a content hash', 'not-found')
    }
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    const bin = path.join(this.root, `${id}.bin`)
    let bytes
    let meta
    try {
      bytes = await fs.readFile(bin)
      meta = JSON.parse(await fs.readFile(path.join(this.root, `${id}.json`), 'utf8'))
    } catch {
      throw new AttachmentError(`attachment ${id.slice(0, 12)} is not in the store`, 'not-found')
    }
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== id) {
      throw new AttachmentError(`attachment ${id.slice(0, 12)} failed content verification`, 'corrupt')
    }
    const canonical = {
      attachmentId: id,
      mediaType: meta.mediaType,
      bytes: bytes.byteLength,
      width: meta.width,
      height: meta.height,
      ...(typeof meta.name === 'string' ? { name: meta.name } : {}),
    }
    if (canonical.bytes !== ref.bytes || canonical.width !== ref.width || canonical.height !== ref.height) {
      throw new AttachmentError(`attachment ${id.slice(0, 12)} no longer matches its logged metadata`, 'corrupt')
    }
    return { ref: canonical, data: new Uint8Array(bytes) }
  }
}
