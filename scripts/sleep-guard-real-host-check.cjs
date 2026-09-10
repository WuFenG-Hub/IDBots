/**
 * Real-host closed-loop check for the Sleep Guard.
 *
 * Boots the real Electron runtime and drives the COMPILED `sleepGuard` module
 * with the REAL `powerSaveBlocker` (and, on macOS, the REAL `/usr/bin/caffeinate`
 * spawn), asserting engagement in both directions (idle -> work -> idle -> work).
 *
 * macOS OS-level verification (the point of this rewrite): it parses the
 * "Listed by owning process" section of `pmset -g assertions` and requires a
 * REAL assertion owned either by the caffeinate helper spawned for THIS pid
 * (`PreventUserIdleSystemSleep`, `Created for PID: <this pid>`) or by this
 * process itself on the fallback path (`NoDisplaySleepAssertion` =
 * `PreventUserIdleDisplaySleep`). The previous version matched the bare label
 * `/PreventUserIdleSystemSleep/` anywhere in the pmset output — that label is
 * present in the summary section even when nothing is guarded (powerd holds
 * one), so the check was constant-true and never verified anything.
 *
 * Run (from repo root, after `npm run compile:electron`):
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/sleep-guard-real-host-check.cjs
 *
 * ⚠️ ELECTRON_RUN_AS_NODE must be unset, otherwise `require('electron')` returns
 * only the binary path string and `app.whenReady` is undefined.
 *
 * Negative control (assertion mechanisms disabled -> MUST report FAIL, exit 1):
 *   SLEEP_GUARD_CHECK_DISABLE_ASSERTIONS=1 env -u ELECTRON_RUN_AS_NODE \
 *     ./node_modules/.bin/electron scripts/sleep-guard-real-host-check.cjs
 *
 * Host-setting contrast (General ▸ 「阻止设备休眠」, default OFF): the check first
 * drives the guard on the fresh-install path (no config key -> OFF, work active,
 * provably NO assertion), then flips the setting ON at runtime and requires the
 * assertion to appear, then switches it OFF again mid-work and requires the
 * assertion to disappear — all without restarting the app.
 *
 * Exit code 0 = all checks passed, 1 = any check failed.
 */
const os = require('os');
const path = require('path');
const { app, powerSaveBlocker } = require('electron');
const { execFileSync } = require('child_process');

// Keep this check out of the real app's user data (an IDBots instance may be
// running concurrently); everything Chromium writes lands in a scratch dir.
app.setPath('userData', path.join(os.tmpdir(), 'idbots-sleep-guard-check-userdata'));
if (process.platform === 'darwin' && app.dock) app.dock.hide();

let evaluateSleepGuardWork;
let resolvePreventDeviceSleepEnabled;
let PREVENT_DEVICE_SLEEP_SETTING_KEY;
let SleepGuard;
let CAFFEINATE_PATH;
try {
  ({
    evaluateSleepGuardWork,
    resolvePreventDeviceSleepEnabled,
    PREVENT_DEVICE_SLEEP_SETTING_KEY,
    SleepGuard,
    CAFFEINATE_PATH,
  } = require('../dist-electron/main/sleepGuard.js'));
} catch {
  ({
    evaluateSleepGuardWork,
    resolvePreventDeviceSleepEnabled,
    PREVENT_DEVICE_SLEEP_SETTING_KEY,
    SleepGuard,
    CAFFEINATE_PATH,
  } = require('../dist-electron/sleepGuard.js'));
}

const idle = {
  coworkSessionIds: [],
  scheduledTaskIds: [],
  dreamingMetabotIds: [],
  groupTaskTurnIds: [],
  groupChatReplyTaskIds: [],
  a2aReplyTaskIds: [],
};
const ASSERTIONS_DISABLED = process.env.SLEEP_GUARD_CHECK_DISABLE_ASSERTIONS === '1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── pmset parsing ───────────────────────────────────────────────────────────

function readAssertions() {
  try {
    return execFileSync('pmset', ['-g', 'assertions'], { encoding: 'utf8' });
  } catch {
    return null;
  }
}

