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
  assert.match(inputSource, /isStreaming && !hasTextInput/);
  assert.match(inputSource, /isStreaming && hasTextInput/);

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
    deriveCoworkPromptInputState({ value: '', isStreaming: true, disabled: false, attachmentCount: 0 }),
    { hasTextInput: false, isSteerSubmit: false, showStopButton: true, canSubmit: false },
  );
  assert.deepEqual(
    deriveCoworkPromptInputState({ value: '  adjust direction  ', isStreaming: true, disabled: false, attachmentCount: 3 }),
    { hasTextInput: true, isSteerSubmit: true, showStopButton: false, canSubmit: true },
  );
  assert.deepEqual(
    deriveCoworkPromptInputState({ value: '', isStreaming: false, disabled: false, attachmentCount: 1 }),
    { hasTextInput: false, isSteerSubmit: false, showStopButton: false, canSubmit: true },
  );
  assert.equal(
    deriveCoworkPromptInputState({ value: 'ignored', isStreaming: true, disabled: true, attachmentCount: 0 }).canSubmit,
    false,
  );
});

test('running composer keeps dynamic configuration disabled and sends trimmed text only', () => {
  assert.match(inputSource, /disabled=\{disabled \|\| isStreaming\}/);
  assert.match(inputSource, /coworkSteerPlaceholder/);
  assert.match(inputSource, /isStreaming\s*\?\s*trimmedValue/);
  assert.match(inputSource, /if \(isStreaming && !trimmedValue\) return/);
  assert.match(inputSource, /event\.key === 'Enter'[\s\S]*?handleSubmit\(\)/);
});

test('only existing-session submissions wait before clearing the visible draft', () => {
  assert.match(inputSource, /waitForSubmitResult\?: boolean/);
  assert.match(inputSource, /waitForSubmitResult\s*\?\s*await/);
  assert.match(detailSource, /<CoworkPromptInput[\s\S]*?waitForSubmitResult/);
  assert.equal(viewSource.match(/waitForSubmitResult/g)?.length ?? 0, 0);
});

test('CoworkView submits one UUID, preserves ordinary configuration, and restores failed drafts', () => {
  assert.match(viewSource, /submissionId:\s*crypto\.randomUUID\(\)/);
  assert.match(viewSource, /coworkService\.submitInput/);
  assert.match(viewSource, /const sessionSkillIds = isStreaming \? \[\] : \[\.\.\.activeSkillIds\]/);
  assert.match(viewSource, /const systemPrompt = isStreaming \? undefined : await buildCombinedSystemPrompt\(skillPrompt\)/);
  assert.match(viewSource, /dispatch\(setDraftPrompt\(prompt\)\)/);
  assert.match(viewSource, /setSubmitError\(null\)/);
  assert.match(viewSource, /submitErrorSessionIdRef\.current === currentSession\.id \? submitError : null/);
  assert.doesNotMatch(viewSource, /dispatch\(addMessage/);
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
