// src/main/services/dailyReportCollector.ts — deterministic fact collection
// for the Daily Report.
//
// Contract under test:
//   a. window computation — since last successful windowEnd; first run =
//      yesterday 00:00 local; 7-day lookback cap; degenerate windows clamp;
//   b. text caps — whitespace collapse, UTF-16-safe ellipsis cut;
//   c. bucket shaping — top-N, age/overdue math, step percent, excerpts;
//   d. hasAnyActivity — the E10 skip bit (digests never count as activity);
//   e. facts JSON cap — digests shrink first, then excerpts, then counts;
//   f. collectDailyReportFacts with a fake db — every bucket fails soft to
//      empty when its query throws, and the whole call still returns facts.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DAILY_REPORT_MAX_FACTS_JSON_BYTES,
  DAILY_REPORT_MAX_HUMAN_SESSIONS,
  DAILY_REPORT_MAX_PENDING_FOLLOW_UPS,
  computeDailyReportHasAnyActivity,
  computeDailyReportWindow,
  capDailyReportText,
  collectDailyReportFacts,
  enforceDailyReportFactsCap,
  shapeHumanSessionRows,
  shapeOwnerOrchestrationRows,
  shapePendingFollowUpRows,
} from '../src/main/services/dailyReportCollector.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

// local midnight helper (test machine timezone)
const localMidnightMs = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

test('computeDailyReportWindow: first run = yesterday 00:00 local → now', () => {
  const nowMs = new Date(2026, 9, 22, 9, 0, 0).getTime();
  const { windowStartMs, windowEndMs } = computeDailyReportWindow({ nowMs });
  assert.equal(windowEndMs, nowMs);
  assert.equal(windowStartMs, localMidnightMs(nowMs) - DAY_MS);
});

test('computeDailyReportWindow: since last successful windowEndMs', () => {
  const nowMs = new Date(2026, 9, 22, 9, 0, 0).getTime();
  const lastEnd = nowMs - 3 * 60 * 60 * 1000;
  const { windowStartMs } = computeDailyReportWindow({ nowMs, lastSuccessfulWindowEndMs: lastEnd });
  assert.equal(windowStartMs, lastEnd);
});

test('computeDailyReportWindow: lookback capped at 7 days', () => {
  const nowMs = new Date(2026, 9, 22, 9, 0, 0).getTime();
  const { windowStartMs } = computeDailyReportWindow({
    nowMs,
    lastSuccessfulWindowEndMs: nowMs - 30 * DAY_MS,
  });
  assert.equal(windowStartMs, nowMs - 7 * DAY_MS);
});

test('computeDailyReportWindow: degenerate window clamps to 1s', () => {
  const nowMs = new Date(2026, 9, 22, 9, 0, 0).getTime();
  const { windowStartMs } = computeDailyReportWindow({ nowMs, lastSuccessfulWindowEndMs: nowMs + 5000 });
  assert.equal(windowStartMs, nowMs - 1000);
});

test('capDailyReportText: collapses whitespace and cuts with ellipsis', () => {
  assert.equal(capDailyReportText('  a\n\t b   c ', 20), 'a b c');
  assert.equal(capDailyReportText('x'.repeat(10), 5), 'xxxx…');
  assert.equal(capDailyReportText('x'.repeat(10), 1), '…');
  assert.equal(capDailyReportText(null, 10), '');
  // lone-surrogate safety: cutting before a surrogate pair must not orphan it
  const withPair = `ab${'😀'}cd`;
  assert.equal(capDailyReportText(withPair, 3), 'ab…');
});

test('shapePendingFollowUpRows: caps, age and overdue from follow_up_at', () => {
  const nowMs = new Date(2026, 9, 22, 9, 0, 0).getTime();
  const rows = Array.from({ length: DAILY_REPORT_MAX_PENDING_FOLLOW_UPS + 3 }, (_, i) => ({
    id: `s${i}`,
    title: `session ${i}`,
    bot_name: i % 2 ? 'Twin' : null,
    follow_up_source: 'cerebellum',
    follow_up_at: new Date(nowMs - (i + 1) * DAY_MS).toISOString(),
  }));
  const shaped = shapePendingFollowUpRows(rows, nowMs);
  assert.equal(shaped.length, DAILY_REPORT_MAX_PENDING_FOLLOW_UPS);
  assert.equal(shaped[0].ageDays, 1);
  assert.equal(shaped[0].overdue, false);
  assert.equal(shaped[1].ageDays, 2);
  assert.equal(shaped[1].overdue, true, '>= 2 days is overdue');
  assert.equal(shaped[1].botName, 'Twin');
  const noStamp = shapePendingFollowUpRows([{ id: 'x', title: 't', follow_up_at: null }], nowMs);
  assert.equal(noStamp[0].ageDays, null);
  assert.equal(noStamp[0].overdue, false);
});

