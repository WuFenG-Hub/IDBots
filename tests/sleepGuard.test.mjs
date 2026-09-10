import test from 'node:test';
import assert from 'node:assert/strict';

let evaluateSleepGuardWork;
let SleepGuard;
try {
  ({ evaluateSleepGuardWork, SleepGuard } = await import('../dist-electron/main/sleepGuard.js'));
} catch {
  ({ evaluateSleepGuardWork, SleepGuard } = await import('../dist-electron/sleepGuard.js'));
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
const idle = { coworkSessionIds: [], scheduledTaskIds: [], dreamingMetabotIds: [] };
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
});

test('evaluateSleepGuardWork: multiple active sources are all reported', () => {
  const state = evaluateSleepGuardWork({
    coworkSessionIds: ['s1', 's2'],
    scheduledTaskIds: ['t1'],
    dreamingMetabotIds: [1, 2, 3],
  });
  assert.equal(state.active, true);
  assert.deepEqual(state.sources, ['cowork', 'scheduledTask', 'dream']);
});

// ── non-darwin: legacy powerSaveBlocker('prevent-app-suspension') ────────────

test('SleepGuard (linux): engages prevent-app-suspension and releases when idle', () => {
  const blocker = createFakeBlocker('prevent-app-suspension');
  const spawnHelper = createFakeSpawn();
  const guard = new SleepGuard({ powerSaveBlocker: blocker, platform: 'linux', spawnHelper });

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
  const guard = new SleepGuard({ powerSaveBlocker: blocker, platform: 'win32' });
  const state = guard.apply(evaluateSleepGuardWork(working));
  assert.equal(state.engagedBy, 'powerSaveBlocker');
  assert.deepEqual(blocker.startCalls(), ['prevent-app-suspension']);
});

// ── darwin: caffeinate holds the supported assertion ────────────────────────

test('SleepGuard (darwin): spawns caffeinate -i -w <pid> and kills it on release', () => {
  const blocker = createFakeBlocker();
  const helper = createFakeHelper(9001);
  const spawnHelper = createFakeSpawn(() => helper);
  const guard = new SleepGuard({
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
  const guard = new SleepGuard({ powerSaveBlocker: blocker, platform: 'darwin', spawnHelper });

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
  const guard = new SleepGuard({
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
  const guard = new SleepGuard({
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
  const guard = new SleepGuard({
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
  const guard = new SleepGuard({ powerSaveBlocker: blocker, platform: 'darwin', spawnHelper });

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
  const guard = new SleepGuard({
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
  const darwinGuard = new SleepGuard({
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
  });

  const blocker = createFakeBlocker('prevent-app-suspension');
  const guard = new SleepGuard({ powerSaveBlocker: blocker, platform: 'linux' });
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
  const guard = new SleepGuard({ powerSaveBlocker: failingBlocker, platform: 'linux', warn: silentWarn });
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
  const guard = new SleepGuard({
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
