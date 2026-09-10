import test from 'node:test';
import assert from 'node:assert/strict';

let evaluateSleepGuardWork;
let resolvePreventDeviceSleepEnabled;
let PREVENT_DEVICE_SLEEP_SETTING_KEY;
let SleepGuard;
let collectSleepGuardWorkFrom;
let groupTaskTurnIdsOf;
try {
  ({ evaluateSleepGuardWork, resolvePreventDeviceSleepEnabled, PREVENT_DEVICE_SLEEP_SETTING_KEY, SleepGuard } =
    await import('../dist-electron/main/sleepGuard.js'));
} catch {
  ({ evaluateSleepGuardWork, resolvePreventDeviceSleepEnabled, PREVENT_DEVICE_SLEEP_SETTING_KEY, SleepGuard } =
    await import('../dist-electron/sleepGuard.js'));
}
({ collectSleepGuardWorkFrom, groupTaskTurnIdsOf } = await import('../dist-electron/main/sleepGuardWorkSources.js'));

// The three work-source getters that back the group-task / group-chat / A2A
// sources. Imported for real so the test fails if the main process keeps
// compiling against getters that no longer exist (a rename would otherwise
// silently leave those sources empty forever).
let getGroupTaskTurnActivity;
let getActiveGroupChatReplyTaskIds;
let getActiveA2AReplyTaskIds;
try {
  ({ getGroupTaskTurnActivity } = await import('../dist-electron/main/services/groupTaskDaemon.js'));
  ({ getActiveGroupChatReplyTaskIds } = await import('../dist-electron/main/services/cognitiveOrchestrator.js'));
  ({ getActiveA2AReplyTaskIds } = await import('../dist-electron/main/services/privateChatDaemon.js'));
} catch (error) {
  console.error('Failed to load the real work-source getters:', error);
}

/**
 * Test guard factory for the "setting is ON" scenarios: sleep prevention is
 * opt-in, so every legacy behaviour test has to opt in explicitly. Tests for the
 * default-OFF gate construct `new SleepGuard(...)` directly.
 */
function createGuard(options) {
  return new SleepGuard({ enabled: true, ...options });
}

/**
 * Fake `powerSaveBlocker`. `expectedType` pins the blocker type the platform
 * dispatch must use ('prevent-app-suspension' off macOS, 'prevent-display-sleep'
 * on the macOS fallback path).
 */
function createFakeBlocker(expectedType) {
  const started = new Map();
  const startCalls = [];
  let nextId = 1;
  return {
    start(type) {
      startCalls.push(type);
      if (expectedType !== undefined) {
        assert.equal(type, expectedType, `must use ${expectedType}`);
      }
      const id = nextId++;
      started.set(id, true);
      return id;
    },
    stop(id) {
      started.set(id, false);
    },
    isStarted(id) {
      return started.get(id) === true;
    },
    startedCount: () => [...started.values()].filter(Boolean).length,
    startCalls: () => [...startCalls],
  };
}

/** Fake spawned `caffeinate` helper: records args / kill, models exit events. */
function createFakeHelper(pid = 4321) {
  const listeners = new Map();
  return {
    pid,
    killCalls: 0,
    unrefCalls: 0,
    kill() {
      this.killCalls += 1;
      return true;
    },
    unref() {
      this.unrefCalls += 1;
    },
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return this;
    },
    removeListener(event, listener) {
      const list = listeners.get(event) ?? [];
      listeners.set(
        event,
        list.filter((item) => item !== listener),
      );
      return this;
    },
    emit(event) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener();
    },
    listenerCount: (event) => (listeners.get(event) ?? []).length,
  };
}

/** Spawn seam stub: records every (command, args) call and returns fake helpers. */
function createFakeSpawn(impl) {
  const calls = [];
  const spawnHelper = (command, args) => {
    calls.push({ command, args: [...args] });
    if (impl) return impl(command, args);
    return createFakeHelper();
  };
  spawnHelper.calls = () => calls.map((call) => ({ command: call.command, args: [...call.args] }));
  return spawnHelper;
}

