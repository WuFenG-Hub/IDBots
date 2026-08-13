import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  buildAcceptanceSummary,
  buildAcceptanceSummaryMessageText,
  buildAcceptanceGuidance,
  deliverableVerificationLabel,
} = require('../dist-electron/main/services/groupTaskAcceptanceSummary.js');

const baseTask = { title: '西游记第一回', goal: 'Three.js 三维动画', acceptanceCriteria: '可播放' };

const mkDeliverable = (overrides = {}) => ({
  id: 1,
  taskId: 1,
  msgPinId: 'pin-1',
  authorGlobalmetaid: 'gmid-lucy',
  kind: 'metaapp',
  uri: 'metaapp://abc',
  status: 'accepted',
  createdAt: null,
  verification: null,
  confirmation: 'unconfirmed',
  sourceContent: null,
  sourceSenderName: 'Lucy',
  ...overrides,
});

const mkMember = (overrides = {}) => ({
  id: 1,
  taskId: 1,
  metabotId: 1,
  globalmetaid: 'gmid-lucy',
  role: 'worker',
  joinedPinId: null,
  createdAt: null,
  displayName: null,
  removedAt: null,
  removePinId: null,
  name: 'Lucy',
  status: 'working',
  statusChangedAt: null,
  ...overrides,
});

test('buildAcceptanceSummary produces deterministic message with deliverable rows', () => {
  const result = buildAcceptanceSummary({
    task: baseTask,
    deliverables: [
      mkDeliverable({ kind: 'metaapp', uri: 'metaapp://abc', confirmation: 'confirmed', sourceSenderName: 'Lucy' }),
      mkDeliverable({ kind: 'metafile', uri: null, confirmation: 'unconfirmed', verification: null, sourceSenderName: 'Builder阿码' }),
    ],
    members: [mkMember({ name: 'Lucy' }), mkMember({ name: 'Builder阿码' })],
  });

  assert.equal(result.goal, 'Three.js 三维动画');
  assert.equal(result.acceptanceCriteria, '可播放');
  assert.equal(result.deliverables.length, 2);
  assert.equal(result.deliverables[0].authorName, 'Lucy');
  assert.equal(result.deliverables[1].uri, null);
  assert.equal(result.members.length, 2);
  assert.equal(result.members[0].workStatus, 'working');

  assert.ok(result.messageText.includes('任务「西游记第一回」已进入验收阶段'));
  assert.ok(result.messageText.includes('目标：Three.js 三维动画'));
  assert.ok(result.messageText.includes('验收标准：可播放'));
  assert.ok(result.messageText.includes('[metaapp] metaapp://abc'));
  assert.ok(result.messageText.includes('Lucy'));
  assert.ok(result.messageText.includes('Builder阿码'));
  // Guidance three actions present.
  assert.ok(result.messageText.includes('①'));
  assert.ok(result.messageText.includes('②'));
  assert.ok(result.messageText.includes('③'));
});

test('buildAcceptanceSummary shows 无已核验交付物 (not 已完成) when no deliverables', () => {
  const result = buildAcceptanceSummary({ task: baseTask, deliverables: [], members: [] });
  assert.ok(result.messageText.includes('无已核验交付物'));
  assert.ok(!result.messageText.includes('已完成'));
});

test('buildAcceptanceSummary falls back to （未填写） when acceptance criteria empty', () => {
  const result = buildAcceptanceSummary({
    task: { title: 'T', goal: 'G', acceptanceCriteria: null },
    deliverables: [],
    members: [],
  });
  assert.ok(result.messageText.includes('验收标准：（未填写）'));
});

test('buildAcceptanceSummary excludes removed members from the snapshot', () => {
  const result = buildAcceptanceSummary({
    task: baseTask,
    deliverables: [],
    members: [
      mkMember({ name: 'Active', removedAt: null }),
      mkMember({ name: 'Kicked', removedAt: '2026-01-01 00:00:00' }),
    ],
  });
  assert.equal(result.members.length, 1);
  assert.equal(result.members[0].name, 'Active');
});

test('deliverableVerificationLabel: confirmed => on-chain ✓, else unverified/pending', () => {
  assert.equal(deliverableVerificationLabel(mkDeliverable({ confirmation: 'confirmed' })), 'on-chain ✓');
  assert.equal(deliverableVerificationLabel(mkDeliverable({ confirmation: 'unconfirmed', verification: null })), 'unverified');
  assert.equal(
    deliverableVerificationLabel(
      mkDeliverable({ confirmation: 'unconfirmed', verification: JSON.stringify({ verified: true }) }),
    ),
    'on-chain ✓',
  );
  assert.equal(
    deliverableVerificationLabel(
      mkDeliverable({
        confirmation: 'unconfirmed',
        verification: JSON.stringify({ sources: [{ outcome: 'not_found' }, { outcome: 'found' }] }),
      }),
    ),
    'pending sync',
  );
});

test('buildAcceptanceSummaryMessageText is deterministic (same input → same output)', () => {
  const summary = {
    goal: 'G',
    acceptanceCriteria: 'C',
    deliverables: [{ kind: 'url', uri: 'https://x', status: 'accepted', confirmation: 'confirmed', authorName: 'A' }],
    members: [{ name: 'A', role: 'worker', workStatus: 'done' }],
    guidance: buildAcceptanceGuidance({ title: 'T' }),
  };
  const a = buildAcceptanceSummaryMessageText(summary, 'T');
  const b = buildAcceptanceSummaryMessageText(summary, 'T');
  assert.equal(a, b);
});

test('buildAcceptanceGuidance always ends with an action, never an open question', () => {
  const guidance = buildAcceptanceGuidance({ title: 'T' });
  assert.ok(guidance.includes('Accept & Close'));
  // No open-ended "what would you like" phrasing.
  assert.ok(!/what would you like|接下来想做/i.test(guidance));
});
