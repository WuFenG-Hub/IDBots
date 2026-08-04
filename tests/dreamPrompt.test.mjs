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
  const { dueDates } = computeDueDreamDates({ now: atThree, metabotId: 1, runStates: new Map() });
  assert.ok(dueDates.includes('2026-08-01'), 'yesterday should be due at 03:00');

  const early = new Date(2026, 7, 2, 0, 5);
  const { dueDates: notYet } = computeDueDreamDates({ now: early, metabotId: 1, runStates: new Map() });
  assert.equal(notYet.includes('2026-08-01'), false, 'yesterday should wait for the staggered minute');
});

test('computeDueDreamDates: yesterday waits outside the window, older dates catch up any time', () => {
  const midday = new Date(2026, 7, 8, 12, 0);
  const { dueDates } = computeDueDreamDates({ now: midday, metabotId: 1, runStates: new Map() });
  assert.equal(dueDates.includes('2026-08-07'), false, 'yesterday must wait for the next nightly window');
  assert.ok(dueDates.includes('2026-08-06'), 'two days ago should catch up immediately');
  assert.ok(dueDates.includes('2026-08-02'), 'six days ago should catch up');
  assert.equal(dueDates.includes('2026-07-31'), false, 'beyond the 7-day lookback');
  // chronological ascending: oldest first
  assert.deepEqual([...dueDates].sort(), dueDates);
});

test('computeDueDreamDates: completed/running/exhausted dates are skipped, failed dates retry', () => {
  const now = new Date(2026, 7, 2, 3, 0);
  const runStates = new Map([
    ['2026-08-01', { status: 'completed', attemptCount: 1, startedAt: new Date(2026, 7, 2, 0, 30).getTime(), dreamVersion: 99 }],
    ['2026-07-31', { status: 'running', attemptCount: 1, startedAt: 0, dreamVersion: 0 }],
    ['2026-07-30', { status: 'failed', attemptCount: DREAM_MAX_ATTEMPTS, startedAt: 0, dreamVersion: 0 }],
    ['2026-07-29', { status: 'failed', attemptCount: 1, startedAt: 0, dreamVersion: 0 }],
  ]);
  const { dueDates, repairDates } = computeDueDreamDates({ now, metabotId: 1, runStates });
  assert.equal(dueDates.includes('2026-08-01'), false);
  assert.equal(dueDates.includes('2026-07-31'), false);
  assert.equal(dueDates.includes('2026-07-30'), false);
  assert.ok(dueDates.includes('2026-07-29'));
  assert.deepEqual(repairDates, [], 'current-version completed runs are fully settled');
});

test('computeDueDreamDates: a completed run that started mid-day is not final and is due again', () => {
  // The 2026-08-03 incident: a manually triggered run at 04:24 covered only
  // the day's first hours, then 'completed' locked the date forever.
  const now = new Date(2026, 7, 4, 1, 0); // inside the nightly window
  const partialDay = new Date(2026, 7, 3, 4, 24).getTime(); // started 08-03 04:24
  const runStates = new Map([
    ['2026-08-03', { status: 'completed', attemptCount: 1, startedAt: partialDay, dreamVersion: 1 }],
  ]);
  const { dueDates, repairDates } = computeDueDreamDates({ now, metabotId: 1, runStates });
  assert.ok(dueDates.includes('2026-08-03'), 'partial-day completed run must be re-dreamed');
  assert.deepEqual(repairDates, [], 're-dream of a partial day is a normal run, not a version repair');

  // Once re-dreamed after the day ended, the date is final.
  const settled = new Map([
    ['2026-08-03', { status: 'completed', attemptCount: 2, startedAt: new Date(2026, 7, 4, 0, 20).getTime(), dreamVersion: 1 }],
  ]);
  const next = computeDueDreamDates({ now: new Date(2026, 7, 5, 1, 0), metabotId: 1, runStates: settled });
  assert.equal(next.dueDates.includes('2026-08-03'), false);
  assert.equal(next.repairDates.includes('2026-08-03'), false);
});

