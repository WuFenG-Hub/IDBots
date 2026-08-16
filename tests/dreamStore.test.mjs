import test from 'node:test';
import assert from 'node:assert/strict';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

let DreamStore;
try {
  ({ DreamStore } = await import('../dist-electron/main/dreamStore.js'));
} catch {
  ({ DreamStore } = await import('../dist-electron/dreamStore.js'));
}

const DAY_START = new Date(2026, 6, 30).getTime();
const DAY_END = new Date(2026, 6, 31).getTime();
const PREV_DAY = new Date(2026, 6, 29, 12, 0, 0).getTime();

const insertMessage = (db, sessionId, type, content, createdAt, sequence) => {
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [`msg-${sessionId}-${sequence}`, sessionId, type, content, '{}', createdAt, sequence]
  );
};

test('dream run lifecycle is idempotent per bot and date', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = new DreamStore(db, () => {});
    new DreamStore(db, () => {}); // schema creation is idempotent

    const first = store.beginRun(5, '2026-07-30', 'deepseek-v4-flash', 1);
    assert.equal(first.status, 'running');
    assert.equal(first.attemptCount, 1);
    assert.equal(first.llmId, 'deepseek-v4-flash');
    assert.equal(first.dreamVersion, 1);

    const restarted = store.beginRun(5, '2026-07-30', null, 2);
    assert.equal(restarted.status, 'running');
    assert.equal(restarted.attemptCount, 2);
    assert.equal(restarted.dreamVersion, 2, 'restart records the newer algorithm version');

    store.finishRun(5, '2026-07-30', 'failed', 'llm timeout');
    const failed = store.getRun(5, '2026-07-30');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'llm timeout');
    assert.ok(failed.completedAt != null);

    store.finishRun(5, '2026-07-30', 'completed');
    const states = store.getRunStates(5, ['2026-07-30', '2026-07-29']);
    const state = states.get('2026-07-30');
    assert.equal(state.status, 'completed');
    assert.equal(state.attemptCount, 2);
    assert.equal(state.dreamVersion, 2);
    assert.ok(state.startedAt > 0);
    assert.equal(states.has('2026-07-29'), false);
  } finally {
    cleanup();
  }
});

test('resetStaleRunningRuns marks interrupted runs as failed', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = new DreamStore(db, () => {});
    store.beginRun(5, '2026-07-30', null, 1);
    store.beginRun(6, '2026-07-30', null, 1);
    store.beginDreamFragment({
      metabotId: 5,
      dreamDate: '2026-07-30',
      fragmentKey: 'session:s1:0',
      sessionId: 's1',
      chunkIndex: 0,
      contentHash: 'hash',
      sourceMessageCount: 1,
      sourceCharCount: 1,
      estimatedInputTokens: 1,
      llmId: null,
      dreamVersion: 3,
    });
    store.finishRun(6, '2026-07-30', 'completed');

    assert.equal(store.resetStaleRunningRuns(), 2, 'interrupted runs and fragments are both recovered');
    assert.equal(store.getRun(5, '2026-07-30').status, 'failed');
    assert.equal(store.getDreamFragment(5, '2026-07-30', 'session:s1:0').status, 'failed');
    assert.equal(store.getRun(6, '2026-07-30').status, 'completed');
  } finally {
    cleanup();
  }
});

test('listRecentRuns returns newest dates first with full run detail', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = new DreamStore(db, () => {});
    store.beginRun(5, '2026-07-28', 'deepseek-v4-flash', 4);
    store.finishRun(5, '2026-07-28', 'completed');
    store.beginRun(5, '2026-07-30', 'deepseek-v4-flash', 4);
    store.finishRun(5, '2026-07-30', 'failed', 'LLM returned no text');
    store.beginRun(5, '2026-07-29', null, 4);
    store.beginRun(6, '2026-07-30', null, 4); // other bot: not listed

    const runs = store.listRecentRuns(5);
    assert.deepEqual(runs.map((run) => run.dreamDate), ['2026-07-30', '2026-07-29', '2026-07-28']);
    assert.equal(runs[0].status, 'failed');
    assert.equal(runs[0].error, 'LLM returned no text');
    assert.equal(runs[0].attemptCount, 1);
    assert.equal(runs[1].status, 'running');
    assert.equal(runs[2].status, 'completed');
    assert.ok(runs.every((run) => run.metabotId === 5));

    const limited = store.listRecentRuns(5, 2);
    assert.deepEqual(limited.map((run) => run.dreamDate), ['2026-07-30', '2026-07-29']);
  } finally {
    cleanup();
  }
});

