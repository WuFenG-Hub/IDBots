import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

/**
 * S1 guard (2026-10-22 review round 2): in server mode the task-scheduler
 * tier was queued right before startSqliteDaemons(), whose first action was
 * to clear the WHOLE pending-tier queue — the scheduler never started.
 *
 * These tests drive the extracted tier queue through the exact boot sequence:
 * scheduleStartupTier(...) → noteSqliteDaemonsStarted() (the seam
 * startSqliteDaemons() calls first) → the tier must still fire.
 */

const require = Module.createRequire(import.meta.url);
const {
  scheduleStartupTier,
  noteSqliteDaemonsStarted,
  hasPendingStartupTiers,
  resetStartupTiersForTesting,
} = require('../dist-electron/main/libs/startupTiers.js');

const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

test('boot tier survives the FIRST sqlite daemon start (S1 guard)', async () => {
  resetStartupTiersForTesting();
  let started = 0;
  scheduleStartupTier('server: task scheduler start', 0, () => {
    started += 1;
  });

  // The daemon start must not cancel the tier that was just queued.
  noteSqliteDaemonsStarted();
  assert.equal(hasPendingStartupTiers(), true, 'tier was cleared by the daemon start');

  await tick();
  assert.equal(started, 1, 'scheduler tier never ran (S1)');
});

test('re-entry clears previous-generation pending tiers without double-starting', async () => {
  resetStartupTiersForTesting();
  let schedulerStarts = 0;
  scheduleStartupTier('server: task scheduler start', 0, () => {
    schedulerStarts += 1;
  });
  noteSqliteDaemonsStarted();
  await tick();
  assert.equal(schedulerStarts, 1);

  // Old-generation pending work is dropped on re-entry (sqlite recovery),
  // exactly as before — daemons must not start twice.
  let oldGenerationRuns = 0;
  scheduleStartupTier('IM gateway reconnect', 0, () => {
    oldGenerationRuns += 1;
  });
  noteSqliteDaemonsStarted();
  await tick();
  assert.equal(oldGenerationRuns, 0, 'previous-generation pending tier should be cleared on re-entry');
  assert.equal(schedulerStarts, 1, 'scheduler must not start twice');

  // New-generation work queued after the re-entry still runs.
  let newGenerationRuns = 0;
  scheduleStartupTier('post-recovery work', 0, () => {
    newGenerationRuns += 1;
  });
  await tick();
  assert.equal(newGenerationRuns, 1);
});

test('desktop delayMs is passed through (no server-mode behavior change)', async () => {
  resetStartupTiersForTesting();
  let ran = 0;
  scheduleStartupTier('plain tier', 0, () => {
    ran += 1;
  });
  await tick();
  assert.equal(ran, 1);
});
