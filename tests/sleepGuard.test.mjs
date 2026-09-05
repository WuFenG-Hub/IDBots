import test from 'node:test';
import assert from 'node:assert/strict';

let evaluateSleepGuardWork;
let SleepGuard;
try {
  ({ evaluateSleepGuardWork, SleepGuard } = await import('../dist-electron/main/sleepGuard.js'));
} catch {
  ({ evaluateSleepGuardWork, SleepGuard } = await import('../dist-electron/sleepGuard.js'));
}

function createFakeBlocker() {
  const started = new Map();
  let nextId = 1;
  return {
    start(type) {
      assert.equal(type, 'prevent-app-suspension', 'must use prevent-app-suspension');
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
  };
}

const idle = { coworkSessionIds: [], scheduledTaskIds: [], dreamingMetabotIds: [] };

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

test('SleepGuard: engages the blocker when work starts and releases when idle', () => {
  const blocker = createFakeBlocker();
  const guard = new SleepGuard({ powerSaveBlocker: blocker });

  const engaged = guard.apply(evaluateSleepGuardWork({ ...idle, coworkSessionIds: ['s1'] }));
  assert.equal(engaged.active, true);
  assert.equal(engaged.engaged, true);
  assert.equal(blocker.startedCount(), 1, 'blocker started exactly once');

  const released = guard.apply(evaluateSleepGuardWork(idle));
  assert.equal(released.active, false);
  assert.equal(released.engaged, false);
  assert.equal(blocker.startedCount(), 0, 'blocker released');
});

test('SleepGuard: apply is idempotent in both directions', () => {
  const blocker = createFakeBlocker();
  const guard = new SleepGuard({ powerSaveBlocker: blocker });

  guard.apply(evaluateSleepGuardWork({ ...idle, coworkSessionIds: ['s1'] }));
  guard.apply(evaluateSleepGuardWork({ ...idle, coworkSessionIds: ['s1', 's2'] }));
  guard.apply(evaluateSleepGuardWork({ ...idle, coworkSessionIds: ['s1'] }));
  assert.equal(blocker.startedCount(), 1, 'no double-start while already engaged');

  guard.apply(evaluateSleepGuardWork(idle));
  guard.apply(evaluateSleepGuardWork(idle));
  assert.equal(blocker.startedCount(), 0, 'no double-stop while already released');
});

test('SleepGuard: onChanged fires only when the state actually changes', () => {
  const blocker = createFakeBlocker();
  const changes = [];
  const guard = new SleepGuard({
    powerSaveBlocker: blocker,
    onChanged: (state) => changes.push(state),
  });

  guard.apply(evaluateSleepGuardWork({ ...idle, coworkSessionIds: ['s1'] }));
  guard.apply(evaluateSleepGuardWork({ ...idle, coworkSessionIds: ['s1'] }));
  guard.apply(evaluateSleepGuardWork(idle));

  assert.equal(changes.length, 2, 'fired on engage and release only');
  assert.equal(changes[0].engaged, true);
  assert.equal(changes[1].engaged, false);
});

test('SleepGuard: dispose releases the blocker and resets state', () => {
  const blocker = createFakeBlocker();
  const guard = new SleepGuard({ powerSaveBlocker: blocker });

  guard.apply(evaluateSleepGuardWork({ ...idle, dreamingMetabotIds: [7] }));
  assert.equal(guard.isEngaged(), true);

  guard.dispose();
  assert.equal(guard.isEngaged(), false);
  assert.equal(blocker.startedCount(), 0);
  assert.deepEqual(guard.getState(), { active: false, sources: [], engaged: false });
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
  const guard = new SleepGuard({ powerSaveBlocker: failingBlocker });
  const state = guard.apply(evaluateSleepGuardWork({ ...idle, coworkSessionIds: ['s1'] }));
  assert.equal(state.active, true, 'work state stays truthful');
  assert.equal(state.engaged, false, 'blocker engagement reports failure honestly');
});
