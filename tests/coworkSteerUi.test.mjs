import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...segments) => fs.readFileSync(path.join(projectRoot, ...segments), 'utf8');

const inputSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkPromptInput.tsx');
const viewSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkView.tsx');
const detailSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkSessionDetail.tsx');
const i18nSource = readSource('src', 'renderer', 'services', 'i18n.ts');

test('streaming composer derives the stop/send-steer truth table from text', async (t) => {
  assert.doesNotMatch(inputSource, /\|\| isStreaming \|\| disabled\) return/);
  assert.match(inputSource, /const hasTextInput = Boolean\(value\.trim\(\)\)/);
  assert.match(inputSource, /isStreaming && \(!hasTextInput \|\| steerDisabled\)/);
  assert.match(inputSource, /isStreaming && hasTextInput && !steerDisabled/);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-steer-ui-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const outputFile = path.join(tempDir, 'prompt-state.mjs');
  await build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: `export { deriveCoworkPromptInputState } from './src/renderer/components/cowork/CoworkPromptInput.tsx';`,
      resolveDir: projectRoot,
      sourcefile: 'prompt-state-entry.ts',
      loader: 'ts',
    },
    outfile: outputFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { deriveCoworkPromptInputState } = await import(`${pathToFileURL(outputFile).href}?test=${Date.now()}`);

  assert.deepEqual(
    deriveCoworkPromptInputState({ value: '', isStreaming: true, disabled: false, steerDisabled: false, attachmentCount: 0 }),
    { hasTextInput: false, isSteerSubmit: false, showStopButton: true, canSubmit: false },
  );
  assert.deepEqual(
    deriveCoworkPromptInputState({ value: '  adjust direction  ', isStreaming: true, disabled: false, steerDisabled: false, attachmentCount: 3 }),
    { hasTextInput: true, isSteerSubmit: true, showStopButton: false, canSubmit: true },
  );
  assert.deepEqual(
    deriveCoworkPromptInputState({ value: '', isStreaming: false, disabled: false, steerDisabled: true, attachmentCount: 1 }),
    { hasTextInput: false, isSteerSubmit: false, showStopButton: false, canSubmit: true },
  );
  assert.equal(
    deriveCoworkPromptInputState({ value: 'ignored', isStreaming: true, disabled: true, steerDisabled: false, attachmentCount: 0 }).canSubmit,
    false,
  );
  assert.deepEqual(
    deriveCoworkPromptInputState({ value: 'cannot steer', isStreaming: true, disabled: false, steerDisabled: true, attachmentCount: 0 }),
    { hasTextInput: true, isSteerSubmit: false, showStopButton: true, canSubmit: false },
  );
});

test('running composer keeps dynamic configuration disabled and sends trimmed text only', () => {
  assert.match(inputSource, /disabled=\{disabled \|\| isStreaming\}/);
  assert.match(inputSource, /coworkSteerPlaceholder/);
  assert.match(inputSource, /isStreaming\s*\?\s*trimmedValue/);
  assert.match(inputSource, /if \(isStreaming && !trimmedValue\) return/);
  assert.match(inputSource, /event\.key === 'Enter'[\s\S]*?handleSubmit\(\)/);
});

test('each pending submission owns an independent versioned draft snapshot', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-steer-concurrency-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const outputFile = path.join(tempDir, 'submission-coordinator.mjs');
  await build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: `export * from './src/renderer/components/cowork/coworkPromptSubmission.ts';`,
      resolveDir: projectRoot,
      sourcefile: 'submission-coordinator-entry.ts',
      loader: 'ts',
    },
    outfile: outputFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { createVersionedComposerField, runComposerSubmission } = await import(
    `${pathToFileURL(outputFile).href}?test=${Date.now()}`
  );
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  };
  const visibleValues = [];
  const field = createVersionedComposerField('', () => '', (value) => visibleValues.push(value));
  const calls = [];

  field.set('ordinary A');
  const snapshotA = field.takeAndClear();
  const resultA = deferred();
  const pendingA = runComposerSubmission(field, snapshotA, () => {
    calls.push(snapshotA.value);
    return resultA.promise;
  });
  field.set('steer B');
  const snapshotB = field.takeAndClear();
  const resultB = deferred();
  const pendingB = runComposerSubmission(field, snapshotB, () => {
    calls.push(snapshotB.value);
    return resultB.promise;
  });
  assert.deepEqual(calls, ['ordinary A', 'steer B']);

  field.set('newer draft C');
  resultA.resolve(true);
  await pendingA;
  assert.equal(field.get(), 'newer draft C');
  resultB.resolve(false);
  await pendingB;
  assert.equal(field.get(), 'newer draft C');
  assert.equal(visibleValues.includes('ordinary A', 2), false);

  field.set('sync failure draft');
  const syncFailureSnapshot = field.takeAndClear();
  await assert.rejects(
    runComposerSubmission(field, syncFailureSnapshot, () => {
      throw new Error('sync failure');
    }),
    /sync failure/,
  );
  assert.equal(field.get(), 'sync failure draft');
});

