import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);

function loadCompiledModule(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => process.cwd(),
        },
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

class FakeCoworkStore {
  constructor() {
    this.session = { id: 's-selfheal', status: 'idle', cwd: '' };
    this.messages = [];
    this.messageSeq = 0;
  }

  updateSession(id, patch) {
    assert.equal(id, this.session.id);
    Object.assign(this.session, patch);
  }

  addMessage(id, message) {
    const stored = {
      id: `msg-${++this.messageSeq}`,
      type: message.type,
      content: message.content,
      timestamp: 1_700_000_100_000 + this.messageSeq,
      ...(message.metadata ? { metadata: message.metadata } : {}),
    };
    this.messages.push(stored);
    return stored;
  }

  getSession(id) {
    return id === this.session.id ? this.session : null;
  }
}

function makeActiveSession(sessionId) {
  return {
    sessionId,
    abortController: new AbortController(),
    ipcBridge: undefined,
    sandboxProcess: undefined,
  };
}

function createHarness(cwd) {
  const store = new FakeCoworkStore();
  store.session.cwd = cwd;
  const runner = new CoworkRunner(store);
  // handleError emits an 'error' event; without a listener Node raises
  // ERR_UNHANDLED_ERROR before the store assertions can run.
  runner.on('error', () => {});
  const kernelCalls = [];
  runner.runLocalKernel = async (activeSession, prompt, kernelCwd) => {
    kernelCalls.push(kernelCwd);
  };
  return { store, runner, kernelCalls };
}

test('missing session working directory is recreated and the turn continues', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-cwd-selfheal-'));
  // Multiple missing parents: recursive recreation must fill the whole chain.
  const missingCwd = path.join(base, 'project', 'bots', '1', '2026-08-19');
  const { store, runner, kernelCalls } = createHarness(missingCwd);

  await runner.runClaudeCode(makeActiveSession('s-selfheal'), 'hello', missingCwd, 'system');

  assert.equal(fs.statSync(missingCwd).isDirectory(), true, 'missing cwd should be recreated');
  assert.deepEqual(kernelCalls, [path.resolve(missingCwd)], 'turn should continue into the kernel');
  assert.notEqual(store.session.status, 'error');
  const notice = store.messages.filter((message) => message.type === 'system');
  assert.equal(notice.length, 1, 'exactly one recreation notice should be added');
  assert.match(notice[0].content, /recreated|重建/);
  assert.doesNotMatch(notice[0].content, /^Error:/);
});

test('recreation failure (file on the path) still strands the session with an error', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-cwd-blocked-'));
  const blocker = path.join(base, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  const blockedCwd = path.join(blocker, 'child');
  const { store, runner, kernelCalls } = createHarness(blockedCwd);

  await runner.runClaudeCode(makeActiveSession('s-selfheal'), 'hello', blockedCwd, 'system');

  assert.deepEqual(kernelCalls, [], 'kernel must not run when recreation fails');
  assert.equal(store.session.status, 'error');
  const last = store.messages.at(-1);
  assert.equal(last.type, 'system');
  assert.match(last.content, /^Error: Working directory does not exist and could not be recreated/);
});

test('existing working directory is used as-is without any notice', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-cwd-existing-'));
  const { store, runner, kernelCalls } = createHarness(base);

  await runner.runClaudeCode(makeActiveSession('s-selfheal'), 'hello', base, 'system');

  assert.deepEqual(kernelCalls, [path.resolve(base)]);
  assert.equal(store.messages.length, 0, 'no notice should be added when the cwd exists');
  assert.notEqual(store.session.status, 'error');
});