/** Silent logger for tests that deliberately exercise failure/fallback paths. */
const silentWarn = () => {};

const CAFFEINATE_PATH = '/usr/bin/caffeinate';
const idle = {
  coworkSessionIds: [],
  scheduledTaskIds: [],
  dreamingMetabotIds: [],
  groupTaskTurnIds: [],
  groupChatReplyTaskIds: [],
  a2aReplyTaskIds: [],
};
const working = { ...idle, coworkSessionIds: ['s1'] };

test('evaluateSleepGuardWork: idle input yields inactive with no sources', () => {
  const state = evaluateSleepGuardWork(idle);
  assert.equal(state.active, false);
  assert.deepEqual(state.sources, []);
});

test('evaluateSleepGuardWork: each work source is detected', () => {
  assert.deepEqual(evaluateSleepGuardWork({ ...idle, coworkSessionIds: ['s1'] }), {
    active: true,
    sources: ['cowork'],
  });
  assert.deepEqual(evaluateSleepGuardWork({ ...idle, scheduledTaskIds: ['t1'] }), {
    active: true,
    sources: ['scheduledTask'],
  });
  assert.deepEqual(evaluateSleepGuardWork({ ...idle, dreamingMetabotIds: [1] }), {
    active: true,
    sources: ['dream'],
  });
  assert.deepEqual(evaluateSleepGuardWork({ ...idle, groupTaskTurnIds: ['7:1'] }), {
    active: true,
    sources: ['groupTask'],
  });
  assert.deepEqual(evaluateSleepGuardWork({ ...idle, groupChatReplyTaskIds: ['12'] }), {
    active: true,
    sources: ['groupChat'],
  });
  assert.deepEqual(evaluateSleepGuardWork({ ...idle, a2aReplyTaskIds: ['abc123i0'] }), {
    active: true,
    sources: ['a2aChat'],
  });
});

test('evaluateSleepGuardWork: multiple active sources are all reported', () => {
  const state = evaluateSleepGuardWork({
    coworkSessionIds: ['s1', 's2'],
    scheduledTaskIds: ['t1'],
    dreamingMetabotIds: [1, 2, 3],
    groupTaskTurnIds: ['7:1'],
    groupChatReplyTaskIds: ['12'],
    a2aReplyTaskIds: ['abc123i0'],
  });
  assert.equal(state.active, true);
  assert.deepEqual(state.sources, ['cowork', 'scheduledTask', 'dream', 'groupTask', 'groupChat', 'a2aChat']);
});

// ── work sources that are not cowork sessions ───────────────────────────────

test('SleepGuard (darwin): an in-process group-task turn alone holds the assertion', () => {
  const blocker = createFakeBlocker();
  const helper = createFakeHelper(5150);
  const spawnHelper = createFakeSpawn(() => helper);
  const guard = createGuard({ powerSaveBlocker: blocker, platform: 'darwin', spawnHelper });

  // Group-task turns are multi-minute: chair planning / verification / chain
  // sends / deliverable uploads run in-process with no cowork session behind
  // them, so this source alone must engage the guard.
  const engaged = guard.apply(evaluateSleepGuardWork({ ...idle, groupTaskTurnIds: ['7:1'] }));
  assert.equal(engaged.active, true);
  assert.deepEqual(engaged.sources, ['groupTask']);
  assert.equal(engaged.engaged, true);
  assert.equal(engaged.engagedBy, 'caffeinate');
  assert.deepEqual(spawnHelper.calls()[0].args, ['-i', '-w', String(process.pid)]);

  // The session-less plain reply paths are the same story.
  assert.equal(
    guard.apply(evaluateSleepGuardWork({ ...idle, groupChatReplyTaskIds: ['12'] })).engaged,
    true,
  );
  assert.equal(guard.apply(evaluateSleepGuardWork({ ...idle, a2aReplyTaskIds: ['abc123i0'] })).engaged, true);
  assert.equal(spawnHelper.calls().length, 1, 'one helper for all of them — engagement is idempotent');

  // Turn settles -> the guard releases and the helper is reaped.
  const released = guard.apply(evaluateSleepGuardWork(idle));
  assert.equal(released.active, false);
  assert.deepEqual(released.sources, []);
  assert.equal(released.engaged, false);
  assert.equal(released.engagedBy, null);
  assert.equal(helper.killCalls, 1);
});

