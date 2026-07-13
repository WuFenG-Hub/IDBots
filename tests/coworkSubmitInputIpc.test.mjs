import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...segments) => fs.readFileSync(path.join(projectRoot, ...segments), 'utf8');

const mainSource = readSource('src', 'main', 'main.ts');
const preloadSource = readSource('src', 'main', 'preload.ts');
const coworkTypes = readSource('src', 'renderer', 'types', 'cowork.ts');
const electronTypes = readSource('src', 'renderer', 'types', 'electron.d.ts');
const serviceSource = readSource('src', 'renderer', 'services', 'cowork.ts');

test('wires exactly one cowork submitInput handler across the typed Electron boundary', () => {
  assert.equal(
    mainSource.match(/ipcMain\.handle\('cowork:session:submitInput'/g)?.length ?? 0,
    1,
  );
  assert.match(
    mainSource,
    /withSqliteRecovery\('cowork:session:submitInput',[\s\S]*?getCoworkTurnSubmissionController\(\)\.submit\(input\)/,
  );
  assert.match(mainSource, /ipcMain\.handle\('cowork:session:continue'/);
  assert.doesNotMatch(mainSource, /coworkRunner\.on\('steer(?:Settled|Failed)'/);
  assert.match(
    mainSource,
    /new CoworkTurnSubmissionController\(\{[\s\S]*?store: getCoworkStore\(\),[\s\S]*?runner: getCoworkRunner\(\),[\s\S]*?emitMessage: emitCoworkStreamMessage,[\s\S]*?emitMessageUpdate: \([\s\S]*?sessionId: string,[\s\S]*?messageId: string,[\s\S]*?content: string,[\s\S]*?metadata: CoworkMessageMetadata,[\s\S]*?emitCoworkStreamMessageUpdate\(sessionId, messageId, \{ content, metadata \}\);/,
  );
  assert.match(preloadSource, /submitInput:[\s\S]*?cowork:session:submitInput/);
  assert.match(electronTypes, /submitInput: \(input: CoworkSubmitInput\) => Promise<CoworkSubmitInputResult>/);
  assert.match(serviceSource, /async submitInput\(input: CoworkSubmitInput\): Promise<CoworkSubmitInputResult>/);
});

test('mirrors the exact submit request and discriminated result union without any', () => {
  for (const source of [coworkTypes, electronTypes]) {
    assert.match(source, /interface CoworkSubmitInput \{[\s\S]*?sessionId: string;[\s\S]*?submissionId: string;[\s\S]*?text: string;[\s\S]*?systemPrompt\?: string;[\s\S]*?activeSkillIds\?: string\[\];[\s\S]*?\}/);
    assert.match(source, /type CoworkSubmitInputResult =[\s\S]*?success: true;[\s\S]*?mode: 'steer' \| 'continue';[\s\S]*?message: CoworkMessage;[\s\S]*?success: false;[\s\S]*?code: CoworkSubmitInputErrorCode;[\s\S]*?error: string;/);
    const boundary = source.slice(
      source.indexOf('CoworkSubmitInput'),
      source.indexOf('CoworkSubmitInput') + 1_800,
    );
    assert.match(boundary, /CoworkSubmitInputErrorCode[\s\S]*?'cancelled'/);
    assert.doesNotMatch(boundary, /\bany\b/);
  }
});

test('renderer service returns steer, continue, IPC failure, and unavailable fallback honestly', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-submit-input-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const outputFile = path.join(tempDir, 'cowork-service.mjs');

  await build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: `export { coworkService } from './src/renderer/services/cowork.ts';`,
      resolveDir: projectRoot,
      sourcefile: 'cowork-service-test-entry.ts',
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
          return { path: 'cowork-submit-store', namespace: 'cowork-submit-test' };
        });
        esbuild.onLoad(
          { filter: /^cowork-submit-store$/, namespace: 'cowork-submit-test' },
          () => ({
            loader: 'js',
            contents: `
              export const store = {
                dispatch(action) {
                  globalThis.__coworkSubmitDispatches.push(action);
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

  const calls = [];
  globalThis.__coworkSubmitDispatches = [];
  globalThis.window = {
    electron: {
      cowork: {
        submitInput: async (input) => {
          calls.push(input);
          if (input.text === 'complete-race') {
            globalThis.__coworkSubmitDispatches.push({
              type: 'cowork/updateSessionStatus',
              payload: { sessionId: input.sessionId, status: 'completed' },
            });
            return { success: true, mode: 'continue', message: { id: input.submissionId } };
          }
          return input.text === 'steer'
            ? { success: true, mode: 'steer', message: { id: input.submissionId } }
            : input.text === 'continue'
              ? { success: true, mode: 'continue', message: { id: input.submissionId } }
              : { success: false, code: 'delivery_failed', error: 'transport failed' };
        },
      },
    },
  };
  t.after(() => {
    delete globalThis.window;
    delete globalThis.__coworkSubmitDispatches;
  });

  const { coworkService } = await import(`${pathToFileURL(outputFile).href}?test=${Date.now()}`);
  const base = { sessionId: 'session-1', submissionId: '11111111-1111-4111-8111-111111111111' };
  assert.equal((await coworkService.submitInput({ ...base, text: 'steer' })).mode, 'steer');
  assert.deepEqual(globalThis.__coworkSubmitDispatches, []);
  assert.equal((await coworkService.submitInput({ ...base, text: 'continue' })).mode, 'continue');
  assert.deepEqual(globalThis.__coworkSubmitDispatches, []);

  assert.equal((await coworkService.submitInput({ ...base, text: 'complete-race' })).mode, 'continue');
  assert.deepEqual(globalThis.__coworkSubmitDispatches, [{
    type: 'cowork/updateSessionStatus',
    payload: { sessionId: 'session-1', status: 'completed' },
  }]);
  assert.equal(globalThis.__coworkSubmitDispatches.some((action) => action.type === 'cowork/addMessage'), false);
  globalThis.__coworkSubmitDispatches.length = 0;

  assert.deepEqual(await coworkService.submitInput({ ...base, text: 'fail' }), {
    success: false,
    code: 'delivery_failed',
    error: 'transport failed',
  });
  assert.deepEqual(globalThis.__coworkSubmitDispatches, []);
  assert.equal(calls.length, 4);

  globalThis.window.electron.cowork.submitInput = async () => {
    throw new Error('IPC rejected');
  };
  await assert.doesNotReject(async () => {
    assert.deepEqual(await coworkService.submitInput({ ...base, text: 'throw' }), {
      success: false,
      code: 'delivery_failed',
      error: 'IPC rejected',
    });
  });
  assert.deepEqual(globalThis.__coworkSubmitDispatches, []);

  globalThis.window.electron.cowork.submitInput = () => {
    throw new Error('IPC threw synchronously');
  };
  await assert.doesNotReject(async () => {
    assert.deepEqual(await coworkService.submitInput({ ...base, text: 'sync-throw' }), {
      success: false,
      code: 'delivery_failed',
      error: 'IPC threw synchronously',
    });
  });
  assert.deepEqual(globalThis.__coworkSubmitDispatches, []);

  delete globalThis.window.electron.cowork.submitInput;
  assert.deepEqual(await coworkService.submitInput({ ...base, text: 'missing' }), {
    success: false,
    code: 'delivery_failed',
    error: 'Cowork submit API not available',
  });
  assert.deepEqual(globalThis.__coworkSubmitDispatches, []);

  const methodBody = serviceSource.match(/async submitInput\([\s\S]*?\n {2}\}/)?.[0] ?? '';
  assert.doesNotMatch(methodBody, /dispatch\(addMessage/);
});

test('submission controller is disposed before SQLite-backed singletons reset', () => {
  assert.match(
    mainSource,
    /coworkTurnSubmissionController\?\.dispose\(\);[\s\S]*?coworkTurnSubmissionController = null;[\s\S]*?coworkStore = null;/,
  );
});
