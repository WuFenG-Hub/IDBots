// Session-root encoding migration: rewrite every plaintext `session.jsonl`
// artifact into `session.jsonl.zstd` (Node's builtin zlib zstd — no native
// addon). The 0.1.2 jsonl persistence backend refuses a root that mixes
// physical encodings, so this runs in the Electron main process BEFORE the
// runtime is spawned with a zstd composition (dshKernel.ensureRuntime).
//
// Durability contract per artifact:
//   1. compress plaintext → temp file (`.migrating-<pid>-<ts>`) in the same dir
//   2. fsync the temp file, rename onto `session.jsonl.zstd`
//   3. unlink `session.jsonl`
// A crash between 2 and 3 leaves BOTH files; the next pass sees the durable
// zstd artifact, drops the plaintext (recovery), and never recompresses.
// Compress/write/rename failures roll back every artifact this run already
// renamed (decompress + restore plaintext) so the root stays uniformly
// plaintext and a `compression: 'none'` boot remains possible; a rollback
// failure is rethrown — booting either encoding over a half-migrated root
// would trip the backend's encoding guard, so failing loudly is the safe end.
//
// Concurrency: several DshKernel instances (one per provider slot) share one
// sessionRoot and may call ensureRuntime in parallel — their kernelEnsureChain
// serializes only per slot. Two interleaved passes would race rename/unlink,
// and the losing unlink (ENOENT) would trigger a rollback that leaves the
// root mixed. An in-process, per-root in-flight promise (below) collapses
// concurrent callers onto ONE pass; the final-unlink ENOENT is additionally
// tolerated (an external writer finished the artifact — ours holds identical
// bytes) so residual concurrency converges instead of rolling back.

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { constants as zstdConstants, zstdCompress, zstdDecompress } from 'node:zlib'

const compress = promisify(zstdCompress)
const decompress = promisify(zstdDecompress)

const PLAIN = 'session.jsonl'
const ZSTD = 'session.jsonl.zstd'
// Frame parameters mirroring the persistence backend's writer: every frame
// carries a zstd checksum (CHECKSUM_OPTIONS in dsh-session-persistence-jsonl).
const CHECKSUM_OPTIONS = { params: { [zstdConstants.ZSTD_c_checksumFlag]: 1 } }

/**
 * Encode plaintext as the backend's concatenated-frame container: frame 1 is
 * exactly the header line, frame 2 the remaining event lines. The reader
 * asserts the first frame decodes to one header line (assertZstdHeaderFrame),
 * and later appends concatenate whole frames after ours.
 */
async function encodeZstdArtifact(plaintext) {
  const newline = plaintext.indexOf(10)
  if (newline === -1) throw new Error('session log has no header line')
  const headerFrame = await compress(plaintext.subarray(0, newline + 1), CHECKSUM_OPTIONS)
  const rest = plaintext.subarray(newline + 1)
  if (rest.length === 0) return headerFrame
  const bodyFrame = await compress(rest, CHECKSUM_OPTIONS)
  return Buffer.concat([headerFrame, bodyFrame])
}

const ZSTD_FRAME_MAGIC = 0xfd2fb528

/**
 * Locate complete zstd frame ranges without decompressing blocks — the same
 * header walk dsh-session-persistence-jsonl's scanZstdFrames performs (the
 * package does not export it). Throws on corrupt structure; used only to
 * decode artifacts this module wrote (rollback/verification).
 */
function scanCompleteFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4 || buffer.readUInt32LE(offset) !== ZSTD_FRAME_MAGIC) {
      throw new Error(`corrupt zstd artifact: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error('corrupt zstd artifact: reserved frame-header bit')
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error('corrupt zstd artifact: reserved block type')
      offset += blockType === 1 ? 1 : blockSize
      if (lastBlock) break
    }
    if (checksum) offset += 4
    frames.push({ start, end: offset })
  }
  return frames
}

/**
 * Decode a concatenated-frame artifact back to its full plaintext (rollback
 * and verification path; the runtime itself reads through the persistence
 * backend).
 */
export async function decodeZstdArtifact(buffer) {
  const parts = []
  for (const { start, end } of scanCompleteFrames(buffer)) {
    parts.push(await decompress(buffer.subarray(start, end)))
  }
  return Buffer.concat(parts)
}

const statOrNull = (file) => fsp.stat(file).catch((error) => {
  if (error?.code === 'ENOENT') return null
  throw error
})

/** Restore one this-run zstd artifact back to plaintext (rollback path). */
async function restorePlaintext(zstdPath, plainPath) {
  const bytes = await decodeZstdArtifact(await fsp.readFile(zstdPath))
  const tmp = `${plainPath}.rollback-${process.pid}-${Date.now().toString(36)}`
  const handle = await fsp.open(tmp, 'w')
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fsp.rename(tmp, plainPath)
  await fsp.unlink(zstdPath)
}

/**
 * Migrate one session root onto the zstd physical encoding.
 * Concurrent calls for the SAME root (provider slots sharing a sessionRoot
 * booting in parallel) collapse onto one in-flight pass — every caller awaits
 * the same result. Sequential calls scan fresh, so cross-restart crash
 * recovery still runs.
 * @param root - persistence root (`<root>/<project>/<session>/session.jsonl*`)
 * @param opts.log - optional structured logger (level, event, data).
 * @returns `{ migrated, recovered }` artifact counts.
 */
const inFlightMigrations = new Map()

export function migrateSessionRootToZstd(root, opts = {}) {
  const key = path.resolve(String(root))
  const existing = inFlightMigrations.get(key)
  if (existing !== undefined) return existing
  const run = migrateSessionRootToZstdUnlocked(root, opts)
    .finally(() => { inFlightMigrations.delete(key) })
  inFlightMigrations.set(key, run)
  return run
}

async function migrateSessionRootToZstdUnlocked(root, opts = {}) {
  const log = opts.log ?? (() => {})
  let migrated = 0
  let recovered = 0
  const renamed = [] // zstd artifacts completed by THIS run (rollback set)

  const rollback = async (cause) => {
    let rollbackError = null
    for (const { dir } of renamed.reverse()) {
      const zstdPath = path.join(dir, ZSTD)
      const plainPath = path.join(dir, PLAIN)
      try {
        if (await statOrNull(plainPath) !== null) {
          // plaintext survived (unlink never ran) — drop our zstd copy
          await fsp.unlink(zstdPath)
        } else {
          await restorePlaintext(zstdPath, plainPath)
        }
      } catch (error) {
        rollbackError ??= error
      }
    }
    if (rollbackError !== null) {
      throw new Error(`session-root zstd migration failed (${String(cause?.message ?? cause)}) and rollback also failed (${String(rollbackError.message)}); the root is partially migrated — do not boot either encoding until inspected`, { cause })
    }
    throw cause
  }

  let projects
  try {
    projects = await fsp.readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { migrated, recovered }
    throw error
  }

  for (const project of projects) {
    if (!project.isDirectory()) continue
    const sessions = await fsp.readdir(path.join(root, project.name), { withFileTypes: true })
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const dir = path.join(root, project.name, session.name)
      const plainPath = path.join(dir, PLAIN)
      const zstdPath = path.join(dir, ZSTD)
      const [plainStat, zstdStat] = await Promise.all([statOrNull(plainPath), statOrNull(zstdPath)])
      if (plainStat !== null && zstdStat !== null) {
        // crash recovery from an earlier pass: the zstd artifact is durable
        await fsp.unlink(plainPath)
        recovered += 1
        continue
      }
      if (plainStat === null) continue

      const tmp = path.join(dir, `${ZSTD}.migrating-${process.pid}-${Date.now().toString(36)}`)
      try {
        const compressed = await encodeZstdArtifact(await fsp.readFile(plainPath))
        const handle = await fsp.open(tmp, 'w')
        try {
          await handle.writeFile(compressed)
          await handle.sync()
        } finally {
          await handle.close()
        }
        await fsp.rename(tmp, zstdPath)
        renamed.push({ dir })
        try {
          await fsp.unlink(plainPath)
        } catch (error) {
          // The plaintext vanished between stat and unlink — an external
          // writer completed this artifact (identical bytes; rename is an
          // atomic overwrite). Converge on the migrated state instead of
          // rolling the root back into a mixed encoding, and drop it from
          // the rollback set: the artifact is no longer ours to restore.
          if (error?.code !== 'ENOENT') throw error
          const at = renamed.findIndex((entry) => entry.dir === dir)
          if (at !== -1) renamed.splice(at, 1)
          recovered += 1
          continue
        }
        migrated += 1
      } catch (error) {
        await fsp.rm(tmp, { force: true }).catch(() => {})
        await rollback(error)
      }
    }
  }

  if (migrated > 0 || recovered > 0) log('info', 'sessionRoot.zstdMigration', { migrated, recovered })
  return { migrated, recovered }
}