// ── work-source collection seam ─────────────────────────────────────────────

const emptyGetters = {
  getActiveCoworkSessionIds: () => [],
  getActiveScheduledTaskIds: () => [],
  getDreamingMetabotIds: () => [],
  getGroupTaskTurns: () => [],
  getActiveGroupChatReplyTaskIds: () => [],
  getActiveA2AReplyTaskIds: () => [],
};

test('collectSleepGuardWorkFrom: idle getters collect an all-empty work input', () => {
  const work = collectSleepGuardWorkFrom(emptyGetters);
  assert.deepEqual(work, {
    coworkSessionIds: [],
    scheduledTaskIds: [],
    dreamingMetabotIds: [],
    groupTaskTurnIds: [],
    groupChatReplyTaskIds: [],
    a2aReplyTaskIds: [],
  });
  assert.equal(evaluateSleepGuardWork(work).active, false);
});

test('collectSleepGuardWorkFrom: every source is collected into its own slot', () => {
  const work = collectSleepGuardWorkFrom({
    getActiveCoworkSessionIds: () => ['s1'],
    getActiveScheduledTaskIds: () => ['t1'],
    getDreamingMetabotIds: () => [3],
    getGroupTaskTurns: () => [{ taskId: 7, metabotId: 1, startedAt: 1 }],
    getActiveGroupChatReplyTaskIds: () => ['12'],
    getActiveA2AReplyTaskIds: () => ['abc123i0'],
  });
  assert.deepEqual(work, {
    coworkSessionIds: ['s1'],
    scheduledTaskIds: ['t1'],
    dreamingMetabotIds: [3],
    groupTaskTurnIds: ['7:1'],
    groupChatReplyTaskIds: ['12'],
    a2aReplyTaskIds: ['abc123i0'],
  });
  assert.deepEqual(evaluateSleepGuardWork(work).sources, [
    'cowork',
    'scheduledTask',
    'dream',
    'groupTask',
    'groupChat',
    'a2aChat',
  ]);
});

test('collectSleepGuardWorkFrom: one broken source degrades to empty, never throws', () => {
  const failures = [];
  const work = collectSleepGuardWorkFrom(
    {
      ...emptyGetters,
      getActiveCoworkSessionIds: () => {
        throw new Error('runner torn down');
      },
      getActiveGroupChatReplyTaskIds: () => null, // non-array return
      getGroupTaskTurns: () => [{ taskId: 7, metabotId: 1, startedAt: 1 }],
    },
    (source, error) => failures.push({ source, message: error instanceof Error ? error.message : String(error) }),
  );

  assert.deepEqual(work.coworkSessionIds, [], 'throwing getter yields an empty list');
  assert.deepEqual(work.groupChatReplyTaskIds, [], 'non-array getter yields an empty list');
  assert.deepEqual(work.groupTaskTurnIds, ['7:1'], 'healthy sources still collected');
  assert.deepEqual(failures, [
    { source: 'cowork', message: 'runner torn down' },
    { source: 'groupChat', message: 'sleepGuardWorkSources: unexpected non-array work source value' },
  ]);
  // The guard still engages from the surviving source: a broken collector can
  // never leave real work unguarded.
  assert.equal(evaluateSleepGuardWork(work).active, true);
  assert.deepEqual(evaluateSleepGuardWork(work).sources, ['groupTask']);
});