test('shapeOwnerOrchestrationRows: step percent and worker session links', () => {
  const tasks = [
    { id: 't1', owner_intent: 'Build the thing', status: 'running', updated_at: new Date().toISOString() },
    { id: 't2', owner_intent: 'Untouched', status: 'planning', updated_at: new Date().toISOString() },
  ];
  const steps = [
    { task_id: 't1', status: 'completed' },
    { task_id: 't1', status: 'completed' },
    { task_id: 't1', status: 'running' },
    { task_id: 't1', status: 'blocked' },
  ];
  const attempts = [
    { task_id: 't1', worker_session_id: 'ws1' },
    { task_id: 't1', worker_session_id: 'ws1' },
    { task_id: 't1', worker_session_id: 'ws2' },
  ];
  const shaped = shapeOwnerOrchestrationRows(tasks, steps, attempts);
  assert.equal(shaped.length, 2);
  assert.equal(shaped[0].stepsDone, 2);
  assert.equal(shaped[0].stepsTotal, 4);
  assert.equal(shaped[0].percentComplete, 50);
  assert.deepEqual(shaped[0].workerSessionIds, ['ws1', 'ws2'], 'deduped, capped at 5');
  assert.equal(shaped[1].percentComplete, null, 'no steps → no percent');
});

test('shapeHumanSessionRows: excerpts capped, assistant + user kept separate', () => {
  const rows = [{ id: 's1', title: 'Chat', bot_name: 'W', human_user_count: 3, assistant_count: 9 }];
  const excerpts = new Map([{ assistant: 'A'.repeat(2000), user: 'U'.repeat(800) }].map((e) => ['s1', e]));
  const shaped = shapeHumanSessionRows(rows, excerpts);
  assert.equal(shaped.length, 1);
  assert.equal(shaped[0].lastAssistantExcerpt.length, 1500);
  assert.equal(shaped[0].lastUserExcerpt.length, 500);
  assert.equal(shaped[0].humanUserMessages, 3);
  assert.equal(shaped[0].assistantMessages, 9);
});

test('computeDailyReportHasAnyActivity: E10 skip bit, digests excluded', () => {
  const base = {
    pendingFollowUps: [],
    ownerOrchestrations: [],
    humanSessions: [],
    machineActivity: {
      scheduledRuns: [],
      groupTaskTransitions: [],
      longTermEvents: [],
      twinDelegateOrchestrationsInWindow: 0,
    },
    onlineActivity: [],
    newSessionCount: 0,
  };
  assert.equal(computeDailyReportHasAnyActivity(base), false);
  assert.equal(computeDailyReportHasAnyActivity({ ...base, newSessionCount: 1 }), true, 'any new session counts');
  assert.equal(computeDailyReportHasAnyActivity({ ...base, pendingFollowUps: [1] }), true);
  assert.equal(
    computeDailyReportHasAnyActivity({
      ...base,
      machineActivity: { ...base.machineActivity, twinDelegateOrchestrationsInWindow: 2 },
    }),
    true,
  );
  assert.equal(
    computeDailyReportHasAnyActivity({ ...base, onlineActivity: [{ privateMessageCount: 0, groupMessageCount: 1 }] }),
    true,
  );
});

test('enforceDailyReportFactsCap: shrinks digests then excerpts to fit the budget', () => {
  const nowMs = Date.now();
  const facts = {
    generatedAtMs: nowMs,
    windowStartMs: nowMs - DAY_MS,
    windowEndMs: nowMs,
    pendingFollowUps: [],
    ownerOrchestrations: [],
    humanSessions: [{
      sessionId: 's1',
      title: 't',
      botName: null,
      sessionType: 'standard',
      humanUserMessages: 1,
      assistantMessages: 1,
      lastAssistantExcerpt: 'x'.repeat(1500),
      lastUserExcerpt: null,
    }],
    machineActivity: {
      scheduledRuns: [],
      groupTaskTransitions: [],
      longTermEvents: [],
      longTermProgress: [],
      twinDelegateOrchestrationsInWindow: 0,
    },
    botDigests: Array.from({ length: 12 }, (_, i) => ({
      botName: `bot${i}`,
      isTwin: false,
      summaryDate: '2026-10-21',
      summaryText: 'd'.repeat(1200),
    })),
    onlineActivity: [],
    newSessionCount: 0,
    hasAnyActivity: true,
  };
  const capped = enforceDailyReportFactsCap(facts, DAILY_REPORT_MAX_FACTS_JSON_BYTES);
  assert.ok(
    Buffer.byteLength(JSON.stringify(capped), 'utf8') <= DAILY_REPORT_MAX_FACTS_JSON_BYTES,
    'fits the 20KB ledger budget',
  );
  assert.equal(capped.botDigests.length <= facts.botDigests.length, true);
});

