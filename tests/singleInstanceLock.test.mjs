// Two-instance shared-userData guard (2026-09-21 A2A incident).
//
// A dev instance launched with the single-instance lock disabled but no
// IDBOTS_USER_DATA_PATH override shares the regular app data directory with
// the packaged app; both instances' daemons then dispatch A2A turns for the
// same bot identity and collide on the DSH session write locks ("session …
// is already owned by an active write handle"). The guard makes that
// misconfiguration fatal at boot unless explicitly overridden.

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

import { shouldRefuseSharedUserData } from '../dist-electron/main/libs/singleInstanceLock.js'

test('lock enabled (normal packaged/dev boot) never refuses', () => {
  assert.equal(shouldRefuseSharedUserData({}), false)
  assert.equal(shouldRefuseSharedUserData({ IDBOTS_DISABLE_SINGLE_INSTANCE_LOCK: '0' }), false)
})

test('lock disabled + shared userData refuses to boot', () => {
  assert.equal(shouldRefuseSharedUserData({ IDBOTS_DISABLE_SINGLE_INSTANCE_LOCK: '1' }), true)
})

test('lock disabled + isolated userData is the supported dev flow', () => {
  assert.equal(
    shouldRefuseSharedUserData({ IDBOTS_DISABLE_SINGLE_INSTANCE_LOCK: '1', IDBOTS_USER_DATA_PATH: './.dev-userdata-dsh' }),
    false,
  )
  // An app-data override also isolates: resolveRuntimeDataPaths derives
  // userData from it when no explicit userData override is set.
  assert.equal(
    shouldRefuseSharedUserData({ IDBOTS_DISABLE_SINGLE_INSTANCE_LOCK: '1', IDBOTS_APP_DATA_PATH: './.dev-appdata-dsh' }),
    false,
  )
})

test('explicit override forces the unsafe shared mode', () => {
  assert.equal(
    shouldRefuseSharedUserData({ IDBOTS_DISABLE_SINGLE_INSTANCE_LOCK: '1', IDBOTS_ALLOW_SHARED_USERDATA: '1' }),
    false,
  )
  assert.equal(
    shouldRefuseSharedUserData({ IDBOTS_DISABLE_SINGLE_INSTANCE_LOCK: '1', IDBOTS_ALLOW_SHARED_USERDATA: 'yes' }),
    false,
  )
})

// Script invariants behind the single-owner model: entry points that boot on
// the REAL data directory must hold the single-instance lock (a second owner
// of that directory is refused by the lock itself); entry points that disable
// the lock must isolate the data directory. A script that disables the lock
// without isolation recreates the 2026-09-21 incident shape.
test('dev scripts: shared-data entry points hold the lock; only isolated ones disable it', () => {
  const here = path.dirname(new URL(import.meta.url).pathname)
  const root = path.resolve(here, '..')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

  // electron:dev boots on the real data directory — no lock disable.
  assert.ok(
    !pkg.scripts['start:electron'].includes('IDBOTS_DISABLE_SINGLE_INSTANCE_LOCK'),
    'start:electron must hold the single-instance lock (it boots on the shared data directory)',
  )

  // electron:dev:dsh runs side by side: lock disabled AND data dir isolated.
  assert.ok(pkg.scripts['electron:dev:dsh'].includes('IDBOTS_DISABLE_SINGLE_INSTANCE_LOCK=1'))
  assert.ok(pkg.scripts['electron:dev:dsh'].includes('IDBOTS_USER_DATA_PATH='))

  const devWorktree = fs.readFileSync(path.join(root, 'scripts', 'dev-worktree.sh'), 'utf8')
  assert.ok(
    !devWorktree.includes('IDBOTS_DISABLE_SINGLE_INSTANCE_LOCK'),
    'dev-worktree.sh boots on the shared data directory and must hold the lock',
  )
})
