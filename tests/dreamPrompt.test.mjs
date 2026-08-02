import test from 'node:test';
import assert from 'node:assert/strict';

let computeDreamStaggerMinute;
let computeDueDreamDates;
let countNonWhitespaceChars;
let validateSelfIdentity;
let parseDreamOutput;
let buildDreamPrompt;
let getDayBoundsMs;
let DREAM_MAX_ATTEMPTS;
try {
  ({
    computeDreamStaggerMinute,
    computeDueDreamDates,
    countNonWhitespaceChars,
    validateSelfIdentity,
    parseDreamOutput,
    buildDreamPrompt,
    getDayBoundsMs,
    DREAM_MAX_ATTEMPTS,
  } = await import('../dist-electron/main/libs/dreamPrompt.js'));
} catch {
  ({
    computeDreamStaggerMinute,
    computeDueDreamDates,
    countNonWhitespaceChars,
    validateSelfIdentity,
    parseDreamOutput,
    buildDreamPrompt,
    getDayBoundsMs,
    DREAM_MAX_ATTEMPTS,
  } = await import('../dist-electron/libs/dreamPrompt.js'));
}

const dateStr = (d) => {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
};

test('computeDueDreamDates: yesterday is due inside the window after the staggered minute', () => {
  // metabotId 1 staggers at minute 13 → due at 03:00, not due at 00:05.
  const atThree = new Date(2026, 7, 2, 3, 0);
  const due = computeDueDreamDates({ now: atThree, metabotId: 1, runStates: new Map() });
  assert.ok(due.includes('2026-08-01'), 'yesterday should be due at 03:00');

  const early = new Date(2026, 7, 2, 0, 5);
  const notYet = computeDueDreamDates({ now: early, metabotId: 1, runStates: new Map() });
  assert.equal(notYet.includes('2026-08-01'), false, 'yesterday should wait for the staggered minute');
});

test('computeDueDreamDates: yesterday waits outside the window, older dates catch up any time', () => {
  const midday = new Date(2026, 7, 8, 12, 0);
  const due = computeDueDreamDates({ now: midday, metabotId: 1, runStates: new Map() });
  assert.equal(due.includes('2026-08-07'), false, 'yesterday must wait for the next nightly window');
  assert.ok(due.includes('2026-08-06'), 'two days ago should catch up immediately');
  assert.ok(due.includes('2026-08-02'), 'six days ago should catch up');
  assert.equal(due.includes('2026-07-31'), false, 'beyond the 7-day lookback');
  // chronological ascending: oldest first
  assert.deepEqual([...due].sort(), due);
});

test('computeDueDreamDates: completed/running/exhausted dates are skipped, failed dates retry', () => {
  const now = new Date(2026, 7, 2, 3, 0);
  const runStates = new Map([
    ['2026-08-01', { status: 'completed', attemptCount: 1 }],
    ['2026-07-31', { status: 'running', attemptCount: 1 }],
    ['2026-07-30', { status: 'failed', attemptCount: DREAM_MAX_ATTEMPTS }],
    ['2026-07-29', { status: 'failed', attemptCount: 1 }],
  ]);
  const due = computeDueDreamDates({ now, metabotId: 1, runStates });
  assert.equal(due.includes('2026-08-01'), false);
  assert.equal(due.includes('2026-07-31'), false);
  assert.equal(due.includes('2026-07-30'), false);
  assert.ok(due.includes('2026-07-29'));
});

test('computeDreamStaggerMinute stays inside [0, 240)', () => {
  for (const id of [1, 2, 7, 18, 99, 1000]) {
    const minute = computeDreamStaggerMinute(id);
    assert.ok(minute >= 0 && minute < 240, `metabot ${id} stagger ${minute}`);
  }
  assert.equal(computeDreamStaggerMinute(1), 13);
});

test('validateSelfIdentity enforces the 200 non-whitespace char minimum', () => {
  assert.equal(countNonWhitespaceChars('a b\nc　d'), 4);
  assert.equal(validateSelfIdentity('短').valid, false);
  assert.equal(validateSelfIdentity('一'.repeat(199)).valid, false);
  assert.equal(validateSelfIdentity('一'.repeat(200)).valid, true);
  assert.equal(validateSelfIdentity(`${'一'.repeat(100)} \n ${'二'.repeat(100)}`).valid, true);
  assert.equal(validateSelfIdentity(null).valid, false);
});