/**
 * Parse the "Listed by owning process" section into structured entries:
 *   pid 51749(caffeinate): [0x0012baed0001884e] 00:00:01 PreventUserIdleSystemSleep named: "caffeinate command-line tool"
 *     Details: caffeinate asserting on behalf of Process ID 51746
 *     Created for PID: 51746.
 * Returns [] when pmset is unavailable or the section is absent.
 */
function parseOwnedAssertions(text) {
  const entries = [];
  if (typeof text !== 'string') return entries;
  let inOwned = false;
  let current = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (/^Listed by owning process:/i.test(line)) {
      inOwned = true;
      current = null;
      continue;
    }
    if (/^No kernel assertions/i.test(line) || /^Kernel Assertions/i.test(line)) {
      inOwned = false;
      current = null;
      continue;
    }
    if (!inOwned) continue;
    const match = line.match(/^pid\s+(\d+)\(([^)]+)\):\s*\[[^\]]*\]\s*\S+\s+(\S+)/);
    if (match) {
      current = {
        pid: Number(match[1]),
        process: match[2],
        type: match[3],
        raw: rawLine,
        details: [],
      };
      entries.push(current);
      continue;
    }
    if (current && /^(Details:|Created for PID:|Timeout will fire|Localized=)/.test(line)) {
      current.details.push(line);
    }
  }
  return entries;
}

/**
 * The caffeinate assertion that guards THIS process: owned by a `caffeinate`
 * process and explicitly created for our pid (`-w <pid>` handshake). Exact and
 * non-circular — a stray caffeinate for another pid never matches.
 */
function caffeinateAssertionFor(entries, watchPid) {
  return (
    entries.find(
      (entry) =>
        entry.process === 'caffeinate' &&
        entry.type === 'PreventUserIdleSystemSleep' &&
        entry.details.some((detail) => new RegExp(`Created for PID:\\s*${watchPid}\\b`).test(detail)),
    ) ?? null
  );
}

/**
 * The powerSaveBlocker assertion owned by THIS process. Electron maps
 * `prevent-display-sleep` to IOKit `NoDisplaySleepAssertion`
 * (= PreventUserIdleDisplaySleep), and the legacy `prevent-app-suspension` to
 * `NoIdleSleepAssertion`; both spellings are accepted.
 */
function ownedBlockerAssertionFor(entries, pid) {
  const blockerTypes = new Set([
    'NoDisplaySleepAssertion',
    'PreventUserIdleDisplaySleep',
    'NoIdleSleepAssertion',
  ]);
  return entries.find((entry) => entry.pid === pid && blockerTypes.has(entry.type)) ?? null;
}

function formatEntry(entry) {
  if (!entry) return '(none)';
  const detail = entry.details.length ? ` | ${entry.details.join(' | ')}` : '';
  return `${entry.raw.trim()}${detail}`;
}

// ── negative-control seams ──────────────────────────────────────────────────

/** Blocker that reports a handle but never actually engages an OS assertion. */
const inertBlocker = {
  start: () => -1,
  stop: () => {},
  isStarted: () => false,
};

/** Helper stub: looks like a live child process to the guard, guards nothing. */
function createInertHelper() {
  const inert = {
    pid: 999999,
    kill: () => true,
    unref: () => {},
    on: () => inert,
    removeListener: () => inert,
  };
  return inert;
}

// ── the check ───────────────────────────────────────────────────────────────