test('dream fragments are idempotent, resumable, and migrate with the dream schema', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = new DreamStore(db, () => {});
    const started = store.beginDreamFragment({
      metabotId: 5,
      dreamDate: '2026-07-30',
      fragmentKey: 'session:s1:0',
      sessionId: 's1',
      chunkIndex: 0,
      contentHash: 'hash-a',
      sourceMessageCount: 4,
      sourceCharCount: 1200,
      estimatedInputTokens: 500,
      llmId: 'deepseek-v4-flash',
      dreamVersion: 3,
    });
    assert.equal(started.status, 'running');
    assert.equal(started.attemptCount, 1);

    store.finishDreamFragment(5, '2026-07-30', 'session:s1:0', 'completed', '{"daily_summary":"证据"}');
    const completed = store.getDreamFragment(5, '2026-07-30', 'session:s1:0');
    assert.equal(completed.status, 'completed');
    assert.equal(completed.summaryJson, '{"daily_summary":"证据"}');

    const restarted = store.beginDreamFragment({
      metabotId: 5,
      dreamDate: '2026-07-30',
      fragmentKey: 'session:s1:0',
      sessionId: 's1',
      chunkIndex: 0,
      contentHash: 'hash-b',
      sourceMessageCount: 5,
      sourceCharCount: 1500,
      estimatedInputTokens: 600,
      llmId: 'deepseek-v4-flash',
      dreamVersion: 3,
    });
    assert.equal(restarted.status, 'running');
    assert.equal(restarted.attemptCount, 2);
    assert.equal(restarted.contentHash, 'hash-b');
    assert.equal(store.listDreamFragments(5, '2026-07-30').length, 1);
    assert.ok(db.exec('PRAGMA table_info(metabot_dream_fragments)')[0]);
  } finally {
    cleanup();
  }
});

test('daily summary upsert keeps one row per bot and date', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = new DreamStore(db, () => {});

    store.upsertDailySummary({
      metabotId: 5,
      summaryDate: '2026-07-30',
      summaryText: '第一版概要',
      sections: { human: '和用户聊了发布计划' },
      stats: { sessionCount: 1 },
      sessionRefs: [{ sessionId: 'sess-1', title: '和用户聊发布', sessionType: 'standard', isOrder: false }],
      llmId: 'deepseek-v4-flash',
    });
    const withRefs = store.getDailySummary(5, '2026-07-30');
    assert.deepEqual(withRefs.sessionRefs, [
      { sessionId: 'sess-1', title: '和用户聊发布', sessionType: 'standard', isOrder: false },
    ], 'session refs round-trip');

    const updated = store.upsertDailySummary({
      metabotId: 5,
      summaryDate: '2026-07-30',
      summaryText: '修订版概要',
      sections: { human: '和用户聊了发布计划', a2a: '和 PeerBot 对了接口' },
      stats: { sessionCount: 2 },
      llmId: 'deepseek-v4-flash',
    });

    assert.equal(updated.summaryText, '修订版概要');
    assert.deepEqual(updated.sections, { human: '和用户聊了发布计划', a2a: '和 PeerBot 对了接口' });
    assert.deepEqual(updated.sessionRefs, [], 'conflicting upsert without refs resets them');

    store.upsertDailySummary({
      metabotId: 5,
      summaryDate: '2026-07-29',
      summaryText: '前一天概要',
      sections: {},
      stats: {},
      llmId: null,
    });
    const list = store.listDailySummaries(5);
    assert.equal(list.length, 2);
    assert.equal(list[0].summaryDate, '2026-07-30'); // newest first
    assert.equal(store.getDailySummary(5, '2026-07-29').summaryText, '前一天概要');
  } finally {
    cleanup();
  }
});