test('groupTaskTurnIdsOf: turns map to the daemon key shape taskId:metabotId', () => {
  assert.deepEqual(groupTaskTurnIdsOf([]), []);
  assert.deepEqual(
    groupTaskTurnIdsOf([
      { taskId: 7, metabotId: 1 },
      { taskId: 12, metabotId: 44 },
    ]),
    ['7:1', '12:44'],
  );
});

test('real work-source getters exist and report no work when the app is idle', () => {
  assert.equal(typeof getGroupTaskTurnActivity, 'function', 'groupTaskDaemon.getGroupTaskTurnActivity');
  assert.equal(typeof getActiveGroupChatReplyTaskIds, 'function', 'cognitiveOrchestrator.getActiveGroupChatReplyTaskIds');
  assert.equal(typeof getActiveA2AReplyTaskIds, 'function', 'privateChatDaemon.getActiveA2AReplyTaskIds');

  // Note: these run in a plain node process (no app), which is exactly the
  // "no daemon running" state -> truthful empty lists, never a throw.
  assert.deepEqual(getGroupTaskTurnActivity(), []);
  assert.deepEqual(getActiveGroupChatReplyTaskIds(), []);
  assert.deepEqual(getActiveA2AReplyTaskIds(), []);

  const work = collectSleepGuardWorkFrom({
    ...emptyGetters,
    getGroupTaskTurns: () => getGroupTaskTurnActivity(),
    getActiveGroupChatReplyTaskIds: () => getActiveGroupChatReplyTaskIds(),
    getActiveA2AReplyTaskIds: () => getActiveA2AReplyTaskIds(),
  });
  assert.equal(evaluateSleepGuardWork(work).active, false);
});

// ── non-darwin: legacy powerSaveBlocker('prevent-app-suspension') ────────────

test('SleepGuard (linux): engages prevent-app-suspension and releases when idle', () => {
  const blocker = createFakeBlocker('prevent-app-suspension');
  const spawnHelper = createFakeSpawn();
  const guard = createGuard({ powerSaveBlocker: blocker, platform: 'linux', spawnHelper });

  const engaged = guard.apply(evaluateSleepGuardWork(working));
  assert.equal(engaged.active, true);
  assert.equal(engaged.engaged, true);
  assert.equal(engaged.engagedBy, 'powerSaveBlocker');
  assert.equal(blocker.startedCount(), 1, 'blocker started exactly once');
  assert.deepEqual(blocker.startCalls(), ['prevent-app-suspension'], 'no darwin type off macOS');
  assert.equal(spawnHelper.calls().length, 0, 'no helper process spawned off macOS');

  const released = guard.apply(evaluateSleepGuardWork(idle));
  assert.equal(released.active, false);
  assert.equal(released.engaged, false);
  assert.equal(released.engagedBy, null);
  assert.equal(blocker.startedCount(), 0, 'blocker released');
});

test('SleepGuard (win32): keeps the legacy blocker type', () => {
  const blocker = createFakeBlocker('prevent-app-suspension');
  const guard = createGuard({ powerSaveBlocker: blocker, platform: 'win32' });
  const state = guard.apply(evaluateSleepGuardWork(working));
  assert.equal(state.engagedBy, 'powerSaveBlocker');
  assert.deepEqual(blocker.startCalls(), ['prevent-app-suspension']);
});

// ── darwin: caffeinate holds the supported assertion ────────────────────────

