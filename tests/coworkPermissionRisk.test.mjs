import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...segments) => fs.readFileSync(path.join(projectRoot, ...segments), 'utf8');

const runnerSource = readSource('src', 'main', 'libs', 'coworkRunner.ts');

test('coworkRunner wires low-risk auto-approval under full trust only', () => {
  assert.match(runnerSource, /tryAutoAnswerLowRiskQuestion/);
  assert.match(runnerSource, /permissionMode === 'bypassPermissions' && resolvedName === 'AskUserQuestion'/);
  assert.match(runnerSource, /updatedInput: \{ \.\.\.resolvedInput, answers: autoAnswers \}/);
  // The interactive fall-through must stay reachable for unmarked questions.
  assert.match(runnerSource, /acceptEdits \/ bypassPermissions \+ AskUserQuestion: fall through to the prompt below/);
});

test('safety prompt tells agents about the auto-confirm marker under full trust', () => {
  assert.match(runnerSource, /Under bypassPermissions only, low-risk confirmations/);
  assert.match(runnerSource, /header "auto-confirm" to auto-approve/);
  assert.match(runnerSource, /keep high-risk confirmations unmarked/);
});

test('low-risk marked questions auto-answer with their first option', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-risk-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const outputFile = path.join(tempDir, 'permission-risk.mjs');
  await build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: `export { tryAutoAnswerLowRiskQuestion, LOW_RISK_QUESTION_HEADER } from './src/main/libs/coworkPermissionRisk.ts';`,
      resolveDir: projectRoot,
      sourcefile: 'permission-risk-entry.ts',
      loader: 'ts',
    },
    outfile: outputFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { tryAutoAnswerLowRiskQuestion, LOW_RISK_QUESTION_HEADER } = await import(
    `${pathToFileURL(outputFile).href}?test=${Date.now()}`
  );

  assert.equal(LOW_RISK_QUESTION_HEADER, 'auto-confirm');

  // Single low-risk question -> auto-answer with the first option.
  assert.deepEqual(
    tryAutoAnswerLowRiskQuestion({
      questions: [{
        question: 'Delete merged branch feat/x?',
        header: 'auto-confirm',
        options: [
          { label: '删除（推荐）', description: '已合并，安全' },
          { label: '保留', description: '先不删' },
        ],
      }],
    }),
    { 'Delete merged branch feat/x?': '删除（推荐）' },
  );

  // Multiple low-risk questions -> one auto-answer per question.
  assert.deepEqual(
    tryAutoAnswerLowRiskQuestion({
      questions: [
        { question: 'Q1', header: 'auto-confirm', options: [{ label: 'A1' }, { label: 'B1' }] },
        { question: 'Q2', header: 'auto-confirm', options: [{ label: 'A2' }] },
      ],
    }),
    { Q1: 'A1', Q2: 'A2' },
  );

  // Unmarked question (normal high-risk confirmation) -> no auto-answer.
  assert.equal(
    tryAutoAnswerLowRiskQuestion({
      questions: [{
        question: 'rm -rf /tmp/x?',
        header: '安全确认',
        options: [{ label: '允许' }, { label: '拒绝' }],
      }],
    }),
    null,
  );

  // Mixed marking -> entire payload rejected (all-or-nothing).
  assert.equal(
    tryAutoAnswerLowRiskQuestion({
      questions: [
        { question: 'Q1', header: 'auto-confirm', options: [{ label: 'A1' }] },
        { question: 'Q2', header: '安全确认', options: [{ label: 'A2' }] },
      ],
    }),
    null,
  );

  // Multi-select cannot be faithfully auto-answered -> rejected.
  assert.equal(
    tryAutoAnswerLowRiskQuestion({
      questions: [{
        question: 'Which to delete?',
        header: 'auto-confirm',
        multiSelect: true,
        options: [{ label: 'a' }, { label: 'b' }],
      }],
    }),
    null,
  );

  // Empty options / missing question text -> rejected.
  assert.equal(
    tryAutoAnswerLowRiskQuestion({ questions: [{ header: 'auto-confirm', options: [] }] }),
    null,
  );
  assert.equal(
    tryAutoAnswerLowRiskQuestion({ questions: [{ question: '', header: 'auto-confirm', options: [{ label: 'x' }] }] }),
    null,
  );
  assert.equal(tryAutoAnswerLowRiskQuestion({}), null);
  assert.equal(tryAutoAnswerLowRiskQuestion(null), null);
  assert.equal(tryAutoAnswerLowRiskQuestion('nope'), null);
});
