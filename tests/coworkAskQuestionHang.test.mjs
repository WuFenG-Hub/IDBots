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
const panelSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkPermissionPanel.tsx');
const overlaySource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkPermissionOverlay.tsx');
const sessionDetailSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkSessionDetail.tsx');
const appSource = readSource('src', 'renderer', 'App.tsx');
const i18nSource = readSource('src', 'renderer', 'services', 'i18n.ts');

const onAskRequestBody = (() => {
  const start = runnerSource.indexOf('onAskRequest: (ask) => {');
  assert.notEqual(start, -1, 'coworkRunner must register onAskRequest');
  const end = runnerSource.indexOf('onAskCancelled:', start);
  assert.notEqual(end, -1);
  return runnerSource.slice(start, end);
})();

test('ask_user_question modal path auto-answers with the recommended option after the per-question backstop', () => {
  // Per-question pacing: the renderer wizard owns a 120s window per displayed
  // step; the main-process watchdog is a backstop scaled by question count so
  // it never fires before the last step's window.
  assert.match(runnerSource, /const ASK_PER_QUESTION_TIMEOUT_MS = 120_000;/);
  assert.match(onAskRequestBody, /const backstopMs = ASK_PER_QUESTION_TIMEOUT_MS \* Math\.max\(1, \(ask\.questions \?\? \[\]\)\.length\);/);
  assert.match(onAskRequestBody, /setTimeout\(\(\) => \{[\s\S]*?\}, backstopMs\)/);
  assert.match(onAskRequestBody, /backstop elapsed \(120s per question\); auto-answering with the recommended option where one exists/);
  assert.match(onAskRequestBody, /pickRecommendedOptionLabel\(q\.options\)/);
  // The model must be able to tell the pick was automatic, not the user's.
  assert.match(onAskRequestBody, /Auto-selected the recommended option because the user did not answer within the 120s per-question window\./);
  // Questions without options still count as unanswered rather than hanging.
  assert.match(onAskRequestBody, /The user did not answer within the 120s per-question window\./);
  assert.match(onAskRequestBody, /hub\.respondAsk\(ask\.id, timeoutAnswers\)/);
});