test('SleepGuard (darwin): spawns caffeinate -i -w <pid> and kills it on release', () => {
  const blocker = createFakeBlocker();
  const helper = createFakeHelper(9001);
  const spawnHelper = createFakeSpawn(() => helper);
  const guard = createGuard({
    powerSaveBlocker: blocker,
    platform: 'darwin',
    spawnHelper,
    parentPid: 4242,
  });

  const engaged = guard.apply(evaluateSleepGuardWork(working));
  assert.equal(engaged.engaged, true);
  assert.equal(engaged.engagedBy, 'caffeinate');

  const calls = spawnHelper.calls();
  assert.equal(calls.length, 1, 'helper spawned exactly once');
  assert.equal(calls[0].command, CAFFEINATE_PATH, 'uses the system caffeinate binary');
  assert.equal(calls[0].args.includes('-i'), true, 'must request prevent-user-idle-system-sleep (-i)');
  assert.equal(calls[0].args.includes('-w'), true, 'must watch the parent pid (-w)');
  assert.deepEqual(calls[0].args, ['-i', '-w', '4242'], 'watches exactly the injected parent pid');
  assert.equal(helper.unrefCalls, 1, 'helper is unref-ed so it cannot keep the loop alive');
  assert.equal(blocker.startedCount(), 0, 'no powerSaveBlocker needed on the caffeinate path');
  assert.deepEqual(guard.getEngagement(), {
    engagedBy: 'caffeinate',
    helperPid: 9001,
    blockerId: null,
    blockerType: null,
  });

  const released = guard.apply(evaluateSleepGuardWork(idle));
  assert.equal(released.engaged, false);
  assert.equal(released.engagedBy, null);
  assert.equal(helper.killCalls, 1, 'helper killed on release');
  assert.deepEqual(guard.getEngagement(), {
    engagedBy: null,
    helperPid: null,
    blockerId: null,
    blockerType: null,
  });
});

test('SleepGuard (darwin): apply is idempotent — one helper for many applies', () => {
  const blocker = createFakeBlocker();
  const spawnHelper = createFakeSpawn();
  const guard = createGuard({ powerSaveBlocker: blocker, platform: 'darwin', spawnHelper });

  guard.apply(evaluateSleepGuardWork(working));
  guard.apply(evaluateSleepGuardWork({ ...idle, coworkSessionIds: ['s1', 's2'] }));
  guard.apply(evaluateSleepGuardWork(idle));
  guard.apply(evaluateSleepGuardWork(idle));

  assert.equal(spawnHelper.calls().length, 1, 'no double-spawn while already engaged');
});

// ── darwin fallback: powerSaveBlocker('prevent-display-sleep') ──────────────

test('SleepGuard (darwin): spawn failure falls back to prevent-display-sleep', () => {
  const blocker = createFakeBlocker('prevent-display-sleep');
  const spawnHelper = createFakeSpawn(() => {
    throw new Error('ENOENT /usr/bin/caffeinate');
  });
  const guard = createGuard({
    powerSaveBlocker: blocker,
    platform: 'darwin',
    spawnHelper,
    warn: silentWarn,
  });

  const engaged = guard.apply(evaluateSleepGuardWork(working));
  assert.equal(engaged.engaged, true, 'still guarded via the fallback');
  assert.equal(engaged.engagedBy, 'powerSaveBlocker');
  assert.deepEqual(blocker.startCalls(), ['prevent-display-sleep']);
  assert.equal(guard.getEngagement().blockerType, 'prevent-display-sleep');

  const released = guard.apply(evaluateSleepGuardWork(idle));
  assert.equal(released.engaged, false);
  assert.equal(released.engagedBy, null);
  assert.equal(blocker.startedCount(), 0);
});

test('SleepGuard (darwin): spawn without a pid falls back to prevent-display-sleep', () => {
  const blocker = createFakeBlocker('prevent-display-sleep');
  const helper = createFakeHelper();
  delete helper.pid;
  const spawnHelper = createFakeSpawn(() => helper);
  const guard = createGuard({
    powerSaveBlocker: blocker,
    platform: 'darwin',
    spawnHelper,
    warn: silentWarn,
  });

  const engaged = guard.apply(evaluateSleepGuardWork(working));
  assert.equal(engaged.engagedBy, 'powerSaveBlocker');
  assert.deepEqual(blocker.startCalls(), ['prevent-display-sleep']);
  assert.equal(helper.killCalls, 1, 'unusable helper is reaped');
});

