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
  normalizeStaffingPlan,
  isStaffingProposalExpired,
  isLocalOnlySmallSlate,
  GROUP_TASK_LOCAL_AUTO_START_MAX_SEATS,
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

test('bare English instead/drop are not automatic revise', () => {
  assert.equal(classifyOwnerStaffingReply('ok, use B instead of A'), 'unknown');
  assert.equal(classifyOwnerStaffingReply('looks good — use Pixel instead'), 'unknown');
  assert.equal(classifyOwnerStaffingReply('replace the designer'), 'revise');
  assert.equal(classifyOwnerStaffingReply('drop the seat'), 'revise');
});

test('a skip phrase after propose authorizes create without a new propose', () => {
  assert.deepEqual(
    resolveStaffingOwnerGate({
      triggeringWish: '帮我开个群任务做技能介绍',
      repliesAfterPropose: ['不用确认直接开'],
    }),
    { allowed: true, decision: 'skip_authorized' },
  );
  assert.deepEqual(
    resolveStaffingOwnerGate({
      triggeringWish: '帮我开个群任务做技能介绍',
      repliesAfterPropose: ['换人', '不用确认直接开'],
    }),
    { allowed: true, decision: 'skip_authorized' },
  );
});

test('last decisive owner reply wins: skip then 换人 is revise', () => {
  assert.deepEqual(
    resolveStaffingOwnerGate({
      triggeringWish: '帮我开个群任务做技能介绍',
      repliesAfterPropose: ['不用确认直接开', '换人'],
    }),
    { allowed: false, decision: 'owner_revise' },
  );
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

const localSeat = (role, name) => ({ role, candidateName: name, source: 'local', reason: 'local' });
const remoteSeat = (role, name) => ({
  role,
  candidateName: name,
  candidateGlobalMetaId: 'idq1remote0000000000000000000000000000000',
  source: 'remote',
  reason: 'online',
});

test('isLocalOnlySmallSlate: all-local at or under the cap, empty/remote/big slates excluded', () => {
  assert.equal(GROUP_TASK_LOCAL_AUTO_START_MAX_SEATS, 4);
  const fourLocal = {
    stages: [],
    seats: [
      localSeat('content', 'A'),
      localSeat('design', 'B'),
      localSeat('engineering', 'C'),
      localSeat('promotion', 'D'),
    ],
  };
  assert.equal(isLocalOnlySmallSlate(fourLocal), true);
  const fiveLocal = {
    stages: [],
    seats: [
      ...fourLocal.seats,
      { role: 'domain', domainLabel: 'legal', candidateName: 'E', source: 'local', reason: 'local' },
    ],
  };
  assert.equal(isLocalOnlySmallSlate(fiveLocal), false);
  const withRemote = {
    stages: [],
    seats: [localSeat('content', 'A'), remoteSeat('design', 'B')],
  };
  assert.equal(isLocalOnlySmallSlate(withRemote), false);
  // An empty slate must not vacuous-truth into a chair-only auto-start.
  assert.equal(isLocalOnlySmallSlate({ stages: [], seats: [] }), false);
});

test('normalizeStaffingPlan: a missing source label falls back to the global meta id', () => {
  const remote = normalizeStaffingPlan({ stages: [], seats: [
    {
      role: 'design',
      candidateName: 'Remote Artist',
      candidateGlobalMetaId: 'idq1remotea00000000000000000000000000000',
    },
  ]});
  assert.equal(remote.seats[0].source, 'remote');
  assert.equal(isLocalOnlySmallSlate(remote), false);
  // A local seat (no global meta id) with a missing source stays local.
  const local = normalizeStaffingPlan({ stages: [], seats: [
    { role: 'content', candidateName: 'Coder Bot' },
  ]});
  assert.equal(local.seats[0].source, 'local');
  assert.equal(isLocalOnlySmallSlate(local), true);
});

test('a local-only small slate auto-starts instead of awaiting the owner', () => {
  assert.deepEqual(
    resolveStaffingOwnerGate({
      triggeringWish: '帮我开个群任务做技能介绍',
      repliesAfterPropose: [],
      localSmallSlate: true,
    }),
    { allowed: true, decision: 'local_auto_start' },
  );
});

test('an owner revise beats the local-only auto-start', () => {
  assert.deepEqual(
    resolveStaffingOwnerGate({
      triggeringWish: '帮我开个群任务做技能介绍',
      repliesAfterPropose: ['换人，用设计师'],
      localSmallSlate: true,
    }),
    { allowed: false, decision: 'owner_revise' },
  );
});

test('an owner cancel is classified and blocks create even under a waiver', () => {
  for (const cancelReply of ['算了', '别开了', '不开了', '取消吧', '算了，不开了', 'never mind', 'cancel it']) {
    assert.equal(classifyOwnerStaffingReply(cancelReply), 'cancel', cancelReply);
  }
  // "算了，就这些人吧" is a confirm; "取消确认" is not a whole-decision cancel.
  assert.equal(classifyOwnerStaffingReply('算了，就这些人吧'), 'confirm');
  assert.equal(classifyOwnerStaffingReply('取消确认'), 'unknown');

  assert.deepEqual(
    resolveStaffingOwnerGate({
      triggeringWish: '帮我开个群任务做技能介绍',
      repliesAfterPropose: ['算了，不开了'],
      localSmallSlate: true,
    }),
    { allowed: false, decision: 'owner_cancel' },
  );
  assert.deepEqual(
    resolveStaffingOwnerGate({
      triggeringWish: '开个群任务做技能介绍，不用确认直接开',
      repliesAfterPropose: ['cancel this'],
    }),
    { allowed: false, decision: 'owner_cancel' },
  );
  // Last decisive reply wins: a confirm after a cancel re-authorizes.
  assert.deepEqual(
    resolveStaffingOwnerGate({
      triggeringWish: '帮我开个群任务做技能介绍',
      repliesAfterPropose: ['算了', '确认人选'],
    }),
    { allowed: true, decision: 'owner_confirmed' },
  );
});

test('an explicit skip wish still records skip_authorized, not the auto-start', () => {
  assert.deepEqual(
    resolveStaffingOwnerGate({
      triggeringWish: '开个群任务做技能介绍，不用确认直接开',
      repliesAfterPropose: [],
      localSmallSlate: true,
    }),
    { allowed: true, decision: 'skip_authorized' },
  );
});

test('slate tail-line explains the all-local small-team auto-start', () => {
  const zh = buildStaffingSlateText({
    title: '技能介绍',
    goal: '写出介绍',
    plan,
    ownerConfirmRequired: false,
    skipReason: 'local_small',
  });
  assert.match(zh, /无需确认/);
  assert.match(zh, /本机/);
  assert.doesNotMatch(zh, /你已经说了不用确认人选/);
  assert.doesNotMatch(zh, /现在说/);
  const en = buildStaffingSlateText({
    title: 'Skill intro',
    goal: 'Write it',
    plan,
    ownerConfirmRequired: false,
    skipReason: 'local_small',
    language: 'en',
  });
  assert.match(en, /all local and small/i);
  assert.doesNotMatch(en, /You asked to skip roster confirmation/);
  assert.doesNotMatch(en, /Speak up now/i);
});