test('a pending steer does not block the next FIFO steer submission', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-steer-fifo-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const outputFile = path.join(tempDir, 'submission-coordinator.mjs');
  await build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: `export * from './src/renderer/components/cowork/coworkPromptSubmission.ts';`,
      resolveDir: projectRoot,
      sourcefile: 'submission-coordinator-entry.ts',
      loader: 'ts',
    },
    outfile: outputFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { createVersionedComposerField, runComposerSubmission } = await import(
    `${pathToFileURL(outputFile).href}?test=${Date.now()}`
  );
  let resolveFirst;
  const firstResult = new Promise((resolve) => { resolveFirst = resolve; });
  const calls = [];
  const field = createVersionedComposerField('', () => '', () => {});
  field.set('steer A');
  const first = field.takeAndClear();
  const pendingFirst = runComposerSubmission(field, first, () => {
    calls.push(first.value);
    return firstResult;
  });
  field.set('steer B');
  const second = field.takeAndClear();
  const pendingSecond = runComposerSubmission(field, second, () => {
    calls.push(second.value);
    return Promise.resolve(true);
  });
  await pendingSecond;
  assert.deepEqual(calls, ['steer A', 'steer B']);
  resolveFirst(true);
  await pendingFirst;
});

test('CoworkView submits one UUID, preserves ordinary configuration, and restores failed drafts', () => {
  assert.match(viewSource, /submissionId:\s*crypto\.randomUUID\(\)/);
  assert.match(viewSource, /coworkService\.submitInput/);
  assert.match(viewSource, /const sessionSkillIds = isStreaming \? \[\] : \[\.\.\.activeSkillIds\]/);
  assert.match(viewSource, /const systemPrompt = isStreaming \? undefined : await buildCombinedSystemPrompt\(skillPrompt\)/);
  assert.doesNotMatch(viewSource, /dispatch\(setDraftPrompt\(prompt\)\)/);
  assert.match(viewSource, /setSubmitError\(null\)/);
  assert.match(viewSource, /submitErrorSessionIdRef\.current === currentSession\.id \? submitError : null/);
  assert.doesNotMatch(viewSource, /dispatch\(addMessage/);
});

test('running sandbox disables steer text and send while keeping Stop active', () => {
  assert.match(inputSource, /steerDisabled\?: boolean/);
  assert.match(inputSource, /disabled=\{disabled \|\| \(isStreaming && steerDisabled\)\}/);
  assert.doesNotMatch(inputSource, /onClick=\{handleStopClick\}[\s\S]{0,120}disabled=/);
  assert.match(detailSource, /window\.electron(?:\?|)\.cowork\?\.getSession\?\.\(currentSession\.id\)/);
  assert.match(detailSource, /if \(!isStreaming \|\| !currentSession\?\.id\) \{[\s\S]*?setLiveExecutionMode\(null\)/);
  assert.match(detailSource, /resolvedExecutionMode !== 'local'/);
  assert.match(detailSource, /coworkSteerSandboxUnavailableHint/);
  assert.match(i18nSource, /coworkSteerSandboxUnavailablePlaceholder/);
});

test('timeline labels every honest steer state and explains the local-only boundary', () => {
  assert.match(detailSource, /interactionKind.*steer/s);
  for (const key of [
    'coworkSteerStatusQueued',
    'coworkSteerStatusDelivered',
    'coworkSteerStatusSettled',
    'coworkSteerStatusFailed',
    'coworkSteerStatusCancelled',
    'coworkSteerLocalOnlyHint',
  ]) {
    assert.match(i18nSource, new RegExp(key));
  }
  assert.doesNotMatch(i18nSource, /MetaBot 已遵循|MetaBot followed|direction completed/i);
});

test('submission errors are localized for every typed IPC failure code', () => {
  for (const code of [
    'invalid_input',
    'session_not_found',
    'unsupported_session',
    'unsupported_execution',
    'delivery_failed',
  ]) {
    assert.match(i18nSource, new RegExp(`coworkSubmitError\\.${code}`));
  }
  assert.match(detailSource, /role="alert"/);
});
