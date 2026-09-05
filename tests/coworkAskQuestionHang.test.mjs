// Regression coverage for the 2026-09-04 incident: a DSH ask_user_question
// whose prompt never reached a human wedged the cowork session in "running"
// with no log line and no self-healing (session cw-1403e05c-…). The ask path
// had no timeout (approvals got one in waitForPermissionResponse), the hub
// dropped controller-less asks silently, and the question wizard could render
// null while holding the pending-permission queue.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...segments) => fs.readFileSync(path.join(projectRoot, ...segments), 'utf8');

const runnerSource = readSource('src', 'main', 'libs', 'coworkRunner.ts');
const hubSource = readSource('src', 'main', 'libs', 'coworkDshTurn.ts');
const kernelSource = readSource('src', 'main', 'libs', 'dshKernel', 'dshKernel.ts');
const wizardSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkQuestionWizard.tsx');
const i18nSource = readSource('src', 'renderer', 'services', 'i18n.ts');

const onAskRequestBody = (() => {
  const start = runnerSource.indexOf('onAskRequest: (ask) => {');
  assert.notEqual(start, -1, 'coworkRunner must register onAskRequest');
  const end = runnerSource.indexOf('onAskCancelled:', start);
  assert.notEqual(end, -1);
  return runnerSource.slice(start, end);
})();

test('ask_user_question modal path auto-answers with the recommended option after the shared 60s ceiling', () => {
  assert.match(onAskRequestBody, /setTimeout\(\(\) => \{[\s\S]*?PERMISSION_RESPONSE_TIMEOUT_MS\)/);
  assert.match(onAskRequestBody, /unanswered for 60s; auto-answering with the recommended option where one exists/);
  assert.match(onAskRequestBody, /pickRecommendedOptionLabel\(q\.options\)/);
  // The model must be able to tell the pick was automatic, not the user's.
  assert.match(onAskRequestBody, /Auto-selected the recommended option because the user did not answer within 60s\./);
  // Questions without options still count as unanswered rather than hanging.
  assert.match(onAskRequestBody, /The user did not answer within 60s\./);
  assert.match(onAskRequestBody, /hub\.respondAsk\(ask\.id, timeoutAnswers\)/);
});

test('ask timeout is cleared when the question settles through any path', () => {
  assert.match(onAskRequestBody, /clearTimeout\(askTimeout\)/);
  // The timeout settles by deleting the pending entry, so a question already
  // answered/cancelled/aborted (entry gone) is a silent no-op.
  assert.match(onAskRequestBody, /if \(!this\.pendingPermissions\.delete\(ask\.id\)\) return;/);
  assert.match(onAskRequestBody, /askTimeout\.unref\?\.\(\)/);
});

test('raising an ask leaves a forensics trail in cowork.log', () => {
  assert.match(onAskRequestBody, /ask_user_question awaiting user answer/);
});

test('hub declines asks that have no live turn controller instead of dropping them silently', () => {
  const start = hubSource.indexOf('onAskRequest: (ask) => {');
  assert.notEqual(start, -1, 'dshTurnHub must register onAskRequest');
  const end = hubSource.indexOf('onAskCancelled:', start);
  const body = hubSource.slice(start, end);
  assert.match(body, /no live turn controller for its DSH session; auto-declining/);
  assert.match(body, /kernelOf\(\)\.respondAsk\(/);
  assert.match(body, /The user could not be reached for this question\./);
});

test('hub declines asks when a live controller has no host callback', () => {
  const start = hubSource.indexOf('onAskRequest: (ask) => {');
  const end = hubSource.indexOf('onAskCancelled:', start);
  const body = hubSource.slice(start, end);
  assert.match(body, /const onAskRequest = controller\?\.cb\.onAskRequest/);
  assert.match(body, /!controller \|\| !onAskRequest/);
  assert.match(body, /no host callback for its DSH session; auto-declining/);
  assert.match(body, /kernelOf\(\)\.respondAsk\(/);
});

test('ask bridge assigns ids when the model omits them', () => {
  const pluginSource = readSource('dsh-runtime', 'plugins', 'idbots-sdk-server.mjs');
  assert.match(pluginSource, /rawId.*typeof value\.id === 'string'/);
  assert.match(pluginSource, /`q-\$\{index \+ 1\}`/);
  assert.match(kernelSource, /const rawQuestions = Array\.isArray\(params\.questions\)/);
});

test('question wizard never renders null while holding the permission queue', () => {
  assert.doesNotMatch(wizardSource, /if \(questions\.length === 0\) \{\s*return null;\s*\}/);
  assert.match(wizardSource, /coworkQuestionWizardUnavailable/);
  assert.match(wizardSource, /coworkQuestionWizardDismiss/);
});

test('wizard fallback copy exists in both locales', () => {
  for (const key of ['coworkQuestionWizardUnavailable', 'coworkQuestionWizardUnavailableBody', 'coworkQuestionWizardDismiss']) {
    const occurrences = i18nSource.split(`${key}:`).length - 1;
    assert.ok(occurrences >= 2, `${key} must be defined in both the zh and en locale tables (found ${occurrences})`);
  }
});
