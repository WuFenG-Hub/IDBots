import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  detectSkipConfirmInWish,
  classifyOwnerStaffingReply,
  pickTriggeringWishText,
  resolveStaffingOwnerGate,
  splitSessionMessagesForStaffingGate,
  buildStaffingSlateText,
  isStaffingProposalExpired,
  STAFFING_PROPOSAL_TTL_MS,
} = require('../dist-electron/main/services/groupTaskStaffing.js');

const plan = {
  stages: [{ id: 'copy', title: 'Write', seatRole: 'content', dependsOn: [] }],
  seats: [{
    role: 'content',
    candidateName: 'Coder Bot',
    source: 'local',
    reason: 'writes',
  }],
};

test('skip-confirm does not match 开发 or interrogatives', () => {
  assert.equal(detectSkipConfirmInWish('能直接开发吗？'), false);
  assert.equal(detectSkipConfirmInWish('可以直接开会吗'), false);
  assert.equal(detectSkipConfirmInWish('开个群任务做技能介绍，不用确认直接开'), true);
  assert.equal(detectSkipConfirmInWish('just start without confirmation'), true);
});

test('不换人 is confirm; 换人 is revise', () => {
  assert.equal(classifyOwnerStaffingReply('好的，不换人'), 'confirm');
  assert.equal(classifyOwnerStaffingReply('不用换'), 'confirm');
  assert.equal(classifyOwnerStaffingReply('换人，用设计师'), 'revise');
  assert.equal(classifyOwnerStaffingReply('确认人选'), 'confirm');
});

test('owner replies beat a skip wish, and skip is only the triggering wish', () => {
  const messages = [
    { type: 'user', content: '上次那个不用确认直接开', timestamp: 1 },
    { type: 'user', content: '这次开个群任务做技能介绍', timestamp: 2 },
    { type: 'assistant', content: 'slate', timestamp: 3 },
    { type: 'user', content: '换人', timestamp: 4 },
  ];
  assert.equal(pickTriggeringWishText(messages, 3), '这次开个群任务做技能介绍');
  const split = splitSessionMessagesForStaffingGate(messages, 3);
  assert.equal(split.triggeringWish, '这次开个群任务做技能介绍');
  assert.deepEqual(split.repliesAfterPropose, ['换人']);
  assert.deepEqual(
    resolveStaffingOwnerGate({
      triggeringWish: '开个群任务，不用确认直接开',
      repliesAfterPropose: ['换人'],
      persistedSkip: true,
    }),
    { allowed: false, decision: 'owner_revise' },
  );
  assert.deepEqual(
    resolveStaffingOwnerGate({
      triggeringWish: '开个群任务做技能介绍',
      repliesAfterPropose: [],
    }),
    { allowed: false, decision: 'awaiting_owner' },
  );
});

test('slate language follows Settings when omitted', () => {
  const zh = buildStaffingSlateText({
    title: '技能介绍',
    goal: '写出介绍',
    plan,
    ownerConfirmRequired: true,
  });
  assert.match(zh, /确认人选/);
  const en = buildStaffingSlateText({
    title: 'Skill intro',
    goal: 'Write it',
    plan,
    ownerConfirmRequired: true,
    language: 'en',
  });
  assert.match(en, /Please confirm this roster/);
});

test('staffing proposals expire after 24 hours', () => {
  const now = 1_800_000_000_000;
  assert.equal(isStaffingProposalExpired(now - STAFFING_PROPOSAL_TTL_MS + 1, now), false);
  assert.equal(isStaffingProposalExpired(now - STAFFING_PROPOSAL_TTL_MS - 1, now), true);
});