test('collectDailyReportFacts: full pass over a fake db; broken buckets fail soft', () => {
  const nowMs = new Date(2026, 9, 22, 9, 0, 0).getTime();
  const windowStartMs = nowMs - DAY_MS;
  const calls = [];
  const fakeDb = {
    queryAll(sql, params = []) {
      calls.push(sql);
      if (sql.includes('FROM cowork_sessions s') && sql.includes('follow_up_state')) {
        return [{ id: 'fu1', title: 'Decide shipping', follow_up_source: 'cerebellum', follow_up_at: new Date(nowMs - 3 * DAY_MS).toISOString(), bot_name: 'Twin' }];
      }
      if (sql.includes('FROM orchestration_tasks t')) {
        return [{ id: 'ot1', owner_intent: 'Owner task', status: 'running', updated_at: new Date(nowMs - 1000).toISOString() }];
      }
      if (sql.includes('twin_delegate')) return [{ cnt: 1 }];
      if (sql.includes('FROM orchestration_steps')) {
        return [{ task_id: 'ot1', status: 'completed' }, { task_id: 'ot1', status: 'running' }];
      }
      if (sql.includes('FROM orchestration_attempts')) {
        return [{ task_id: 'ot1', worker_session_id: 'ws9' }];
      }
      if (sql.includes('human_user_count')) {
        return [{ id: 'hs1', title: 'Human chat', session_type: 'standard', updated_at: nowMs, bot_name: 'W', human_user_count: 2, assistant_count: 4 }];
      }
      if (sql.includes("m.type = 'assistant'")) return [{ content: 'assistant says hi' }];
      if (sql.includes("m.type = 'user'")) return [{ content: 'user asked' }];
      if (sql.includes('FROM scheduled_task_runs')) {
        return [{ task_name: 'Nightly inspect', bot_name: 'W', status: 'success', skip_reason: null, started_at: new Date(nowMs - 3600e3).toISOString(), error: null }];
      }
      if (sql.includes('FROM group_task_transitions')) return [];
      if (sql.includes('FROM long_term_events')) return [];
      if (sql.includes('FROM long_term_tasks t')) return [];
      if (sql.includes('FROM metabot_daily_summaries')) {
        return [{ metabot_id: 7, bot_name: 'W', metabot_type: 'worker', summary_date: '2026-10-21', summary_text: 'Quiet day' }];
      }
      if (sql.includes('FROM private_chat_messages')) return [{ metabot_id: 7, bot_name: 'W', message_count: 5 }];
      if (sql.includes('FROM group_chat_messages')) return [{ metabot_id: 7, bot_name: 'W', message_count: 2 }];
      if (sql.includes('COUNT(*) AS cnt FROM cowork_sessions')) return [{ cnt: 3 }];
      throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
    },
  };
  const facts = collectDailyReportFacts({ db: fakeDb, windowStartMs, windowEndMs: nowMs, twinId: 7 });
  assert.equal(facts.pendingFollowUps.length, 1);
  assert.equal(facts.pendingFollowUps[0].overdue, true);
  assert.equal(facts.ownerOrchestrations.length, 1);
  assert.equal(facts.ownerOrchestrations[0].percentComplete, 50);
  assert.equal(facts.humanSessions.length, 1);
  assert.equal(facts.humanSessions[0].lastAssistantExcerpt, 'assistant says hi');
  assert.equal(facts.humanSessions[0].lastUserExcerpt, 'user asked');
  assert.equal(facts.machineActivity.scheduledRuns.length, 1);
  assert.equal(facts.botDigests.length, 1);
  assert.equal(facts.botDigests[0].isTwin, true, 'digest of twinId 7 is flagged');
  assert.equal(facts.onlineActivity.length, 1);
  assert.equal(facts.onlineActivity[0].privateMessageCount, 5);
  assert.equal(facts.newSessionCount, 3);
  assert.equal(facts.hasAnyActivity, true);
  assert.ok(
    Buffer.byteLength(JSON.stringify(facts), 'utf8') <= DAILY_REPORT_MAX_FACTS_JSON_BYTES,
    'facts fit the ledger budget',
  );

  // Broken db: every bucket throws → facts still returned, all empty, skip bit false.
  const brokenDb = { queryAll: () => { throw new Error('db gone'); } };
  const empty = collectDailyReportFacts({ db: brokenDb, windowStartMs, windowEndMs: nowMs, twinId: 7 });
  assert.equal(empty.pendingFollowUps.length, 0);
  assert.equal(empty.humanSessions.length, 0);
  assert.equal(empty.botDigests.length, 0);
  assert.equal(empty.hasAnyActivity, false, 'zero activity → skippable day');
});

test('collectDailyReportFacts: zero activity window sets hasAnyActivity false', () => {
  const nowMs = new Date(2026, 9, 22, 9, 0, 0).getTime();
  const emptyDb = { queryAll: () => [] };
  const facts = collectDailyReportFacts({ db: emptyDb, windowStartMs: nowMs - DAY_MS, windowEndMs: nowMs, twinId: 1 });
  assert.equal(facts.hasAnyActivity, false);
  assert.equal(facts.newSessionCount, 0);
});
