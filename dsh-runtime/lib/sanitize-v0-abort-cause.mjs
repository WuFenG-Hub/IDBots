// Pre-migration v0 abort-cause sanitizer: rewrite `turn/end` events whose
// abort cause is a bare STRING ("steer", "cancel", "m1 wire cancel", …) into
// the v1-legal object form `{ kind: 'legacy' }`.
//
// Why this exists: the 0.1.x M1 wire wrote `turn/end` aborts as
// {"kind":"aborted","reason":"steer"} (string cause — see the host's own
// steer handling in coworkDshTurn.ts and the mapper tests using
// {"kind":"aborted","reason":"cancel"}). The 0.1.5 format migration
// (@deepseek-ai/dsh-session-format-v0-to-v1) requires the abort cause to be
// a JSON object ({kind:'user'|'parent'|'disposed'|'legacy'} or
// {kind:'hook',reason:string}); its legacy normalizer only repairs aborts
// that LACK the `reason` key, so a string cause passes normalization and
// then fails validation — and the migrator refuses the WHOLE Session
// ("refuses this format v0 Session: turn/end <seq> reason abort cause must
// be a JSON object"), leaving the user unable to open that session after
// the upgrade. Any Session where a turn was steered/cancelled on a 0.1.x
// kernel carries at least one such event. Until upstream teaches the
// migrator this historical shape, we sanitize the v0 artifacts on our side:
// this runs in the Electron main process BEFORE the runtime is spawned
// (dshKernel.ensureRuntime, right after the zstd encoding migration), so
// the persistence backend's migration pass only ever sees v1-legal events.
//
// Semantics: `{kind:'legacy'}` is the taxonomy value the upstream
// normalizer itself uses for historical aborts whose cause the new schema
// cannot express, so the rewrite is the honest mapping; the original string
// is preserved in the backup copy (below).
//
// Durability contract per artifact (only artifacts that NEED a rewrite are
// touched):
//   1. decode (zstd artifacts via the two-frame container decoder shared
//      with the zstd migration) and scan line by line
//   2. zero offending lines → the file is left byte-identical (no write)
//   3. otherwise: copy the ORIGINAL artifact bytes to
//      <rootParent>/backups/v0-abort-cause/<project>/<session>/ (once —
//      an existing backup is never overwritten), write the sanitized text
//      to a temp file (`.sanitizing-<pid>-<ts>`) in the same dir, fsync,
//      rename over the artifact
// A crash between steps leaves either the original or the sanitized file
// (rename is atomic); stale temp files are removed at the start of the next
// pass. The whole sweep runs once per install: a root-level marker file
// (.v0-abort-cause-sanitized, fsynced + renamed like any artifact) short-
// circuits later boots. Post-upgrade kernels write current-format artifacts
// natively, so no new string-cause v0 events can appear after the sweep.
//
// Concurrency: several DshKernel instances (one per provider slot) share one
// sessionRoot and may call ensureRuntime in parallel — an in-process,
// per-root in-flight promise collapses concurrent callers onto ONE pass
// (same pattern as migrate-session-root-zstd.mjs).

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { decodeZstdArtifact, encodeZstdArtifact } from './migrate-session-root-zstd.mjs'

const PLAIN = 'session.jsonl'
const ZSTD = 'session.jsonl.zstd'
const MARKER = '.v0-abort-cause-sanitized'
const MARKER_VERSION = 1

/**
 * Rewrite one JSONL line when it is a `turn/end` event whose abort cause is
 * a bare string. Pure; exported for tests.
 * @param line - one physical JSONL line (without the trailing newline).
 * @returns `{ line, patched }` — the original line when nothing matched.
 */
export function sanitizeV0AbortCauseLine(line) {
  // Fast path: only abort turn/ends can match, and they all name the kind.
  if (!line.includes('"aborted"')) return { line, patched: false }
  let event
  try {
    event = JSON.parse(line)
  } catch {
    return { line, patched: false }
  }
  if (event?.type !== 'turn/end') return { line, patched: false }
  const reason = event.data?.reason
  if (reason?.kind !== 'aborted' || typeof reason.reason !== 'string') return { line, patched: false }
  // The v1 validator requires exactly ["kind","reason"] on the abort reason
  // and exactly ["kind"] on a non-hook cause, so the rewrite emits precisely
  // that shape (extra historical keys, if any, are dropped by construction).
  const sanitized = {
    ...event,
    data: {
      ...event.data,
      reason: { kind: 'aborted', reason: { kind: 'legacy' } },
    },
  }
  return { line: JSON.stringify(sanitized), patched: true }
}

/**
 * Scan a whole decoded artifact. The header line (line 0) is never touched.
 * @returns `{ text, patchedEvents }` — text is identical to the input when
 * no line needed a rewrite.
 */
