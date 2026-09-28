import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const loadCoworkService = async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-session-throttle-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const outputFile = path.join(tempDir, 'cowork-service.mjs');

  await build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: `export { coworkService } from './src/renderer/services/cowork.ts';`,
      resolveDir: projectRoot,
      sourcefile: 'cowork-throttle-test-entry.ts',
      loader: 'ts',
    },
    outfile: outputFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    plugins: [{
      name: 'observable-cowork-store',
      setup(esbuild) {
        esbuild.onResolve({ filter: /^\.\.\/store$/ }, (args) => {
          if (!args.importer.endsWith('/src/renderer/services/cowork.ts')) return null;
          return { path: 'cowork-throttle-store', namespace: 'cowork-throttle-test' };
        });
        esbuild.onLoad(
          { filter: /^cowork-throttle-store$/, namespace: 'cowork-throttle-test' },
          () => ({
            loader: 'js',
            contents: `
              export const store = {
                dispatch(action) {
                  globalThis.__coworkThrottleDispatches.push(action);
                  return action;
                },
                getState() {
                  return { cowork: { sessions: [], currentSessionId: null, currentSession: null } };
                },
              };
            `,
          }),
        );
      },
    }],
  });

  const { coworkService } = await import(`${pathToFileURL(outputFile).href}?test=${Date.now()}`);
  return coworkService;
};

/** Records every list read, how long it stayed open, and the peak overlap. */
const stubElectron = (t, { readDelayMs = 0 } = {}) => {
  const state = { reads: 0, openReads: 0, peakOpenReads: 0 };
  const readDelay = () =>
    readDelayMs > 0
      ? new Promise((resolve) => setTimeout(resolve, readDelayMs))
      : Promise.resolve();

  globalThis.__coworkThrottleDispatches = [];
  globalThis.window = {
    electron: {
      cowork: {
        listSessions: async () => {
          state.reads += 1;
          state.openReads += 1;
          state.peakOpenReads = Math.max(state.peakOpenReads, state.openReads);
          await readDelay();
          state.openReads -= 1;
          return { success: true, sessions: [] };
        },
        listMetabotAvatars: async () => ({ success: true, avatars: [] }),
      },
    },
  };
  t.after(() => {
    delete globalThis.window;
    delete globalThis.__coworkThrottleDispatches;
  });
  return state;
};

test('the first (init) session load reads at once, without the trailing delay', async (t) => {
  const coworkService = await loadCoworkService(t);
  const state = stubElectron(t);

  const startedAt = Date.now();
  await coworkService.loadSessions();
  assert.equal(state.reads, 1);
  assert.equal(globalThis.__coworkThrottleDispatches.length, 1);
  assert.ok(Date.now() - startedAt < 300, 'idle load must not wait for the debounce window');
});

test('a burst of refresh requests collapses into one trailing read', async (t) => {
  const coworkService = await loadCoworkService(t);
  const state = stubElectron(t, { readDelayMs: 40 });

  const burst = [
    coworkService.loadSessions(),
    coworkService.loadSessions(),
    coworkService.loadSessions(),
    coworkService.loadSessions(),
    coworkService.loadSessions(),
  ];
  assert.equal(state.reads, 1, 'the burst leader reads immediately');

  await Promise.all(burst);
  assert.equal(state.reads, 2, 'the whole burst shares a single trailing read');
  assert.equal(state.peakOpenReads, 1, 'reads never overlap');
  assert.equal(globalThis.__coworkThrottleDispatches.length, 2);
});

test('requests arriving during an in-flight read queue one follow-up read', async (t) => {
  const coworkService = await loadCoworkService(t);
  const state = stubElectron(t, { readDelayMs: 60 });

  const leader = coworkService.loadSessions();
  const queued = [coworkService.loadSessions(), coworkService.loadSessions()];
  assert.equal(state.reads, 1);

  await leader;
  assert.equal(state.reads, 1, 'a queued request never runs concurrently with the read it found');

  await Promise.all(queued);
  assert.equal(state.reads, 2);
  assert.equal(state.peakOpenReads, 1);
});

test('sequential awaited loads stay one read each and never overlap', async (t) => {
  const coworkService = await loadCoworkService(t);
  const state = stubElectron(t, { readDelayMs: 20 });

  await coworkService.loadSessions();
  await coworkService.loadSessions();
  await coworkService.loadSessions();

  assert.equal(state.reads, 3);
  assert.equal(state.peakOpenReads, 1);
});

test('a failing list read leaves the queued callers resolved', async (t) => {
  const coworkService = await loadCoworkService(t);
  const state = stubElectron(t, { readDelayMs: 40 });
  let failNext = true;
  globalThis.window.electron.cowork.listSessions = async () => {
    state.reads += 1;
    if (failNext) {
      failNext = false;
      throw new Error('list read down');
    }
    return { success: true, sessions: [] };
  };

  const leader = coworkService.loadSessions();
  const queued = coworkService.loadSessions();
  await assert.rejects(leader, /list read down/);
  await queued;
  assert.equal(state.reads, 2);
});