test('getActivityForDate returns only the bot\'s sessions and messages from that day', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const dreamStore = new DreamStore(db, () => {});

    const humanSession = coworkStore.createSession('和用户聊发布', '/tmp/a', '', 'local', [], 5);
    const peerSession = coworkStore.createSession(
      '和 PeerBot 对接', '/tmp/b', '', 'local', [], 5, 'a2a', 'peer-gmid', 'PeerBot', null
    );
    const otherBotSession = coworkStore.createSession('别的 bot', '/tmp/c', '', 'local', [], 6);

    insertMessage(db, humanSession.id, 'user', '今天我们发布吗', DAY_START + 1000, 1);
    insertMessage(db, humanSession.id, 'assistant', '可以,先跑测试', DAY_START + 2000, 2);
    insertMessage(db, humanSession.id, 'user', '昨天的消息不该出现', PREV_DAY, 0);
    insertMessage(db, peerSession.id, 'user', '接口字段确认一下', DAY_START + 3000, 1);
    insertMessage(db, peerSession.id, 'assistant', '保持现有协议', DAY_START + 4000, 2);
    insertMessage(db, otherBotSession.id, 'user', '其他 bot 的对话', DAY_START + 5000, 1);

    db.run(
      `INSERT INTO service_orders (
        id, role, local_metabot_id, counterparty_global_metaid, service_name,
        payment_txid, payment_chain, payment_amount, payment_currency,
        status, first_response_deadline_at, delivery_deadline_at,
        cowork_session_id, created_at, updated_at
      ) VALUES ('order-1', 'seller', 5, 'buyer-gmid', '翻译服务', 'tx-1', 'mvc', '1000', 'SPACE',
        'completed', 0, 0, ?, ?, ?)`,
      [peerSession.id, DAY_START, DAY_START]
    );
    // A second order on the same session: one session can carry many orders.
    db.run(
      `INSERT INTO service_orders (
        id, role, local_metabot_id, counterparty_global_metaid, service_name,
        payment_txid, payment_chain, payment_amount, payment_currency,
        status, first_response_deadline_at, delivery_deadline_at,
        cowork_session_id, created_at, updated_at
      ) VALUES ('order-2', 'seller', 5, 'buyer-gmid', '翻译服务', 'tx-2', 'mvc', '1000', 'SPACE',
        'completed', 0, 0, ?, ?, ?)`,
      [peerSession.id, DAY_START + 500, DAY_START + 500]
    );

    db.run(
      `INSERT INTO scheduled_tasks (id, name, schedule_json, prompt, metabot_id, created_at, updated_at)
       VALUES ('task-1', '每日巡检', '{}', '巡检一下', 5, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`
    );
    db.run(
      `INSERT INTO scheduled_task_runs (id, task_id, session_id, status, started_at)
       VALUES ('run-1', 'task-1', ?, 'success', ?)`,
      [humanSession.id, new Date(DAY_START + 6000).toISOString()]
    );

    const activity = dreamStore.getActivityForDate(5, DAY_START, DAY_END);

    assert.equal(activity.sessions.length, 2);
    const byTitle = new Map(activity.sessions.map((s) => [s.title, s]));

    const human = byTitle.get('和用户聊发布');
    assert.equal(human.sessionType, 'standard');
    assert.equal(human.isOrder, false);
    assert.deepEqual(human.messages.map((m) => m.content), ['今天我们发布吗', '可以,先跑测试']);

    const peer = byTitle.get('和 PeerBot 对接');
    assert.equal(peer.sessionType, 'a2a');
    assert.equal(peer.peerName, 'PeerBot');
    assert.equal(peer.isOrder, true);
    assert.equal(peer.messages.length, 2);

    assert.equal(activity.taskRuns.length, 1);
    assert.equal(activity.taskRuns[0].taskName, '每日巡检');
    assert.equal(activity.taskRuns[0].status, 'success');
    assert.equal(activity.orderCount, 2, 'raw order count, not order sessions');

    const otherBot = dreamStore.getActivityForDate(6, DAY_START, DAY_END);
    assert.equal(otherBot.sessions.length, 1);
    assert.equal(otherBot.taskRuns.length, 0);
    assert.equal(otherBot.orderCount, 0);
  } finally {
    cleanup();
  }
});

test('getActivityForDate surfaces human feedback on rated assistant messages', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const dreamStore = new DreamStore(db, () => {});
    const session = coworkStore.createSession('反馈会话', '/tmp/fb', '', 'local', [], 5);

    insertMessage(db, session.id, 'user', '给个方案', DAY_START + 1000, 1);
    insertMessage(db, session.id, 'assistant', '方案 A', DAY_START + 2000, 2);
    insertMessage(db, session.id, 'assistant', '方案 B', DAY_START + 3000, 3);

    db.run(
      `INSERT INTO message_feedback (message_id, session_id, rating, comment, created_at, updated_at)
       VALUES (?, ?, 'down', '方案不可行', ?, ?)`,
      [`msg-${session.id}-2`, session.id, DAY_START + 4000, DAY_START + 4000]
    );

    const activity = dreamStore.getActivityForDate(5, DAY_START, DAY_END);
    assert.equal(activity.sessions.length, 1);
    const messages = activity.sessions[0].messages;
    assert.equal(messages.length, 3);
    assert.equal(messages[1].feedbackRating, 'down');
    assert.equal(messages[1].feedbackComment, '方案不可行');
    assert.equal(messages[0].feedbackRating, undefined, 'unrated user message has no feedback');
    assert.equal(messages[0].feedbackComment, undefined);
    assert.equal(messages[2].feedbackRating, undefined, 'unrated assistant message has no feedback');
    assert.equal(messages[2].feedbackComment, undefined);
  } finally {
    cleanup();
  }
});