export function sanitizeV0AbortCauseText(text) {
  const lines = text.split('\n')
  let patchedEvents = 0
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.length === 0) continue
    const result = sanitizeV0AbortCauseLine(line)
    if (result.patched) {
      lines[index] = result.line
      patchedEvents += 1
    }
  }
  return { text: patchedEvents === 0 ? text : lines.join('\n'), patchedEvents }
}

const statOrNull = (file) => fsp.stat(file).catch((error) => {
  if (error?.code === 'ENOENT') return null
  throw error
})

/** Write bytes via temp + fsync + atomic rename (same-dir temp). */
async function writeAtomically(targetPath, bytes, tempTag) {
  const tmp = `${targetPath}.${tempTag}-${process.pid}-${Date.now().toString(36)}`
  const handle = await fsp.open(tmp, 'w')
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fsp.rename(tmp, targetPath)
}

/**
 * One-time pre-migration sweep over a v0 session root. Concurrent calls for
 * the SAME root collapse onto one in-flight pass; the marker file makes
 * later boots free.
 * @param root - persistence root (`<root>/<project>/<session>/session.jsonl*`).
 * @param opts.log - optional structured logger (level, event, data).
 * @returns `{ scanned, patched, patchedEvents, skipped }` artifact counts;
 * `skipped` is true when the marker short-circuited the sweep.
 */
const inFlightSweeps = new Map()

export function sanitizeV0AbortCauses(root, opts = {}) {
  const key = path.resolve(String(root))
  const existing = inFlightSweeps.get(key)
  if (existing !== undefined) return existing
  const run = sanitizeV0AbortCausesUnlocked(key, opts)
    .finally(() => { inFlightSweeps.delete(key) })
  inFlightSweeps.set(key, run)
  return run
}

async function sanitizeV0AbortCausesUnlocked(root, opts = {}) {
  const log = opts.log ?? (() => {})
  const markerPath = path.join(root, MARKER)
  if (await statOrNull(markerPath) !== null) {
    return { scanned: 0, patched: 0, patchedEvents: 0, skipped: true }
  }

  let projects
  try {
    projects = await fsp.readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { scanned: 0, patched: 0, patchedEvents: 0, skipped: false }
    throw error
  }

  const backupRoot = path.join(path.dirname(root), 'backups', 'v0-abort-cause')
  let scanned = 0
  let patched = 0
  let patchedEvents = 0

  for (const project of projects) {
    if (!project.isDirectory()) continue
    const sessions = await fsp.readdir(path.join(root, project.name), { withFileTypes: true })
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const dir = path.join(root, project.name, session.name)
      // Drop stale temp files from an interrupted earlier pass.
      for (const entry of await fsp.readdir(dir)) {
        if (entry.includes('.sanitizing-')) await fsp.rm(path.join(dir, entry), { force: true }).catch(() => {})
      }

      const zstdPath = path.join(dir, ZSTD)
      const plainPath = path.join(dir, PLAIN)
      const zstdStat = await statOrNull(zstdPath)
      const plainStat = zstdStat === null ? await statOrNull(plainPath) : null
      if (zstdStat === null && plainStat === null) continue
      scanned += 1

      const artifactPath = zstdStat !== null ? zstdPath : plainPath
      const originalBytes = await fsp.readFile(artifactPath)
      const plaintext = zstdStat !== null ? await decodeZstdArtifact(originalBytes) : originalBytes
      const { text, patchedEvents: events } = sanitizeV0AbortCauseText(plaintext.toString('utf8'))
      if (events === 0) continue

      // Backup the pristine artifact once before the first rewrite.
      const backupDir = path.join(backupRoot, project.name, session.name)
      const backupPath = path.join(backupDir, path.basename(artifactPath))
      if (await statOrNull(backupPath) === null) {
        await fsp.mkdir(backupDir, { recursive: true })
        await writeAtomically(backupPath, originalBytes, 'backup')
      }

      const sanitized = zstdStat !== null
        ? await encodeZstdArtifact(Buffer.from(text, 'utf8'))
        : Buffer.from(text, 'utf8')
      await writeAtomically(artifactPath, sanitized, 'sanitizing')
      patched += 1
      patchedEvents += events
      log('info', 'sessionRoot.v0AbortCauseSanitized', {
        project: project.name,
        session: session.name,
        events,
        backup: backupPath,
      })
    }
  }

  await writeAtomically(
    markerPath,
    Buffer.from(`${JSON.stringify({ version: MARKER_VERSION, scanned, patched, patchedEvents, at: Date.now() })}\n`, 'utf8'),
    'marker',
  )
  if (patched > 0) log('info', 'sessionRoot.v0AbortCauseSweep', { scanned, patched, patchedEvents })
  return { scanned, patched, patchedEvents, skipped: false }
}