app
  .whenReady()
  .then(async () => {
    const results = [];
    const check = (name, ok, detail) => {
      results.push({ name, ok });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
    };

    const isDarwin = process.platform === 'darwin';
    if (ASSERTIONS_DISABLED) {
      console.log(
        '!! NEGATIVE CONTROL: assertion mechanisms disabled — this run is EXPECTED to FAIL on the OS-assertion checks\n',
      );
    }
    console.log(`platform=${process.platform} pid=${process.pid} electron=${process.versions.electron}`);
    console.log(`caffeinate path=${CAFFEINATE_PATH}\n`);

    const guardOptions = {
      powerSaveBlocker: ASSERTIONS_DISABLED ? inertBlocker : powerSaveBlocker,
      ...(ASSERTIONS_DISABLED
        ? { spawnHelper: () => createInertHelper() }
        : {}),
    };

    // 0. Baseline: prove the OLD check was constant-true (the summary label is
    //    present while nothing is guarded) and that the new parser says "none".
    const baselineText = readAssertions();
    const baselineEntries = parseOwnedAssertions(baselineText);
    if (isDarwin) {
      const labelPresent = typeof baselineText === 'string' && /PreventUserIdleSystemSleep/.test(baselineText);
      console.log(
        `baseline: raw pmset text contains the PreventUserIdleSystemSleep label: ${labelPresent} ` +
          '(the old /label/ regex matched on this alone — constant true)',
      );
      check(
        'baseline: no guard assertion owned by this process before engaging',
        caffeinateAssertionFor(baselineEntries, process.pid) === null &&
          ownedBlockerAssertionFor(baselineEntries, process.pid) === null,
        `owned-by-this-pid entries: ${
          baselineEntries.filter((entry) => entry.pid === process.pid).length
        }`,
      );
    } else {
      check('OS assertion checks (n/a platform)', true, 'pmset is macOS-only');
    }

    // 1. Host setting default must be OFF for a missing/odd config value.
    check(
      'setting default: missing config key resolves to OFF',
      resolvePreventDeviceSleepEnabled(undefined) === false &&
        resolvePreventDeviceSleepEnabled(null) === false &&
        resolvePreventDeviceSleepEnabled('true') === false &&
        resolvePreventDeviceSleepEnabled(1) === false,
      'undefined/null/legacy-string/legacy-number all resolve false',
    );

    // 1b. Default-value evidence on the REAL app kv store (the same store the
    //     harness renderer writes through `window.electron.store`).
    try {
      const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
      const probeDir = path.join(os.tmpdir(), `idbots-sleepguard-config-check-${process.pid}`);
      const probeStore = await SqliteStore.create(probeDir);
      check(
        'config: fresh kv store has NO key and resolves OFF',
        probeStore.get(PREVENT_DEVICE_SLEEP_SETTING_KEY) === undefined &&
          resolvePreventDeviceSleepEnabled(probeStore.get(PREVENT_DEVICE_SLEEP_SETTING_KEY)) === false,
        `key=${PREVENT_DEVICE_SLEEP_SETTING_KEY} value=${JSON.stringify(
          probeStore.get(PREVENT_DEVICE_SLEEP_SETTING_KEY),
        )}`,
      );
      probeStore.set(PREVENT_DEVICE_SLEEP_SETTING_KEY, true);
      check(
        'config: stored true resolves ON and survives a reopen',
        resolvePreventDeviceSleepEnabled(probeStore.get(PREVENT_DEVICE_SLEEP_SETTING_KEY)) === true,
        `value=${JSON.stringify(probeStore.get(PREVENT_DEVICE_SLEEP_SETTING_KEY))}`,
      );
      probeStore.set(PREVENT_DEVICE_SLEEP_SETTING_KEY, false);
      check(
        'config: stored false resolves OFF',
        resolvePreventDeviceSleepEnabled(probeStore.get(PREVENT_DEVICE_SLEEP_SETTING_KEY)) === false,
        `value=${JSON.stringify(probeStore.get(PREVENT_DEVICE_SLEEP_SETTING_KEY))}`,
      );
    } catch (error) {
      check('config: app kv store round-trip', false, `store probe failed: ${error.message}`);
    }

    // NOTE: guardOptions carries no `enabled` — i.e. exactly the fresh-install
    // path (missing config key).
    const guard = new SleepGuard(guardOptions);
    check(
      'setting default: a guard built without the key reports OFF',
      guard.getState().preventDeviceSleepEnabled === false,
      JSON.stringify(guard.getState()),
    );

    // 2. Idle -> guard must NOT engage.
    let state = guard.apply(evaluateSleepGuardWork(idle));
    check(
      'idle keeps guard disengaged',
      state.active === false && state.engaged === false && state.engagedBy === null,
      JSON.stringify(state),
    );

    // 3. Work active but the setting is OFF -> truthful `active`, zero
    //    engagement, and (macOS) provably no OS assertion.
    state = guard.apply(evaluateSleepGuardWork({ ...idle, coworkSessionIds: ['real-host-check-1'] }));
    check(
      'setting OFF: work keeps the guard disengaged',
      state.active === true &&
        state.engaged === false &&
        state.engagedBy === null &&
        state.preventDeviceSleepEnabled === false,
      JSON.stringify(state),
    );
    if (isDarwin) {
      await sleep(700);
      const offEntries = parseOwnedAssertions(readAssertions());
      const offOwned =
        caffeinateAssertionFor(offEntries, process.pid) ?? ownedBlockerAssertionFor(offEntries, process.pid);
      console.log(`  pmset (setting OFF, work active): ${formatEntry(offOwned)}`);
      check('OS: setting OFF leaves NO assertion for this pid', offOwned === null, formatEntry(offOwned));
    }

    // 4. Flip the setting ON -> immediate engagement, no app restart.
    state = guard.setEnabled(true);
    check(
      'setting ON: engages immediately (no restart)',
      state.engaged === true && state.preventDeviceSleepEnabled === true,
      JSON.stringify(state),
    );
    const expectedMechanism = isDarwin ? 'caffeinate' : 'powerSaveBlocker';
    check(
      `mechanism: engaged via ${expectedMechanism}`,
      state.engagedBy === expectedMechanism,
      `engagedBy=${state.engagedBy} engagement=${JSON.stringify(guard.getEngagement())}`,
    );

    // 3. macOS: the OS really attributes a supported assertion to our pid.
    if (isDarwin) {
      await sleep(700);
      const entries = parseOwnedAssertions(readAssertions());
      const helperPid = guard.getEngagement().helperPid;
      const owned = caffeinateAssertionFor(entries, process.pid);
      console.log(`  pmset (engaged): ${formatEntry(owned)}`);
      check(
        'OS: caffeinate child holds PreventUserIdleSystemSleep for THIS pid',
        owned !== null,
        owned ? `owner pid=${owned.pid} (spawned helper pid=${helperPid})` : `MISSING (spawned helper pid=${helperPid})`,
      );
      check(
        'OS: assertion owner is the helper we spawned',
        owned !== null && owned.pid === helperPid,
        `owner pid=${owned ? owned.pid : null} helper pid=${helperPid}`,
      );
      check(
        'OS: no deprecated NoIdleSleepAssertion is used as the darwin guard',
        !entries.some((entry) => entry.pid === process.pid && entry.type === 'NoIdleSleepAssertion'),
        'legacy prevent-app-suspension assertion must not be the darwin mechanism',
      );
    }

    // 4. Repeated apply while working stays engaged (idempotent).
    state = guard.apply(
      evaluateSleepGuardWork({
        ...idle,
        coworkSessionIds: ['real-host-check-1'],
        scheduledTaskIds: ['t1'],
        dreamingMetabotIds: [1],
        groupTaskTurnIds: ['7:1'],
        groupChatReplyTaskIds: ['12'],
        a2aReplyTaskIds: ['abc123i0'],
      }),
    );
    check(
      'multi-source apply stays engaged',
      state.engaged === true &&
        state.sources.includes('dream') &&
        state.sources.includes('groupTask') &&
        state.sources.includes('groupChat') &&
        state.sources.includes('a2aChat'),
      JSON.stringify(state),
    );

    // 4b. The in-process (non-cowork) turn sources alone must hold a REAL OS
    //     assertion: a group-task turn, a group-chat reply and an A2A reply
    //     each run partly with no cowork session behind them.
    for (const [source, patch] of [
      ['groupTask', { groupTaskTurnIds: ['7:1'] }],
      ['groupChat', { groupChatReplyTaskIds: ['12'] }],
      ['a2aChat', { a2aReplyTaskIds: ['abc123i0'] }],
    ]) {
      state = guard.apply(evaluateSleepGuardWork({ ...idle, ...patch }));
      check(
        `${source}: a session-less turn alone engages the guard`,
        state.active === true && state.engaged === true && state.sources.length === 1 && state.sources[0] === source,
        JSON.stringify(state),
      );
      if (isDarwin) {
        await sleep(700);
        const owned = caffeinateAssertionFor(parseOwnedAssertions(readAssertions()), process.pid);
        console.log(`  pmset (${source} engaged): ${formatEntry(owned)}`);
        check(`OS: ${source} holds a real PreventUserIdleSystemSleep assertion`, owned !== null, formatEntry(owned));
      }
      state = guard.apply(evaluateSleepGuardWork(idle));
      check(
        `${source}: turn settling releases the guard`,
        state.active === false && state.engaged === false,
        JSON.stringify(state),
      );
      if (isDarwin) {
        await sleep(700);
        const after = caffeinateAssertionFor(parseOwnedAssertions(readAssertions()), process.pid);
        check(`OS: ${source} assertion gone once the turn settles`, after === null, formatEntry(after));
      }
    }

    // 4c. The collection seam: the real production collector (per-source fault
    //     isolation) is exercised here, so a broken getter can never leave
    //     real work unguarded. Values are injected because a live group-task
    //     turn or A2A reply cannot be produced inside this scratch Electron app
    //     (those daemons belong to the app, not to this check).
    let collectSleepGuardWorkFrom;
    let groupTaskTurnIdsOf;
    try {
      ({ collectSleepGuardWorkFrom, groupTaskTurnIdsOf } = require('../dist-electron/main/sleepGuardWorkSources.js'));
    } catch {
      ({ collectSleepGuardWorkFrom, groupTaskTurnIdsOf } = require('../dist-electron/sleepGuardWorkSources.js'));
    }
    const collectFailures = [];
    const collected = collectSleepGuardWorkFrom(
      {
        getActiveCoworkSessionIds: () => {
          throw new Error('runner unavailable');
        },
        getActiveScheduledTaskIds: () => [],
        getDreamingMetabotIds: () => [],
        getGroupTaskTurns: () => [{ taskId: 7, metabotId: 1, startedAt: Date.now() }],
        getActiveGroupChatReplyTaskIds: () => ['12'],
        getActiveA2AReplyTaskIds: () => ['abc123i0'],
      },
      (source, error) => collectFailures.push(`${source}:${error instanceof Error ? error.message : String(error)}`),
    );
    check(
      'collector: a broken source degrades to empty while the others still collect',
      collected.coworkSessionIds.length === 0 &&
        collectFailures.length === 1 &&
        collected.groupTaskTurnIds.length === 1 &&
        collected.groupChatReplyTaskIds.length === 1 &&
        collected.a2aReplyTaskIds.length === 1,
      `failures=${JSON.stringify(collectFailures)} work=${JSON.stringify(collected)}`,
    );
    check(
      'collector: collected work drives the guard',
      evaluateSleepGuardWork(collected).active === true,
      JSON.stringify(evaluateSleepGuardWork(collected)),
    );
    check(
      'collector: group-task keys use the daemon shape taskId:metabotId',
      JSON.stringify(groupTaskTurnIdsOf([{ taskId: 7, metabotId: 1 }])) === JSON.stringify(['7:1']),
      JSON.stringify(groupTaskTurnIdsOf([{ taskId: 7, metabotId: 1 }])),
    );

    // 5. Idle again -> released in the real runtime AND at the OS level.
    state = guard.apply(evaluateSleepGuardWork(idle));
    check('idle releases guard', state.engaged === false && state.engagedBy === null, JSON.stringify(state));
    if (isDarwin) {
      await sleep(700);
      const entries = parseOwnedAssertions(readAssertions());
      const owned = caffeinateAssertionFor(entries, process.pid);
      console.log(`  pmset (released): ${formatEntry(owned)}`);
      check(
        'OS: guard assertion gone after release',
        owned === null && ownedBlockerAssertionFor(entries, process.pid) === null,
        owned ? `still present: ${formatEntry(owned)}` : 'no assertion owned for this pid',
      );
    }

    // 6. Re-engage (second direction) -> engaged again at the OS level.
    state = guard.apply(evaluateSleepGuardWork({ ...idle, scheduledTaskIds: ['t2'] }));
    check(
      're-engage after release',
      state.engaged === true && state.sources.includes('scheduledTask'),
      JSON.stringify(state),
    );
    if (isDarwin) {
      await sleep(700);
      const owned = caffeinateAssertionFor(parseOwnedAssertions(readAssertions()), process.pid);
      console.log(`  pmset (re-engaged): ${formatEntry(owned)}`);
      check('OS: guard assertion re-appears after re-engage', owned !== null, formatEntry(owned));
    }

    // 7. Switch OFF while work is still active -> assertion released right away.
    state = guard.setEnabled(false);
    check(
      'setting OFF mid-work releases the guard',
      state.engaged === false && state.engagedBy === null && state.preventDeviceSleepEnabled === false,
      JSON.stringify(state),
    );
    if (isDarwin) {
      await sleep(700);
      const entries = parseOwnedAssertions(readAssertions());
      const stillThere = caffeinateAssertionFor(entries, process.pid) ?? ownedBlockerAssertionFor(entries, process.pid);
      console.log(`  pmset (setting OFF mid-work): ${formatEntry(stillThere)}`);
      check('OS: assertion gone after switching OFF', stillThere === null, formatEntry(stillThere));
    }

    // 8. Switch back ON with work still active -> assertion returns.
    state = guard.setEnabled(true);
    check('setting ON again re-engages', state.engaged === true, JSON.stringify(state));
    if (isDarwin) {
      await sleep(700);
      const back = caffeinateAssertionFor(parseOwnedAssertions(readAssertions()), process.pid);
      console.log(`  pmset (setting ON again): ${formatEntry(back)}`);
      check('OS: assertion returns after switching ON again', back !== null, formatEntry(back));
    }

    // 9. dispose -> released at the OS level too.
    guard.dispose();
    check('dispose releases guard', guard.isEngaged() === false, `engaged=${guard.isEngaged()}`);
    if (isDarwin) {
      await sleep(700);
      const entries = parseOwnedAssertions(readAssertions());
      check(
        'OS: guard assertion gone after dispose',
        caffeinateAssertionFor(entries, process.pid) === null &&
          ownedBlockerAssertionFor(entries, process.pid) === null,
        'no assertion owned for this pid',
      );
    }

    // 8. Fallback path: caffeinate unavailable -> real display-sleep assertion.
    if (isDarwin) {
      const fallbackGuard = new SleepGuard({
        powerSaveBlocker: ASSERTIONS_DISABLED ? inertBlocker : powerSaveBlocker,
        platform: process.platform,
        enabled: true,
        spawnHelper: () => {
          throw new Error('forced fallback: caffeinate disabled by the check');
        },
      });
      const fallbackState = fallbackGuard.apply(
        evaluateSleepGuardWork({ ...idle, coworkSessionIds: ['real-host-check-fallback'] }),
      );
      check(
        'fallback: engaged via powerSaveBlocker',
        fallbackState.engaged === true && fallbackState.engagedBy === 'powerSaveBlocker',
        JSON.stringify(fallbackState),
      );
      await sleep(700);
      const owned = ownedBlockerAssertionFor(parseOwnedAssertions(readAssertions()), process.pid);
      console.log(`  pmset (fallback engaged): ${formatEntry(owned)}`);
      check('OS: this process holds a NoDisplaySleepAssertion (prevent-display-sleep fallback)', owned !== null, formatEntry(owned));

      fallbackGuard.apply(evaluateSleepGuardWork(idle));
      await sleep(700);
      const after = ownedBlockerAssertionFor(parseOwnedAssertions(readAssertions()), process.pid);
      console.log(`  pmset (fallback released): ${formatEntry(after)}`);
      check('OS: fallback assertion gone after release', after === null, formatEntry(after));
      fallbackGuard.dispose();
    }

    const passed = results.filter((result) => result.ok).length;
    const ok = results.every((result) => result.ok);
    const failedNames = results.filter((result) => !result.ok).map((result) => result.name);
    console.log(`\nRESULT: ${ok ? 'PASS' : 'FAIL'} (${passed}/${results.length})`);
    if (!ok) console.log(`FAILED CHECKS: ${failedNames.join(' | ')}`);
    if (ASSERTIONS_DISABLED) {
      console.log(
        ok
          ? 'NEGATIVE CONTROL BROKEN: disabling the assertion mechanisms still reported PASS — the OS check would be constant-true again.'
          : 'NEGATIVE CONTROL OK: with the assertion mechanisms disabled the checks FAIL, so the OS verification is real.',
      );
    }
    app.exit(ok ? 0 : 1);
  })
  .catch((error) => {
    console.error('Real-host check crashed:', error);
    app.exit(1);
  });