const insertGroupTask = (db, {
  id, groupId, title, goal, status, role = 'chair', metabotId = 5,
  ratedAt = null, closedAt = null, rating = null, ratingComment = null,
}) => {
  db.run(
    `INSERT INTO group_tasks (
      id, group_id, title, goal, status, chair_metabot_id, created_by,
      rating, rating_comment, rated_at, closed_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'user', ?, ?, ?, ?)`,
    [id, groupId, title, goal, status, metabotId, rating, ratingComment, ratedAt, closedAt],
  );
  db.run(
    'INSERT INTO group_task_members (task_id, metabot_id, role) VALUES (?, ?, ?)',
    [id, metabotId, role],
  );
};

const insertGroupChat = (db, { pinId, groupId, senderName, content, occurredAtMs, senderGlobalMetaId = null }) => {
  db.run(
    `INSERT INTO group_chat_messages (
      pin_id, group_id, sender_metaid, sender_global_metaid, sender_name,
      protocol, content, chain_timestamp
    ) VALUES (?, ?, 'mid-1', ?, ?, 'simplemsg', ?, ?)`,
    [pinId, groupId, senderGlobalMetaId, senderName, content, Math.floor(occurredAtMs / 1000)],
  );
};

test('getActivityForDate includes same-day group chat and in-progress group tasks', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const dreamStore = new DreamStore(db, () => {});

    insertGroupTask(db, {
      id: 20, groupId: 'gid-20', title: '西游记动画', goal: '做三维动画',
      status: 'done', ratedAt: '2026-07-30 10:00:00', closedAt: '2026-07-30 10:00:00',
      rating: 5, ratingComment: '完成度很高',
    });
    insertGroupChat(db, {
      pinId: 'pin-20-1', groupId: 'gid-20', senderName: 'PeerBot',
      content: '我先出分镜', occurredAtMs: DAY_START + 8_000,
      senderGlobalMetaId: 'idq1peer',
    });
    insertGroupChat(db, {
      pinId: 'pin-20-old', groupId: 'gid-20', senderName: 'PeerBot',
      content: '昨天的群聊不该出现', occurredAtMs: PREV_DAY,
    });

    insertGroupTask(db, {
      id: 21, groupId: 'gid-21', title: '官网方案', goal: '讨论定稿',
      status: 'review',
    });
    insertGroupChat(db, {
      pinId: 'pin-21-1', groupId: 'gid-21', senderName: 'Chair',
      content: '今天继续改第二稿', occurredAtMs: DAY_START + 9_000,
    });

    insertGroupTask(db, {
      id: 22, groupId: 'gid-22', title: '过期复盘', goal: '停在 review 但当天没动静',
      status: 'review',
    });

    insertGroupTask(db, {
      id: 23, groupId: 'gid-23', title: '只有技能回合', goal: '无群聊也要进当日摘要',
      status: 'executing',
    });
    const skillSession = coworkStore.createSession('Group Task #23', '/tmp/gt23', '', 'local', [], 5, 'group_task');
    insertMessage(db, skillSession.id, 'user', '群里有人在等你', DAY_START + 10_000, 1);
    insertMessage(db, skillSession.id, 'assistant', '我先回一条进度', DAY_START + 11_000, 2);
    db.run(
      `INSERT INTO cowork_conversation_mappings (
        channel, external_conversation_id, metabot_id, cowork_session_id, created_at, last_active_at
      ) VALUES ('metaweb_group_task', 'group-task:23', 5, ?, ?, ?)`,
      [skillSession.id, DAY_START, DAY_START],
    );

    const activity = dreamStore.getActivityForDate(5, DAY_START, DAY_END);
    assert.equal(activity.groupChats.length, 2);
    const byTitle = new Map(activity.groupChats.map((chat) => [chat.title, chat]));
    assert.deepEqual(byTitle.get('西游记动画').messages.map((message) => message.content), ['我先出分镜']);
    assert.equal(byTitle.get('官网方案').messages[0].senderName, 'Chair');

    const tasks = new Map(activity.groupTasks.map((task) => [task.taskId, task]));
    assert.equal(tasks.get(20).phase, 'accepted');
    assert.equal(tasks.get(20).rating, 5);
    assert.equal(tasks.get(20).dayMessageCount, 1);
    assert.equal(tasks.get(21).phase, 'active');
    assert.equal(tasks.get(21).status, 'review');
    assert.equal(tasks.get(23).phase, 'active');
    assert.equal(tasks.has(22), false, 'stale in-progress task with no same-day activity stays out');
    assert.equal(activity.sessions.some((session) => session.sessionType === 'group_task'), true);
  } finally {
    cleanup();
  }
});
