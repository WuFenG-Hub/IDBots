// E2E for the pre-migration v0 abort-cause sanitizer
// (lib/sanitize-v0-abort-cause.mjs).
//
// Background: the 0.1.x M1 wire wrote `turn/end` aborts with a bare-string
// cause ({"kind":"aborted","reason":"steer"}); the 0.1.5
// dsh-session-format-v0-to-v1 migration requires an object cause and
// refuses the whole Session otherwise. This test drives the REAL upstream
// migration stage (sessionFormatV0ToV1.createStage) to prove the refusal
// reproduces on the legacy shape and clears after sanitizing, then sweeps a
// fixture session root end to end (zstd + plaintext artifacts, backups,
// marker gating, stale-temp cleanup, idempotence).

import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  sanitizeV0AbortCauseLine,
  sanitizeV0AbortCauseText,
  sanitizeV0AbortCauses,
} from '../lib/sanitize-v0-abort-cause.mjs'
import { decodeZstdArtifact, encodeZstdArtifact } from '../lib/migrate-session-root-zstd.mjs'
import { sessionFormatV0ToV1 } from '@deepseek-ai/dsh-session-format-v0-to-v1'

const HEADER = JSON.stringify({
  type: 'session',
  version: 0,
  id: 'cw-sanitize-test',
  createdAt: 1788685909402,
  cwd: '/tmp/workspace',
  delegationDepth: 0,
})

const ABORT_STEER = JSON.stringify({
  type: 'turn/end',
  seq: 7,
  time: 1788687679993,
  data: { turn: 4, reason: { kind: 'aborted', reason: 'steer' } },
})

const ABORT_OBJECT = JSON.stringify({
  type: 'turn/end',
  seq: 9,
  time: 1788687680000,
  data: { turn: 5, reason: { kind: 'aborted', reason: { kind: 'user' } } },
})