test('SleepGuard (darwin): helper exiting mid-work swaps to the display-sleep blocker', () => {
  const blocker = createFakeBlocker('prevent-display-sleep');
  const helper = createFakeHelper();
  const spawnHelper = createFakeSpawn(() => helper);
  const changes = [];
  const guard = createGuard({
    powerSaveBlocker: blocker,
    platform: 'darwin',
    spawnHelper,
    warn: silentWarn,
    onChanged: (state) => changes.push(state),
  });

  const engaged = guard.apply(evaluateSleepGuardWork(working));
  assert.equal(engaged.engagedBy, 'caffeinate');

  helper.emit('exit');

  const state = guard.getState();
  assert.equal(state.engaged, true, 'work stays guarded after the helper dies');
  assert.equal(state.engagedBy, 'powerSaveBlocker');
  assert.deepEqual(blocker.startCalls(), ['prevent-display-sleep']);
  assert.equal(changes.at(-1).engagedBy, 'powerSaveBlocker', 'mechanism change is broadcast');
  assert.equal(changes.length, 2, 'engaged then mechanism swap');

  guard.apply(evaluateSleepGuardWork(idle));
  assert.equal(blocker.startedCount(), 0, 'fallback blocker released with the work');
});

test('SleepGuard (darwin): a late helper exit after release does not re-engage', () => {
  const blocker = createFakeBlocker();
  const helper = createFakeHelper();
  const spawnHelper = createFakeSpawn(() => helper);
  const guard = createGuard({ powerSaveBlocker: blocker, platform: 'darwin', spawnHelper });

  guard.apply(evaluateSleepGuardWork(working));
  guard.apply(evaluateSleepGuardWork(idle));
  assert.equal(helper.listenerCount('exit'), 0, 'exit listener detached on release');

  helper.emit('exit'); // stale event delivered late

  const state = guard.getState();
  assert.equal(state.engaged, false);
  assert.equal(state.engagedBy, null);
  assert.equal(blocker.startedCount(), 0, 'no spurious fallback blocker after release');
});

// ── shared behaviour ────────────────────────────────────────────────────────

test('SleepGuard: onChanged fires only when the state actually changes', () => {
  const blocker = createFakeBlocker('prevent-app-suspension');
  const changes = [];
  const guard = createGuard({
    powerSaveBlocker: blocker,
    platform: 'linux',
    onChanged: (state) => changes.push(state),
  });

  guard.apply(evaluateSleepGuardWork(working));
  guard.apply(evaluateSleepGuardWork(working));
  guard.apply(evaluateSleepGuardWork(idle));

  assert.equal(changes.length, 2, 'fired on engage and release only');
  assert.equal(changes[0].engaged, true);
  assert.equal(changes[0].engagedBy, 'powerSaveBlocker');
  assert.equal(changes[1].engaged, false);
});

test('SleepGuard: dispose releases the helper/blocker and resets state', () => {
  const darwinHelper = createFakeHelper();
  const darwinSpawn = createFakeSpawn(() => darwinHelper);
  const darwinGuard = createGuard({
    powerSaveBlocker: createFakeBlocker(),
    platform: 'darwin',
    spawnHelper: darwinSpawn,
  });
  darwinGuard.apply(evaluateSleepGuardWork({ ...idle, dreamingMetabotIds: [7] }));
  assert.equal(darwinGuard.isEngaged(), true);
  darwinGuard.dispose();
  assert.equal(darwinGuard.isEngaged(), false);
  assert.equal(darwinHelper.killCalls, 1, 'dispose reaps the caffeinate helper');
  assert.deepEqual(darwinGuard.getState(), {
    active: false,
    sources: [],
    engaged: false,
    engagedBy: null,
    preventDeviceSleepEnabled: true,
  });

  const blocker = createFakeBlocker('prevent-app-suspension');
  const guard = createGuard({ powerSaveBlocker: blocker, platform: 'linux' });
  guard.apply(evaluateSleepGuardWork({ ...idle, dreamingMetabotIds: [7] }));
  assert.equal(guard.isEngaged(), true);
  guard.dispose();
  assert.equal(guard.isEngaged(), false);
  assert.equal(blocker.startedCount(), 0);
  assert.deepEqual(guard.getState(), {
    active: false,
    sources: [],
    engaged: false,
    engagedBy: null,
    preventDeviceSleepEnabled: true,
  });
});