test('plan reviews and long-term-task defining sessions are exempt from the ask timeout', () => {
  assert.match(onAskRequestBody, /kind === 'plan-review'/);
  // Defining-phase detection: reverse-lookup the session in the long-term
  // task store; only the definition chat of a task still in 'defining' stage
  // counts (subtask execution sessions keep the normal timeout).
  assert.match(onAskRequestBody, /findBySessionId\(sessionId\)/);
  assert.match(onAskRequestBody, /hit\.subtask === null && hit\.task\.stage === 'defining'/);
  assert.match(onAskRequestBody, /const timeoutExempt = isPlanReviewAsk \|\| isLongTermDefiningSession;/);
  assert.match(onAskRequestBody, /perQuestionTimeoutMs: timeoutExempt \? null : ASK_PER_QUESTION_TIMEOUT_MS/);
  assert.match(onAskRequestBody, /if \(!timeoutExempt\) \{/);
});

test('the question wizard arms a fresh per-question timer as each step is displayed', () => {
  // The renderer owns the real per-question pacing: one timer per step,
  // keyed on currentStep, auto-picking the recommended option when the step
  // lapses unanswered, and submitting everything when the last step lapses.
  assert.match(panelSource, /permission\.perQuestionTimeoutMs/);
  assert.match(panelSource, /window\.setTimeout\(\(\) => \{[\s\S]*?\}, timeoutMs\)/);
  assert.match(panelSource, /if \(alreadyAnswered\) return;/);
  assert.match(panelSource, /pickRecommendedOptionLabel\(question\.options\)/);
  // Auto-picks are reported to main so the wire answers carry the
  // "auto-selected" note the model sees.
  assert.match(panelSource, /autoAnswered: Array\.from\(autoAnsweredRef\.current\)/);
  assert.match(onAskRequestBody, /\?\.autoAnswered/);
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

test('composer takeover never renders null while holding the permission queue', () => {
  // A malformed question payload must degrade to an actionable denial card
  // instead of a null render wedging the pending-permission queue.
  assert.doesNotMatch(panelSource, /if \(questions\.length === 0\) \{\s*return null;\s*\}/);
  assert.match(panelSource, /const isMalformedQuestion =/);
  // The deny affordance renders unconditionally, so the queue can always drain.
  assert.match(panelSource, /onClick=\{handleDeny\}/);
  assert.match(panelSource, /behavior: 'deny'/);
});

test('approval owns the active session composer slot instead of a viewport overlay', () => {
  assert.doesNotMatch(panelSource, /fixed\s+inset-x-0\s+bottom-0/);
  assert.match(panelSource, /data-cowork-composer-takeover/);
  assert.match(sessionDetailSource, /pendingPermissions\.find\(\(permission\) => permission\.sessionId === currentSession\.id\)/);
  assert.match(sessionDetailSource, /pendingPermission \? \([\s\S]*?<CoworkPermissionPanel[\s\S]*?: \([\s\S]*?<CoworkPromptInput/);
  assert.doesNotMatch(appSource, /\{permissionPanel\}/);
  assert.doesNotMatch(overlaySource, /<CoworkPermissionPanel/);
  assert.match(overlaySource, /cowork:viewSession/);
  assert.match(overlaySource, /line-clamp-2/);
});

test('safety approvals use their structured tool context instead of ordinary question controls', () => {
  assert.match(panelSource, /parseSafetyContext/);
  assert.match(panelSource, /context\.requestedToolName/);
  assert.match(panelSource, /context\.requestedToolInput/);
  assert.match(panelSource, /isSafetyApproval/);
  assert.match(panelSource, /coworkApprovalAllowDelete/);
});

test('single-select choices and custom answers stay mutually exclusive', () => {
  assert.match(panelSource, /if \(!question\.multiSelect\) \{[\s\S]*?delete next\[currentStep\]/);
  assert.match(panelSource, /if \(!currentQuestion\.multiSelect && value\.trim\(\)\) \{[\s\S]*?delete next\[currentQuestion\.question\]/);
});

test('multi-step custom answers advance before the final submit', () => {
  // A custom answer on the current question is enough to enable the primary
  // action and move forward. It must not be gated on every later question.
  assert.match(panelSource, /const isCurrentQuestionComplete = Boolean\(currentQuestion && \([\s\S]*?answers\[currentQuestion\.question\]\?\.trim\(\)[\s\S]*?otherInputs\[currentStep\]\?\.trim\(\)[\s\S]*?skippedQuestions\[currentQuestion\.question\] === true[\s\S]*?\)\);/);
  assert.match(panelSource, /const handleNextQuestion = \(\) => \{[\s\S]*?!isCurrentQuestionComplete[\s\S]*?setCurrentStep\(\(step\) => Math\.min\(step \+ 1, totalSteps - 1\)\);[\s\S]*?\};/);
  assert.match(panelSource, /const handleQuestionPrimaryAction = \(\) => \{[\s\S]*?if \(!isLastStep\) \{[\s\S]*?handleNextQuestion\(\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?handleApprove\(\);[\s\S]*?\};/);

  // Only the last step submits, and it still requires every question to be
  // answered or explicitly skipped.
  assert.match(panelSource, /onClick=\{handleQuestionPrimaryAction\}/);
  assert.match(panelSource, /disabled=\{responding \|\| \(isLastStep \? !isQuestionComplete : !isCurrentQuestionComplete\)\}/);
  assert.match(panelSource, /i18nService\.t\(isLastStep \? 'coworkQuestionWizardSubmit' : 'coworkQuestionWizardNext'\)/);

  // Enter mirrors the primary button, while IME composition must not submit.
  assert.match(panelSource, /event\.key !== 'Enter' \|\| event\.nativeEvent\.isComposing/);
  assert.match(panelSource, /event\.preventDefault\(\);[\s\S]*?handleQuestionPrimaryAction\(\);/);
});

test('composer takeover copy exists in both locales', () => {
  for (const key of [
    'coworkQuestionWizardOther',
    'coworkQuestionWizardPrevious',
    'coworkQuestionWizardNext',
    'coworkQuestionSkipThis',
    'coworkApprovalWaiting',
    'coworkApprovalAllowOnce',
    'coworkApprovalAllowDelete',
  ]) {
    const occurrences = i18nSource.split(`${key}:`).length - 1;
    assert.ok(occurrences >= 2, `${key} must be defined in both the zh and en locale tables (found ${occurrences})`);
  }
});
