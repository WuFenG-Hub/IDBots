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