test('SleepGuard: blocker start failure degrades gracefully', () => {
  const failingBlocker = {
    start() {
      throw new Error('unsupported platform');
    },
    stop() {},
    isStarted() {
      return false;
    },
  };
  const guard = createGuard({ powerSaveBlocker: failingBlocker, platform: 'linux', warn: silentWarn });
  const state = guard.apply(evaluateSleepGuardWork(working));
  assert.equal(state.active, true, 'work state stays truthful');
  assert.equal(state.engaged, false, 'blocker engagement reports failure honestly');
  assert.equal(state.engagedBy, null);
});

test('SleepGuard (darwin): both mechanisms failing reports honest disengagement', () => {
  const failingBlocker = {
    start() {
      throw new Error('blocker unavailable');
    },
    stop() {},
    isStarted() {
      return false;
    },
  };
  const spawnHelper = createFakeSpawn(() => {
    throw new Error('spawn blocked');
  });
  const guard = createGuard({
    powerSaveBlocker: failingBlocker,
    platform: 'darwin',
    spawnHelper,
    warn: silentWarn,
  });
  const state = guard.apply(evaluateSleepGuardWork(working));
  assert.equal(state.active, true);
  assert.equal(state.engaged, false);
  assert.equal(state.engagedBy, null);
  assert.equal(spawnHelper.calls().length, 1, 'caffeinate attempted before falling back');
});

// ── host-level setting: 「阻止设备休眠」 (default OFF) ─────────────────────────

test('resolvePreventDeviceSleepEnabled: missing/odd config values default to OFF', () => {
  assert.equal(resolvePreventDeviceSleepEnabled(undefined), false, 'missing key -> off');
  assert.equal(resolvePreventDeviceSleepEnabled(null), false, 'null -> off');
  assert.equal(resolvePreventDeviceSleepEnabled(false), false, 'explicit false -> off');
  assert.equal(resolvePreventDeviceSleepEnabled('true'), false, 'string "true" -> off');
  assert.equal(resolvePreventDeviceSleepEnabled(1), false, 'number 1 -> off');
  assert.equal(resolvePreventDeviceSleepEnabled({}), false, 'object -> off');
  assert.equal(resolvePreventDeviceSleepEnabled(true), true, 'explicit boolean true -> on');
});

test('SleepGuard: default (no setting) never engages — no spawn, no blocker call', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const blocker = createFakeBlocker();
    const spawnHelper = createFakeSpawn();
    const guard = new SleepGuard({ powerSaveBlocker: blocker, platform, spawnHelper });

    const state = guard.apply(evaluateSleepGuardWork(working));
    assert.equal(state.active, true, 'work is still reported truthfully');
    assert.equal(state.engaged, false, 'nothing is engaged while the setting is off');
    assert.equal(state.engagedBy, null);
    assert.equal(state.preventDeviceSleepEnabled, false);
    assert.equal(spawnHelper.calls().length, 0, `${platform}: no caffeinate spawn`);
    assert.deepEqual(blocker.startCalls(), [], `${platform}: no powerSaveBlocker.start`);
  }
});

test('SleepGuard: setting OFF keeps work unguarded across repeated applies', () => {
  const blocker = createFakeBlocker();
  const spawnHelper = createFakeSpawn();
  const guard = new SleepGuard({
    powerSaveBlocker: blocker,
    platform: 'darwin',
    spawnHelper,
    enabled: false,
  });

  guard.apply(evaluateSleepGuardWork(working));
  guard.apply(evaluateSleepGuardWork({ ...idle, scheduledTaskIds: ['t1'] }));
  guard.apply(evaluateSleepGuardWork({ ...idle, dreamingMetabotIds: [3] }));

  assert.equal(spawnHelper.calls().length, 0);
  assert.deepEqual(blocker.startCalls(), []);
  assert.equal(guard.getState().engaged, false);
});

