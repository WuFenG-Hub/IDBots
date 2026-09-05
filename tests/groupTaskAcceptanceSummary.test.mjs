import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  buildAcceptanceSummary,
  buildAcceptanceSummaryMessageText,
  buildAcceptanceGuidance,
  buildGroupTaskTimeBreakdown,
  deliverableVerificationLabel,
  extractChairConclusion,
  extractCriteriaVerdicts,
  isHeartbeatNoiseLine,
  selectAcceptanceChecklist,
  textDeliverablePreview,
  CHAIR_CONCLUSION_MAX_CHARS,
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
    members: [mkMember({ name: 'Lucy' }), mkMember({ name: 'Builder阿码', globalmetaid: 'gmid-builder' })],
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

test('P13: the member roster wins over a wrong chain nickname (claude bot case)', () => {
  // Task #22: Builder阿码's delivery was posted under a runtime identity
  // nickname "claude bot" while the deliverable row's authorGlobalmetaid was
  // correct. The roster lookup must override the chain sender name.
  const result = buildAcceptanceSummary({
    task: baseTask,
    deliverables: [
      mkDeliverable({
        authorGlobalmetaid: 'gmid-builder',
        sourceSenderName: 'claude bot',
      }),
      // Author not on the roster: keep the chain nickname as the fallback.
      mkDeliverable({
        id: 2,
        authorGlobalmetaid: 'gmid-outsider',
        sourceSenderName: 'Chain Nickname',
      }),
    ],
    members: [mkMember({ name: 'Builder阿码', globalmetaid: 'gmid-builder' })],
  });
  assert.equal(result.deliverables[0].authorName, 'Builder阿码');
  assert.equal(result.deliverables[1].authorName, 'Chain Nickname');
});