const USER_MESSAGE = JSON.stringify({
  type: 'user/message',
  seq: 1,
  time: 1788685909500,
  data: { id: 'm-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] },
})

/** Drive the real v0→v1 migration stage over decoded event lines. */
function migrateEventsWithUpstreamStage(sourceHeader, events) {
  const stage = sessionFormatV0ToV1.createStage({ sourceHeader, sourceInheritedEventCount: 0 })
  const emitted = []
  const context = { emitEvent: (event) => emitted.push(event), emitRun: (run) => emitted.push(run) }
  for (const event of events) stage.transformEvent(event, context)
  stage.finish(context)
  return emitted
}

const main = async () => {
  // ---- line rewriter ------------------------------------------------------
  {
    const patched = sanitizeV0AbortCauseLine(ABORT_STEER)
    assert.equal(patched.patched, true, 'string-cause abort is rewritten')
    assert.deepEqual(
      JSON.parse(patched.line).data.reason,
      { kind: 'aborted', reason: { kind: 'legacy' } },
      'string cause becomes the v1 legacy object',
    )

    const objectCause = sanitizeV0AbortCauseLine(ABORT_OBJECT)
    assert.equal(objectCause.patched, false, 'object cause is left alone')

    const noReason = sanitizeV0AbortCauseLine(JSON.stringify({
      type: 'turn/end', seq: 3, time: 1, data: { turn: 1, reason: { kind: 'aborted' } },
    }))
    assert.equal(noReason.patched, false, 'abort without cause key is the upstream normalizer’s job')

    assert.equal(sanitizeV0AbortCauseLine(USER_MESSAGE).patched, false, 'non-turn/end untouched')
    assert.equal(sanitizeV0AbortCauseLine('{"type":"turn/end","data":broken').patched, false, 'invalid JSON untouched')

    const text = `${HEADER}\n${ABORT_STEER}\n${USER_MESSAGE}\n`
    const result = sanitizeV0AbortCauseText(text)
    assert.equal(result.patchedEvents, 1, 'one event patched in text')
    assert.ok(result.text.endsWith('\n'), 'trailing newline preserved')
    assert.ok(result.text.startsWith(`${HEADER}\n`), 'header line untouched')
    assert.equal(sanitizeV0AbortCauseText(text).text === result.text, true)
    const clean = sanitizeV0AbortCauseText(`${HEADER}\n${USER_MESSAGE}\n`)
    assert.equal(clean.patchedEvents, 0, 'clean text reports zero patches')
  }
  console.log('PASS  line rewriter rewrites only bare-string abort causes')

  // ---- upstream migration stage: refusal reproduces, then clears ----------
  {
    const sourceHeader = JSON.parse(HEADER)
    const legacyEvent = JSON.parse(ABORT_STEER)
    assert.throws(
      () => migrateEventsWithUpstreamStage(sourceHeader, [legacyEvent]),
      (error) => String(error?.message ?? error).includes('abort cause must be a JSON object'),
      'upstream stage refuses the bare-string abort cause',
    )

    const sanitizedEvent = JSON.parse(sanitizeV0AbortCauseLine(ABORT_STEER).line)
    const emitted = migrateEventsWithUpstreamStage(sourceHeader, [sanitizedEvent])
    assert.equal(emitted.length, 1, 'sanitized event migrates through the upstream stage')
    assert.deepEqual(
      emitted[0].data.reason,
      { kind: 'aborted', reason: { kind: 'legacy' } },
      'migrated event keeps the legacy object cause',
    )
  }
  console.log('PASS  upstream v0→v1 stage refuses the legacy shape and accepts the sanitized one')

  // ---- full root sweep -----------------------------------------------------
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'v0-sanitize-'))
  try {
    const project = '--tmp-workspace--'
    const dirtyDir = path.join(root, project, 'cw-dirty')
    const cleanDir = path.join(root, project, 'cw-clean')
    const plainDir = path.join(root, project, 'cw-plain')
    await fsp.mkdir(dirtyDir, { recursive: true })
    await fsp.mkdir(cleanDir, { recursive: true })
    await fsp.mkdir(plainDir, { recursive: true })

    const dirtyPlain = Buffer.from(`${HEADER}\n${ABORT_STEER}\n${USER_MESSAGE}\n`, 'utf8')
    await fsp.writeFile(path.join(dirtyDir, 'session.jsonl.zstd'), await encodeZstdArtifact(dirtyPlain))
    const cleanPlain = Buffer.from(`${HEADER}\n${ABORT_OBJECT}\n${USER_MESSAGE}\n`, 'utf8')
    await fsp.writeFile(path.join(cleanDir, 'session.jsonl.zstd'), await encodeZstdArtifact(cleanPlain))
    const plainText = Buffer.from(`${HEADER}\n${ABORT_STEER}\n`, 'utf8')
    await fsp.writeFile(path.join(plainDir, 'session.jsonl'), plainText)
    // Stale temp from an interrupted earlier pass must be cleaned up.
    await fsp.writeFile(path.join(dirtyDir, 'session.jsonl.zstd.sanitizing-1-zzz'), 'stale')

    const first = await sanitizeV0AbortCauses(root)
    assert.equal(first.skipped, false)
    assert.equal(first.scanned, 3, 'three artifacts scanned')
    assert.equal(first.patched, 2, 'zstd + plaintext artifacts patched')
    assert.equal(first.patchedEvents, 2, 'one event per dirty artifact')

    // Dirty zstd artifact now decodes to the sanitized text; clean one is
    // byte-identical (never rewritten); plaintext stayed plaintext.
    const dirtyAfter = await decodeZstdArtifact(await fsp.readFile(path.join(dirtyDir, 'session.jsonl.zstd')))
    const dirtyEvent = JSON.parse(dirtyAfter.toString('utf8').split('\n')[1])
    assert.deepEqual(dirtyEvent.data.reason, { kind: 'aborted', reason: { kind: 'legacy' } })
    const cleanAfter = await fsp.readFile(path.join(cleanDir, 'session.jsonl.zstd'))
    assert.deepEqual(cleanAfter, await encodeZstdArtifact(cleanPlain), 'clean artifact byte-identical')
    const plainAfter = await fsp.readFile(path.join(plainDir, 'session.jsonl'), 'utf8')
    assert.ok(plainAfter.includes('"kind":"legacy"'), 'plaintext artifact sanitized in place')

    // Backups hold the pristine bytes for the two patched artifacts only.
    const backupRoot = path.join(path.dirname(root), 'backups', 'v0-abort-cause', project)
    const dirtyBackup = await fsp.readFile(path.join(backupRoot, 'cw-dirty', 'session.jsonl.zstd'))
    assert.deepEqual(await decodeZstdArtifact(dirtyBackup), dirtyPlain, 'zstd backup keeps pristine bytes')
    const plainBackup = await fsp.readFile(path.join(backupRoot, 'cw-plain', 'session.jsonl'), 'utf8')
    assert.equal(plainBackup, plainText.toString('utf8'), 'plaintext backup keeps pristine bytes')
    assert.equal(await fsp.stat(path.join(backupRoot, 'cw-clean')).catch(() => null), null, 'no backup for clean artifacts')

    // Stale temp removed; marker written.
    const leftovers = (await fsp.readdir(dirtyDir)).filter((entry) => entry.includes('.sanitizing-'))
    assert.deepEqual(leftovers, [], 'stale temp files cleaned')
    const marker = JSON.parse(await fsp.readFile(path.join(root, '.v0-abort-cause-sanitized'), 'utf8'))
    assert.equal(marker.version, 1)
    assert.equal(marker.patched, 2)

    // The sanitized stream now survives the real upstream migration stage.
    const events = dirtyAfter.toString('utf8').split('\n').filter(Boolean).slice(1).map((line) => JSON.parse(line))
    const emitted = migrateEventsWithUpstreamStage(JSON.parse(HEADER), events)
    assert.equal(emitted.length, events.length, 'whole sanitized artifact migrates')

    // Second sweep short-circuits on the marker.
    const second = await sanitizeV0AbortCauses(root)
    assert.equal(second.skipped, true, 'marker gates later boots')
    assert.equal(second.patched, 0)

    // Deleting the marker re-runs the sweep as a content-level no-op.
    await fsp.unlink(path.join(root, '.v0-abort-cause-sanitized'))
    const third = await sanitizeV0AbortCauses(root)
    assert.equal(third.skipped, false)
    assert.equal(third.patched, 0, 'already-sanitized artifacts are not rewritten')
    assert.equal(third.patchedEvents, 0)
    // The original backup is preserved, not overwritten by the re-run.
    const dirtyBackupAgain = await fsp.readFile(path.join(backupRoot, 'cw-dirty', 'session.jsonl.zstd'))
    assert.deepEqual(await decodeZstdArtifact(dirtyBackupAgain), dirtyPlain, 'backup never overwritten')
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
    await fsp.rm(path.join(path.dirname(root), 'backups'), { recursive: true, force: true })
  }
  console.log('PASS  root sweep patches dirty artifacts, backs up originals, and stays idempotent')

  console.log('v0-abort-cause-sanitize.test.mjs: all assertions passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
