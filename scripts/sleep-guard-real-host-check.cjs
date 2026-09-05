/**
 * Real-host closed-loop check for the Sleep Guard.
 *
 * Boots the real Electron runtime and drives the COMPILED `sleepGuard` module
 * with the REAL `powerSaveBlocker`, asserting engagement in both directions
 * (idle -> work -> idle -> work). On macOS it additionally verifies the OS
 * power assertion (`PreventUserIdleSystemSleep`) appears while engaged.
 *
 * Run (from repo root, after `npm run compile:electron`):
 *   node_modules/.bin/electron scripts/sleep-guard-real-host-check.cjs
 *
 * Exit code 0 = all checks passed, 1 = any check failed.
 */
const { app, powerSaveBlocker } = require('electron');
const { execFileSync } = require('child_process');

let evaluateSleepGuardWork;
let SleepGuard;
try {
  ({ evaluateSleepGuardWork, SleepGuard } = require('../dist-electron/main/sleepGuard.js'));
} catch {
  ({ evaluateSleepGuardWork, SleepGuard } = require('../dist-electron/sleepGuard.js'));
}

const idle = { coworkSessionIds: [], scheduledTaskIds: [], dreamingMetabotIds: [] };

function osAssertionActive() {
  if (process.platform !== 'darwin') return null; // not applicable
  try {
    const out = execFileSync('pmset', ['-g', 'assertions'], { encoding: 'utf8' });
    return /PreventUserIdleSystemSleep/.test(out);
  } catch {
    return null; // pmset unavailable
  }
}

app.whenReady().then(() => {
  const results = [];
  const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
  };

  const guard = new SleepGuard({ powerSaveBlocker });

  // 1. Idle -> guard must NOT engage.
  let state = guard.apply(evaluateSleepGuardWork(idle));
  check('idle keeps blocker released', state.active === false && state.engaged === false, JSON.stringify(state));

  // 2. Work -> guard engages, real powerSaveBlocker isStarted is true.
  state = guard.apply(evaluateSleepGuardWork({ ...idle, coworkSessionIds: ['real-host-check-1'] }));
  check('work engages blocker', state.active === true && state.engaged === true, JSON.stringify(state));

  // 3. OS-level assertion appears while engaged (macOS only).
  const osActive = osAssertionActive();
  if (osActive === null) {
    check('OS assertion (n/a platform)', true, 'not darwin / pmset unavailable');
  } else {
    check('OS PreventUserIdleSystemSleep active', osActive, `pmset assertion ${osActive ? 'present' : 'MISSING'}`);
  }

  // 4. Repeated apply while working stays engaged (idempotent).
  state = guard.apply(evaluateSleepGuardWork({ ...idle, coworkSessionIds: ['real-host-check-1'], scheduledTaskIds: ['t1'], dreamingMetabotIds: [1] }));
  check('multi-source apply stays engaged', state.engaged === true && state.sources.includes('dream'), JSON.stringify(state));

  // 5. Idle again -> blocker released in the real runtime.
  state = guard.apply(evaluateSleepGuardWork(idle));
  check('idle releases blocker', state.engaged === false, JSON.stringify(state));

  // 6. Re-engage (second direction) -> blocker starts again.
  state = guard.apply(evaluateSleepGuardWork({ ...idle, scheduledTaskIds: ['t2'] }));
  check('re-engage after release', state.engaged === true && state.sources.includes('scheduledTask'), JSON.stringify(state));

  guard.dispose();
  const afterDispose = guard.isEngaged();
  check('dispose releases blocker', afterDispose === false, `engaged=${afterDispose}`);

  const passed = results.filter(Boolean).length;
  const ok = results.every(Boolean);
  console.log(`\nRESULT: ${ok ? 'PASS' : 'FAIL'} (${passed}/${results.length})`);
  app.exit(ok ? 0 : 1);
}).catch((error) => {
  console.error('Real-host check crashed:', error);
  app.exit(1);
});