test('P3: non-pending deliverable status is surfaced in the summary message line', () => {
  const result = buildAcceptanceSummary({
    task: baseTask,
    deliverables: [
      mkDeliverable({ status: 'delivered', uri: 'metaapp://abc', confirmation: 'confirmed' }),
      mkDeliverable({ status: 'pending', uri: 'metafile://xyz', confirmation: 'unconfirmed' }),
    ],
    members: [],
  });
  assert.ok(result.messageText.includes('· delivered'));
  assert.ok(!result.messageText.includes('· pending'));
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

// ---------------------------------------------------------------------------
// Improvement #1 (single-card acceptance): the chair's 【结论】 verdict
// ---------------------------------------------------------------------------

test('extractChairConclusion: 【结论】 first line is captured, cleaned, capped', () => {
  assert.equal(
    extractChairConclusion('【结论】验收通过并结项\n\n正文……'),
    '验收通过并结项',
  );
  // Markdown bold and trailing punctuation are stripped.
  assert.equal(
    extractChairConclusion('【结论】 **建议返工：配图未交付**。',
    ),
    '建议返工：配图未交付');
  // Legacy narrative forms (task #24 style) still parse.
  assert.equal(
    extractChairConclusion('**结论**：验收通过，理由见验收卡'),
    '验收通过，理由见验收卡',
  );
  assert.equal(
    extractChairConclusion('Conclusion: accept and close\n\nBody…'),
    'accept and close',
  );
  assert.equal(
    extractChairConclusion('**Conclusion**: rework the images'),
    'rework the images',
  );
  assert.equal(
    extractChairConclusion('目标回顾：……\n结论：建议验收通过'),
    '建议验收通过',
  );
  // Over-long verdicts are capped.
  const long = 'x'.repeat(200);
  const capped = extractChairConclusion(`【结论】${long}`);
  assert.equal(capped.length, CHAIR_CONCLUSION_MAX_CHARS + 1);
  assert.ok(capped.endsWith('…'));
});

test('extractChairConclusion: mentions deep in the narration or absent tags yield null', () => {
  // A 结论 mentioned beyond the opening lines is prose, not the verdict.
  const deep = ['开场白', '一', '二', '三', '四', '五', '六', '七', '结论：太深了'].join('\n');
  assert.equal(extractChairConclusion(deep), null);
  assert.equal(extractChairConclusion(''), null);
  assert.equal(extractChairConclusion(null), null);
  assert.equal(extractChairConclusion('没有任何标签的报告正文'), null);
});

test('Improvement #1: the group message leads with the stored conclusion when present', () => {
  const base = {
    goal: 'G',
    acceptanceCriteria: 'C',
    deliverables: [],
    members: [],
    guidance: buildAcceptanceGuidance({ title: 'T' }),
  };
  const withConclusion = buildAcceptanceSummaryMessageText(
    { ...base, conclusion: '验收通过并结项' },
    'T',
  );
  const lines = withConclusion.split('\n');
  assert.equal(lines[0], '[GROUP_TASK_NOTICE:review_summary]');
  assert.match(lines[1], /已进入验收阶段/);
  assert.equal(lines[2], '结论：验收通过并结项', 'conclusion is the first content line after the header');
  const withoutConclusion = buildAcceptanceSummaryMessageText({ ...base }, 'T');
  assert.ok(!withoutConclusion.includes('结论：'), 'no fabricated conclusion line');
});

test('acceptance checklist omits process-text placeholders when digital outcomes exist', () => {
  const result = buildAcceptanceSummary({
    task: baseTask,
    deliverables: [
      mkDeliverable({
        kind: 'metaapp',
        uri: 'metaapp://ad3ba22f',
        confirmation: 'confirmed',
        status: 'delivered',
        sourceSenderName: 'eleven',
      }),
      mkDeliverable({
        id: 2,
        kind: 'text',
        uri: null,
        confirmation: 'unconfirmed',
        sourceContent: '[DELIVERABLE] 核验报告全文',
        sourceSenderName: 'Builder阿码',
      }),
      mkDeliverable({
        id: 3,
        kind: 'text',
        uri: null,
        confirmation: 'unconfirmed',
        sourceContent: '[DELIVERABLE]',
        sourceSenderName: 'loop',
      }),
      mkDeliverable({
        id: 4,
        kind: 'url',
        uri: 'https://openagentinternet.org/browser/x',
        confirmation: 'confirmed',
        status: 'delivered',
        sourceSenderName: 'eleven',
      }),
    ],
    members: [mkMember({ name: 'eleven' })],
  });
  // Snapshot still keeps every row for audit.
  assert.equal(result.deliverables.length, 4);
  const checklist = selectAcceptanceChecklist(result.deliverables);
  assert.deepEqual(checklist.items.map((item) => item.kind), ['metaapp', 'url']);
  assert.equal(checklist.omittedProcessCount, 2);
  assert.ok(result.messageText.includes('[metaapp] metaapp://ad3ba22f'));
  assert.ok(result.messageText.includes('on-chain ✓'));
  assert.ok(!result.messageText.includes('（见消息原文）'));
  assert.ok(!result.messageText.includes('(unverified)'));
  assert.ok(result.messageText.includes('另有 2 项过程记录，见群内报告'));
});

test('text-only task prints the report body, never 见消息原文/unverified', () => {
  const result = buildAcceptanceSummary({
    task: baseTask,
    deliverables: [
      mkDeliverable({
        kind: 'text',
        uri: null,
        confirmation: 'unconfirmed',
        sourceContent: '[DELIVERABLE]\n验收观察：动画可播放',
        sourceSenderName: 'chair',
      }),
    ],
    members: [],
  });
  assert.equal(result.deliverables[0].preview, '验收观察：动画可播放');
  assert.equal(textDeliverablePreview('[DELIVERABLE]\n验收观察：动画可播放'), '验收观察：动画可播放');
  assert.ok(result.messageText.includes('[text] 验收观察：动画可播放 — chair'));
  assert.ok(!result.messageText.includes('（见消息原文）'));
  assert.ok(!result.messageText.includes('(unverified)'));
});

// ---------------------------------------------------------------------------
// G-05: create-time-aligned criteria verdicts
// ---------------------------------------------------------------------------

test('G-05: extractCriteriaVerdicts parses protocol lines, ignores prose, keeps order', () => {
  const report = [
    '【结论】两项标准均满足,建议验收通过。',
    'Narration about the run. The criteria were checked one by one.',
    '[CRITERION:PASS] 归档一条（先查重） — 已归档 pin xxx 且查重通过',
    '- [CRITERION:FAIL] 预览可用 — 预览链接 404',
    '* [CRITERION:UNCLEAR] 推广文案已起草 — 无法核实草稿位置',
    '[OBSERVATION] 归档文件未上链（标准未要求,不影响验收）',
    'Some closing prose mentioning [CRITERION:PASS] mid-sentence but not at line start should not double count.',
  ].join('\n');
  const { verdicts, observations } = extractCriteriaVerdicts(report);
  assert.equal(verdicts.length, 3);
  assert.deepEqual(
    verdicts.map((entry) => entry.verdict),
    ['pass', 'fail', 'unclear'],
  );
  assert.match(verdicts[0].text, /^归档一条/);
  assert.match(verdicts[1].text, /^预览可用/);
  assert.equal(observations.length, 1);
  assert.match(observations[0], /归档文件未上链/);
});

test('G-05: the summary message renders the criteria check and marks observations non-blocking', () => {
  const text = buildAcceptanceSummaryMessageText({
    goal: 'archive one item',
    acceptanceCriteria: '归档一条（先查重）',
    deliverables: [],
    members: [],
    guidance: 'You can:',
    conclusion: '两项标准均满足',
    criteriaVerdicts: [
      { verdict: 'pass', text: '归档一条（先查重） — 已归档' },
      { verdict: 'fail', text: '预览可用 — 404' },
    ],
    observations: ['归档文件未上链（标准未要求）'],
  }, '归档任务');
  assert.match(text, /验收标准对照/);
  assert.match(text, /✓ 通过 — 归档一条（先查重） — 已归档/);
  assert.match(text, /✗ 未通过 — 预览可用 — 404/);
  assert.match(text, /观察项（标准之外，不阻断验收）/);
  assert.match(text, /归档文件未上链/);
});

test('G-04: the summary message renders the supervisor intervention trail', () => {
  const text = buildAcceptanceSummaryMessageText({
    goal: 'g',
    acceptanceCriteria: null,
    deliverables: [],
    members: [],
    guidance: 'You can:',
    supervisorSignals: ['[NUDGE → Coder Bot] double-check dedupe', '[PAUSE] owner asked to hold dispatch'],
  }, 'supervised task');
  assert.match(text, /监督者干预记录/);
  assert.match(text, /\[NUDGE → Coder Bot\] double-check dedupe/);
  assert.match(text, /\[PAUSE\] owner asked to hold dispatch/);
});

// ---------------------------------------------------------------------------
// Speedup R-06: deterministic per-phase time breakdown
// ---------------------------------------------------------------------------

test('speedup R-06: isHeartbeatNoiseLine matches the host liveness lines only', () => {
  assert.ok(isHeartbeatNoiseLine('[WORKING] 仍在执行中——本步骤耗时较长，进展正常，完成后会立即汇报。'));
  assert.ok(isHeartbeatNoiseLine('[WORKING] 长步骤仍在后台执行，一切正常，完成后第一时间汇报进展。'));
  assert.ok(isHeartbeatNoiseLine('[WORKING] Still on it — this step is taking a while; progress is normal and I will report as soon as it lands.'));
  assert.ok(isHeartbeatNoiseLine('[WORKING] Long step still running in the background; everything is fine — will report the moment it completes.'));
  // Worker engagement lines are NOT heartbeat noise.
  assert.ok(!isHeartbeatNoiseLine('[WORKING] 已接单，正在收尾'));
  assert.ok(!isHeartbeatNoiseLine('[WORKING] 步骤完成，交付如下'));
  assert.ok(!isHeartbeatNoiseLine(''));
  assert.ok(!isHeartbeatNoiseLine(null));
});

test('speedup R-06: buildGroupTaskTimeBreakdown derives phases, steps, and heartbeat share from host records', () => {
  const ms = (text) => Date.parse(`${text.replace(' ', 'T')}Z`);
  const secs = (text) => ms(text) / 1000;
  const breakdown = buildGroupTaskTimeBreakdown({
    task: { createdAt: '2026-09-05 02:00:00', closedAt: null },
    statusEvents: [
      { id: 1, taskId: 1, fromStatus: 'planning', toStatus: 'executing', createdAt: '2026-09-05 02:10:00' },
      { id: 2, taskId: 1, fromStatus: 'executing', toStatus: 'review', createdAt: '2026-09-05 03:00:00' },
    ],
    deliverables: [
      mkDeliverable({
        createdAt: '2026-09-05 02:40:00',
        sourceContent: '[DELIVERABLE] S1 metafile://abc',
        authorGlobalmetaid: 'gmid-lucy',
      }),
    ],
    messages: [
      { id: 1, content: '分工如下\n[STATUS:EXECUTING]', senderGlobalMetaId: 'gmid-twin', chainTimestamp: secs('2026-09-05 02:10:00') },
      { id: 2, content: '[WORKING] 仍在执行中——本步骤耗时较长，进展正常，完成后会立即汇报。', senderGlobalMetaId: 'gmid-lucy', chainTimestamp: secs('2026-09-05 02:20:00') },
      { id: 3, content: '[WORKING] Long step still running in the background; everything is fine.', senderGlobalMetaId: 'gmid-lucy', chainTimestamp: secs('2026-09-05 02:30:00') },
      { id: 4, content: '[DELIVERABLE] S1 metafile://abc', senderGlobalMetaId: 'gmid-lucy', chainTimestamp: secs('2026-09-05 02:40:00') },
      { id: 5, content: 'goal met\n[STATUS:REVIEW]', senderGlobalMetaId: 'gmid-twin', chainTimestamp: secs('2026-09-05 03:00:00') },
    ],
    members: [
      mkMember({ globalmetaid: 'gmid-twin', role: 'chair', name: 'Twin Bot' }),
      mkMember({ globalmetaid: 'gmid-lucy', role: 'worker', name: 'Lucy' }),
    ],
    messageTotal: 100,
    nowMs: ms('2026-09-05 03:30:00'),
  });

  assert.equal(breakdown.messageTotal, 100, 'the authoritative total wins over the page size');
  assert.equal(breakdown.heartbeatMessages, 2);
  assert.equal(breakdown.heartbeatSharePct, 2);
  assert.equal(breakdown.chairMessages, 2);
  assert.equal(breakdown.workerMessages, 3);
  // Only the 02:10→02:40 gap carried heartbeat lines: 30 padded minutes.
  assert.equal(breakdown.heartbeatPaddedGapMinutes, 30);

  const minutesByKey = Object.fromEntries(breakdown.phases.map((phase) => [phase.key, phase.minutes]));
  assert.equal(minutesByKey.planning, 10);
  assert.equal(minutesByKey.executing, 50);
  assert.equal(minutesByKey.review, 30, 'the open review window is closed by nowMs');

  assert.equal(breakdown.steps.length, 1);
  assert.equal(breakdown.steps[0].label, 'S1', 'step label lifted from the source line');
  assert.equal(breakdown.steps[0].authorName, 'Lucy');
  assert.equal(breakdown.steps[0].minutesSincePrev, 30, 'executing start (02:10) → S1 record (02:40)');
});

test('speedup R-06: the summary message renders the time breakdown block (zh + en)', () => {
  const timeBreakdown = {
    generatedAt: '2026-09-05T03:30:00.000Z',
    messageTotal: 96,
    heartbeatMessages: 46,
    heartbeatSharePct: 48,
    heartbeatPaddedGapMinutes: 80,
    chairMessages: 20,
    workerMessages: 76,
    noticeMessages: 30,
    phases: [
      { key: 'planning', startedAt: '2026-09-05T02:00:00.000Z', endedAt: '2026-09-05T02:12:00.000Z', minutes: 12 },
      { key: 'executing', startedAt: '2026-09-05T02:12:00.000Z', endedAt: '2026-09-05T03:57:30.000Z', minutes: 105.5 },
      { key: 'review', startedAt: '2026-09-05T03:57:30.000Z', endedAt: null, minutes: 0 },
    ],
    steps: [{ label: 'S1', authorName: 'Lucy', at: '2026-09-05T02:40:00.000Z', minutesSincePrev: 40 }],
  };
  const shape = {
    goal: 'g',
    acceptanceCriteria: null,
    deliverables: [],
    members: [],
    guidance: 'You can:',
    timeBreakdown,
  };
  const zh = buildAcceptanceSummaryMessageText(shape, '耗时任务');
  assert.match(zh, /耗时分解：/);
  assert.match(zh, /群消息共 96 条，其中宿主心跳占 48%。/);
  assert.match(zh, /- 筹备派单：12 分钟/);
  assert.match(zh, /- 执行：105\.5 分钟/);
  assert.match(zh, /- S1：\+40 分钟/);
  assert.ok(!zh.includes('验收评审：0 分钟'), 'the zero-length just-started review window is not rendered');

  const en = buildAcceptanceSummaryMessageText(shape, 'timed task', 'en');
  assert.match(en, /Time breakdown:/);
  assert.match(en, /Group messages: 96 total; host heartbeat lines: 48%\./);
  assert.match(en, /- executing: 105\.5 min/);
  assert.match(en, /- S1: \+40 min/);
});
