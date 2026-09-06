import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const copy = require('../dist-electron/main/libs/groupTaskCopy.js');

const CJK = /[\u4e00-\u9fff]/;

test('group task copy: zh welcome keeps historical wording and notice prefix', () => {
  const text = copy.buildMemberJoinWelcomeText({
    taskTitle: 'Build app',
    joinerName: 'Alicia',
    invitedFor: 'search',
    existingMemberNames: ['Coder Bot'],
  }, 'zh');
  assert.equal(copy.hasGroupTaskNotice(text, copy.GROUP_TASK_NOTICE.welcome), true);
  assert.match(text, /欢迎 @Alicia 加入任务「Build app」/);
  assert.match(text, /受邀参与:search/);
  assert.match(text, /请确认在线/);
  assert.equal(copy.isRollCallPresenceCheck(text), true);
});

test('group task copy: en host messages have no Chinese and still trip detectors', () => {
  const welcome = copy.buildMemberJoinWelcomeText({
    taskTitle: 'Build app',
    joinerName: 'Alicia',
    invitedFor: 'search',
    existingMemberNames: ['Coder Bot'],
  }, 'en');
  assert.equal(CJK.test(welcome), false);
  assert.match(welcome, /Welcome @Alicia to task "Build app"/);
  assert.match(welcome, /Please confirm you are online/);
  assert.equal(copy.isRollCallPresenceCheck(welcome), true);

  const closing = copy.buildReviewClosingLine('Build app', 'en');
  assert.equal(CJK.test(closing), false);
  assert.equal(copy.hasGroupTaskNotice(closing, copy.GROUP_TASK_NOTICE.reviewClosing), true);

  const pause = copy.buildCheckpointPauseLine({
    taskId: 1,
    taskTitle: 'Build app',
    topic: 'plan',
    summaryClause: copy.copyCheckpointNeedDecision('approve draft', 'en'),
  }, 'en');
  assert.equal(CJK.test(pause), false);
  assert.match(pause, /human checkpoint/);

  const longTurn = copy.buildLongTurnStandbyNote('Coder Bot', 'en');
  assert.equal(CJK.test(longTurn), false);

  const ack = copy.copyWorkingAckFallback('write the spec', 'en');
  assert.equal(CJK.test(ack), false);
  assert.match(ack, /^\[WORKING\]/);

  const orch = copy.buildOrchNotifyCompleted('Builder', 9, 'en');
  assert.equal(CJK.test(orch), false);
  assert.match(orch, /\[ORCH-NOTIFY\]/);

  const wrap = copy.wrapCrossSessionMessage('group-task:1', '[GROUP_TASK_REVIEW] done', 'en');
  assert.equal(CJK.test(wrap), false);
  assert.match(wrap, /^From group-task:1: /);

  const responding = copy.copyRespondingPlaceholder('en');
  assert.equal(CJK.test(responding), false);
  assert.equal(responding, 'Responding…');
});

test('group task copy: acceptance summary English has notice prefix and no CJK chrome', () => {
  const labels = copy.acceptanceSummaryCopy('en');
  const header = labels.header('Build app');
  assert.equal(CJK.test(header), false);
  assert.match(header, /has entered acceptance/);
  const guidance = copy.buildAcceptanceGuidanceText('en');
  assert.equal(CJK.test(guidance), false);
  const notice = copy.withGroupTaskNotice(copy.GROUP_TASK_NOTICE.reviewSummary, header);
  assert.equal(copy.isAcceptanceSummaryNotice(notice), true);
  assert.equal(copy.isAcceptanceSummaryNotice('📦 任务「T」已进入验收阶段，以下为成果汇总。'), true);
});

test('group task copy: origin-session notices keep protocol tags in both languages', () => {
  const zh = copy.buildSourceSessionReviewNotice({
    title: 'T',
    versionTag: copy.copyReviewVersionTag(1, 'zh'),
    conclusion: '验收通过',
  }, 'zh');
  assert.match(zh, /^\[GROUP_TASK_REVIEW\] 任务「T」已进入验收（验收摘要 v1）。/);

  const en = copy.buildSourceSessionReviewNotice({
    title: 'T',
    versionTag: copy.copyReviewVersionTag(1, 'en'),
    conclusion: 'Accept and close',
  }, 'en');
  assert.match(en, /^\[GROUP_TASK_REVIEW\] Task "T" has entered acceptance \(acceptance summary v1\)\./);
  assert.equal(CJK.test(en), false);
});

test('group task copy: long-turn chair reminder flags a missing ACK instead of "no reply needed" (task #64)', () => {
  const calm = copy.copyLongTurnChairReminder('Coder Bot', 18, { language: 'zh' });
  assert.match(calm, /无需回应/);
  const ackPending = copy.copyLongTurnChairReminder('Coder Bot', 18, { ackPending: true, language: 'zh' });
  assert.doesNotMatch(ackPending, /无需回应/);
  assert.match(ackPending, /尚未对派单回过 \[WORKING\] ACK/);
  const enCalm = copy.copyLongTurnChairReminder('Coder Bot', 18, { language: 'en' });
  assert.match(enCalm, /need not reply/i);
  const enPending = copy.copyLongTurnChairReminder('Coder Bot', 18, { ackPending: true, language: 'en' });
  assert.doesNotMatch(enPending, /need not reply/i);
  assert.match(enPending, /has NOT sent a \[WORKING\] ACK/);
});
