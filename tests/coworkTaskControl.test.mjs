import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';

const require = Module.createRequire(import.meta.url);

function loadCompiledModule(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => path.join(process.cwd(), '.cowork-temp', 'cowork-task-control-test-user-data'),
        },
        session: { defaultSession: { resolveProxy: async () => 'DIRECT' } },
      };
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

const { CoworkRunner } = loadCompiledModule('../dist-electron/main/libs/coworkRunner.js');

const makeRunnerWithControl = (control) => {
  const runner = new CoworkRunner({}, { localTurnStallTimeoutMs: 0 });
  const activeSession = {
    sessionId: 's1',
    sdkTaskControl: control,
  };
  runner.activeSessions.set('s1', activeSession);
  return runner;
};

test('stopSubagentTask delegates to the live SDK control', async () => {
  let calledWith = null;
  const control = { stopTask: async (id) => { calledWith = id; }, backgroundTasks: async () => false };
  const runner = makeRunnerWithControl(control);

  const result = await runner.stopSubagentTask('s1', '  task-42  ');
  assert.equal(result.success, true);
  assert.equal(calledWith, 'task-42');
});

test('stopSubagentTask reports missing control', async () => {
  const runner = new CoworkRunner({}, { localTurnStallTimeoutMs: 0 });
  const result = await runner.stopSubagentTask('missing', 'task-42');
  assert.equal(result.success, false);
  assert.match(result.error, /unavailable/i);
});

test('stopSubagentTask rejects empty task ids', async () => {
  const control = { stopTask: async () => {}, backgroundTasks: async () => false };
  const runner = makeRunnerWithControl(control);
  const result = await runner.stopSubagentTask('s1', '   ');
  assert.equal(result.success, false);
  assert.match(result.error, /Missing task id/i);
});

test('stopSubagentTask surfaces control errors', async () => {
  const control = { stopTask: async () => { throw new Error('stop exploded'); }, backgroundTasks: async () => false };
  const runner = makeRunnerWithControl(control);
  const result = await runner.stopSubagentTask('s1', 'task-42');
  assert.equal(result.success, false);
  assert.equal(result.error, 'stop exploded');
});

test('backgroundSubagentTask forwards the toolUseId', async () => {
  let calledWith = 'unset';
  const control = { stopTask: async () => {}, backgroundTasks: async (id) => { calledWith = id; return true; } };
  const runner = makeRunnerWithControl(control);

  const result = await runner.backgroundSubagentTask('s1', 'tool-use-1');
  assert.equal(result.success, true);
  assert.equal(result.backgrounded, true);
  assert.equal(calledWith, 'tool-use-1');
});

test('backgroundSubagentTask omits empty toolUseId (background all)', async () => {
  let calledWith = 'unset';
  const control = { stopTask: async () => {}, backgroundTasks: async (id) => { calledWith = id; return false; } };
  const runner = makeRunnerWithControl(control);

  const result = await runner.backgroundSubagentTask('s1', '   ');
  assert.equal(result.success, true);
  assert.equal(result.backgrounded, false);
  assert.equal(calledWith, undefined);
});

test('backgroundSubagentTask reports missing control and errors', async () => {
  const runner = new CoworkRunner({}, { localTurnStallTimeoutMs: 0 });
  const missing = await runner.backgroundSubagentTask('missing', 'tool-use-1');
  assert.equal(missing.success, false);
  assert.match(missing.error, /unavailable/i);

  const control = { stopTask: async () => {}, backgroundTasks: async () => { throw new Error('bg exploded'); } };
  const runner2 = makeRunnerWithControl(control);
  const failed = await runner2.backgroundSubagentTask('s1', 'tool-use-1');
  assert.equal(failed.success, false);
  assert.equal(failed.error, 'bg exploded');
});