test('SleepGuard: setEnabled(true) engages immediately while work is active', () => {
  const blocker = createFakeBlocker();
  const helper = createFakeHelper(7777);
  const spawnHelper = createFakeSpawn(() => helper);
  const changes = [];
  const guard = new SleepGuard({
    powerSaveBlocker: blocker,
    platform: 'darwin',
    spawnHelper,
    parentPid: 4242,
    onChanged: (state) => changes.push(state),
  });

  // Work starts while the setting is still off -> nothing happens.
  let state = guard.apply(evaluateSleepGuardWork(working));
  assert.equal(state.engaged, false);
  assert.equal(spawnHelper.calls().length, 0);

  // Flip the setting on -> immediate engagement, no extra apply() needed.
  state = guard.setEnabled(true);
  assert.equal(state.preventDeviceSleepEnabled, true);
  assert.equal(state.engaged, true);
  assert.equal(state.engagedBy, 'caffeinate');
  assert.deepEqual(spawnHelper.calls()[0].args, ['-i', '-w', '4242']);
  assert.equal(changes.at(-1).engaged, true, 'mechanism change is broadcast');

  // Idempotent: applying again does not spawn a second helper.
  guard.apply(evaluateSleepGuardWork(working));
  assert.equal(spawnHelper.calls().length, 1);
});

test('SleepGuard: setEnabled(false) releases immediately and stops further engagement', () => {
  const blocker = createFakeBlocker();
  const helper = createFakeHelper();
  const spawnHelper = createFakeSpawn(() => helper);
  const changes = [];
  const guard = new SleepGuard({
    powerSaveBlocker: blocker,
    platform: 'darwin',
    spawnHelper,
    enabled: true,
    onChanged: (state) => changes.push(state),
  });

  let state = guard.apply(evaluateSleepGuardWork(working));
  assert.equal(state.engagedBy, 'caffeinate');

  state = guard.setEnabled(false);
  assert.equal(state.preventDeviceSleepEnabled, false);
  assert.equal(state.engaged, false);
  assert.equal(state.engagedBy, null);
  assert.equal(helper.killCalls, 1, 'helper reaped immediately');
  assert.equal(changes.at(-1).engaged, false);

  // Work continues, but the guard stays a no-op.
  guard.apply(evaluateSleepGuardWork(working));
  guard.apply(evaluateSleepGuardWork({ ...idle, coworkSessionIds: ['s1', 's2'] }));
  assert.equal(spawnHelper.calls().length, 1, 'no re-spawn while the setting is off');
  assert.deepEqual(blocker.startCalls(), [], 'no blocker started while the setting is off');
});

test('SleepGuard: toggling off then on with work active releases and re-engages', () => {
  const blocker = createFakeBlocker();
  const spawnHelper = createFakeSpawn();
  const guard = new SleepGuard({
    powerSaveBlocker: blocker,
    platform: 'linux',
    spawnHelper,
    enabled: true,
  });

  guard.apply(evaluateSleepGuardWork(working));
  assert.equal(guard.getState().engagedBy, 'powerSaveBlocker');

  guard.setEnabled(false);
  assert.deepEqual(blocker.startCalls(), ['prevent-app-suspension']);
  assert.equal(blocker.startedCount(), 0, 'blocker released when switched off');

  guard.setEnabled(true);
  assert.deepEqual(
    blocker.startCalls(),
    ['prevent-app-suspension', 'prevent-app-suspension'],
    'blocker restarted when switched back on',
  );
  assert.equal(guard.getState().engagedBy, 'powerSaveBlocker');
});

test('config key contract is stable (renaming it would silently reset users to OFF)', () => {
  assert.equal(PREVENT_DEVICE_SLEEP_SETTING_KEY, 'sleep_guard_prevent_device_sleep');
});