test('parseDreamOutput parses clean, fenced and prose-wrapped JSON', () => {
  const payload = {
    daily_summary: '今天和用户敲定了发布计划。',
    sections: { human: '和用户聊发布', unknown_key: '应被忽略' },
    work_reviews: [
      { subject: '制作演示视频', counterparty: '用户', evaluation: 'praise', note: '用户连说三个好' },
      { subject: '整理文档', counterparty: 'PeerBot', evaluation: 'bogus', note: '' },
    ],
    important_memories: ['用户偏好周五发布', { text: '对象形态也要支持' }, '', { nope: true }],
    self_identity: '我是一个专注交付的 MetaBot……',
  };

  for (const raw of [
    JSON.stringify(payload),
    `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
    `好的,以下是 JSON:\n${JSON.stringify(payload)}\n希望对你有帮助`,
  ]) {
    const result = parseDreamOutput(raw);
    assert.equal(result.ok, true, raw.slice(0, 30));
    assert.equal(result.output.dailySummary, '今天和用户敲定了发布计划。');
    assert.deepEqual(result.output.sections, { human: '和用户聊发布' });
    assert.equal(result.output.workReviews.length, 2);
    assert.equal(result.output.workReviews[0].evaluation, 'praise');
    assert.equal(result.output.workReviews[1].evaluation, 'none', 'invalid evaluation normalizes to none');
    assert.deepEqual(result.output.importantMemories, ['用户偏好周五发布', '对象形态也要支持']);
    assert.ok(result.output.selfIdentity?.startsWith('我是一个'));
  }
});

test('parseDreamOutput rejects unusable output and caps list sizes', () => {
  assert.equal(parseDreamOutput('').ok, false);
  assert.equal(parseDreamOutput('没有任何 JSON').ok, false);
  assert.equal(parseDreamOutput('{broken').ok, false);
  assert.equal(parseDreamOutput(JSON.stringify({ sections: {} })).ok, false, 'missing daily_summary');

  const many = {
    daily_summary: '概要',
    work_reviews: Array.from({ length: 8 }, (_, i) => ({ subject: `工作${i}`, evaluation: 'none' })),
    important_memories: Array.from({ length: 9 }, (_, i) => `记忆${i}`),
  };
  const result = parseDreamOutput(JSON.stringify(many));
  assert.equal(result.ok, true);
  assert.equal(result.output.workReviews.length, 5);
  assert.equal(result.output.importantMemories.length, 5);
  assert.equal(result.output.selfIdentity, null);
});

test('getDayBoundsMs returns local midnight bounds', () => {
  const { startMs, endMs } = getDayBoundsMs('2026-08-01');
  assert.equal(dateStr(new Date(startMs)), '2026-08-01');
  assert.equal(dateStr(new Date(endMs - 1)), '2026-08-01');
  assert.equal(dateStr(new Date(endMs)), '2026-08-02');
  assert.equal(endMs - startMs, 24 * 60 * 60 * 1000);
});

test('buildDreamPrompt embeds persona, activity sections and the output contract', () => {
  const { system, user } = buildDreamPrompt({
    botName: '小火',
    role: '视频创作者',
    soul: '认真严谨',
    date: '2026-08-01',
    activity: {
      sessions: [
        {
          sessionId: 's1',
          title: '和用户聊发布',
          sessionType: 'standard',
          peerName: null,
          isOrder: false,
          messages: [
            { type: 'user', content: '今天发布吗', createdAt: 1 },
            { type: 'assistant', content: '先跑测试', createdAt: 2 },
          ],
        },
        {
          sessionId: 's2',
          title: '翻译订单',
          sessionType: 'a2a',
          peerName: 'BuyerBot',
          isOrder: true,
          messages: [{ type: 'user', content: '请翻译这段', createdAt: 3 }],
        },
      ],
      taskRuns: [{ taskName: '每日巡检', status: 'success', startedAt: 4, sessionId: 's1' }],
    },
  });

  assert.ok(system.includes('小火'));
  assert.ok(system.includes('视频创作者'));
  assert.ok(user.includes('2026-08-01'));
  assert.ok(user.includes('与人类用户的对话'));
  assert.ok(user.includes('和用户聊发布'));
  assert.ok(user.includes('服务订单'));
  assert.ok(user.includes('翻译订单'));
  assert.ok(user.includes('定时任务'));
  assert.ok(user.includes('每日巡检'));
  assert.ok(user.includes('self_identity'));
  assert.ok(user.includes('200'));
});

test('buildDreamPrompt truncates oversized activity within budget', () => {
  const hugeMessage = '很长的消息'.repeat(5000);
  const { user } = buildDreamPrompt({
    botName: '小火',
    date: '2026-08-01',
    activity: {
      sessions: Array.from({ length: 30 }, (_, i) => ({
        sessionId: `s${i}`,
        title: `会话${i}`,
        sessionType: 'standard',
        peerName: null,
        isOrder: false,
        messages: Array.from({ length: 20 }, (_, j) => ({
          type: j % 2 === 0 ? 'user' : 'assistant',
          content: hugeMessage,
          createdAt: j,
        })),
      })),
      taskRuns: [],
    },
  });
  assert.ok(user.length < 16000, `prompt should be bounded, got ${user.length}`);
  assert.ok(user.includes('……'));
});