test('computeDueDreamDates: stale-version completed dates become window-gated repairs, newest first', () => {
  const inWindow = new Date(2026, 7, 8, 2, 0);
  const finalStart = (day) => new Date(2026, 7, day + 1, 0, 30).getTime(); // after that day ended
  const runStates = new Map([
    ['2026-08-05', { status: 'completed', attemptCount: 1, startedAt: finalStart(5), dreamVersion: 0 }],
    ['2026-08-03', { status: 'completed', attemptCount: 1, startedAt: finalStart(3), dreamVersion: 0 }],
    ['2026-08-02', { status: 'completed', attemptCount: 1, startedAt: finalStart(2), dreamVersion: 1 }],
  ]);
  const { dueDates, repairDates } = computeDueDreamDates({ now: inWindow, metabotId: 1, runStates, dreamVersion: 1 });
  assert.equal(dueDates.includes('2026-08-05'), false, 'stale completed dates are not normal dues');
  assert.equal(dueDates.includes('2026-08-03'), false);
  assert.deepEqual(repairDates, ['2026-08-05', '2026-08-03'], 'stale dates repair newest-first; current version skipped');

  const midday = new Date(2026, 7, 8, 12, 0);
  const { repairDates: noonRepairs } = computeDueDreamDates({ now: midday, metabotId: 1, runStates, dreamVersion: 1 });
  assert.deepEqual(noonRepairs, [], 'repairs only run inside the nightly window');
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
      { subject: '制作演示视频', counterparty: '用户', evaluation: 'warming', note: '用户从只回表情到主动追问细节' },
      { subject: '整理文档', counterparty: 'PeerBot', evaluation: 'bogus', note: '' },
      { subject: '旧格式评价映射', counterparty: '用户', evaluation: 'praise', note: 'legacy' },
      { subject: '旧格式差评映射', counterparty: '用户', evaluation: 'dissatisfied', note: 'legacy' },
    ],
    important_memories: ['用户偏好周五发布', { text: '对象形态也要支持' }, '', { nope: true }],
    value_lessons: [
      { rule: '在涉及个人痛苦的话题上要更谨慎', source: '用户提到家人住院时我仍在开玩笑' },
      '面对不确定的问题不要不懂装懂',
      { nope: true },
    ],
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
    assert.equal(result.output.workReviews.length, 4);
    assert.equal(result.output.workReviews[0].evaluation, 'warming');
    assert.equal(result.output.workReviews[1].evaluation, 'stable', 'invalid evaluation normalizes to stable');
    assert.equal(result.output.workReviews[2].evaluation, 'warming', 'legacy praise maps to warming');
    assert.equal(result.output.workReviews[3].evaluation, 'cooling', 'legacy dissatisfied maps to cooling');
    assert.deepEqual(result.output.importantMemories, ['用户偏好周五发布', '对象形态也要支持']);
    assert.deepEqual(result.output.valueLessons, [
      { rule: '在涉及个人痛苦的话题上要更谨慎', source: '用户提到家人住院时我仍在开玩笑' },
      { rule: '面对不确定的问题不要不懂装懂', source: '' },
    ]);
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
    value_lessons: Array.from({ length: 6 }, (_, i) => `准则${i}`),
  };
  const result = parseDreamOutput(JSON.stringify(many));
  assert.equal(result.ok, true);
  assert.equal(result.output.workReviews.length, 5);
  assert.equal(result.output.importantMemories.length, 5);
  assert.equal(result.output.valueLessons.length, 3, 'value lessons capped at 3');
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
      orderCount: 2,
    },
  });

  assert.ok(system.includes('小火'));
  assert.ok(system.includes('视频创作者'));
  assert.ok(system.includes('上帝视角'), 'observer framing in the system prompt');
  assert.ok(user.includes('2026-08-01'));
  assert.ok(user.includes('当天共有 2 段会话'), 'session inventory line');
  assert.ok(user.includes('「和用户聊发布」'), 'inventory lists session titles');
  assert.ok(user.includes('服务订单共 2 笔'), 'raw order count in the inventory');
  assert.ok(user.includes('定时任务执行 1 次'), 'task run count in the inventory');
  assert.ok(user.includes('与人类用户的对话'));
  assert.ok(user.includes('和用户聊发布'));
  assert.ok(user.includes('服务订单'));
  assert.ok(user.includes('翻译订单'));
  assert.ok(user.includes('定时任务'));
  assert.ok(user.includes('每日巡检'));
  assert.ok(user.includes('self_identity'));
  assert.ok(user.includes('200'));
  assert.ok(user.includes('value_lessons'));
  assert.ok(user.includes('warming'), 'temperature enum in the contract');
  assert.ok(user.includes('关系温度'), 'temperature judging guidance');
  assert.ok(user.includes('活感'), 'aliveness scaffold in the identity section');
  assert.ok(user.includes('最稳定的面貌'), 'steady-persona scaffold');
  assert.ok(user.includes('600 字以内'), 'identity length guidance matches the raised storage cap');
  assert.ok(user.includes('占位'), 'sections placeholder keys are banned explicitly');
  assert.ok(!user.includes('不要轻易改动'), 'old rigid identity wording removed');
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
      orderCount: 0,
    },
  });
  assert.ok(user.length < 16000, `prompt should be bounded, got ${user.length}`);
  assert.ok(user.includes('……'));
  // Fair-share budgeting: even with 30 oversized sessions, every session keeps
  // its place (header and inventory title) instead of silently dropping out.
  assert.ok(user.includes('会话0'), 'first session present');
  assert.ok(user.includes('会话29'), 'last session present');
  assert.ok(user.includes('当天共有 30 段会话'), 'inventory counts all sessions');
});
