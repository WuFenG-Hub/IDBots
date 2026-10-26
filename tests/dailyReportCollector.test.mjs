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
  chainKindFromPath,
  computeDailyReportHasAnyActivity,
  computeDailyReportWindow,
  capDailyReportText,
  collectDailyReportFacts,
  enforceDailyReportFactsCap,
  shapeBotSessionsForBot,
  shapeChainInteractionFacts,
  shapeExternalChatFacts,
  shapeHourlyActivity,
  shapeHumanSessionRows,
  shapeOwnerOrchestrationRows,
  shapePendingFollowUpRows,
  shapeUpcomingFires,
  stripDailyReportSessionTitlePrefix,
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
  assert.equal(shaped[0].lastAssistantExcerpt.length, 600);
  assert.equal(shaped[0].lastUserExcerpt.length, 300);
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
    botActivity: [],
    upcoming: { scheduledFires: [], scheduledFiresTotal: 0, openOrchestrations: [], openOrchestrationByStatus: {} },
    hourlyActivity: { local: new Array(12).fill(0), online: new Array(12).fill(0) },
    knownBotCount: 0,
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
      // v2 botActivity: per-bot sessions (all types) with in-window counts.
      if (sql.includes('s.metabot_id IS NOT NULL')) {
        return [
          { metabot_id: 7, bot_name: 'W', session_id: 'bs1', session_title: '[编排任务] Deep work', session_type: 'standard', message_count: 10 },
          { metabot_id: 7, bot_name: 'W', session_id: 'bs2', session_title: 'Chit chat', session_type: 'a2a', message_count: 2 },
        ];
      }
      // v2 external DM peers (matched BEFORE the generic private-chat query).
      if (sql.includes('peer_global')) {
        return [{ metabot_id: 7, bot_name: 'W', bot_global: 'g-w', peer_global: 'g-peer', peer_name: 'BOT-007', message_count: 6 }];
      }
      if (sql.includes('m.to_global_metaid = ?')) return [{ content: 'peer chat excerpt' }];
      // v2 OpenTeam participation.
      if (sql.includes('FROM openteam_memberships')) {
        return [{ metabot_id: 7, bot_name: 'W', task_title: 'Remote jam', member_status: 'active', group_id: 'grp-1', joined_in_window: 1, status_in_window: 0 }];
      }
      if (sql.includes('g.group_id = ?')) return [{ cnt: 2 }];
      // v2 chain interactions.
      if (sql.includes('w.metabot_id = ? AND w.path')) return [{ summary: 'liked a pin' }];
      if (sql.includes('FROM metabot_chain_writes')) {
        return [{ metabot_id: 7, bot_name: 'W', path: '/protocols/paylike', cnt: 9 }];
      }
      // v2 hourly buckets.
      if (sql.includes('Datetime(m.created_at/1000')) return [{ h: 9, cnt: 4 }];
      if (sql.includes("strftime('%H', m.created_at, 'localtime')")) return [{ h: 1, cnt: 3 }];
      if (sql.includes('SELECT s.id FROM cowork_sessions s')) return [{ id: 'bs1' }];
      // v2 upcoming.
      if (sql.includes('next_run_at_ms')) {
        return [
          { next_run_at_ms: nowMs + 3600e3, name: 'Server patrol', bot_name: 'W' },
          { next_run_at_ms: nowMs + 7200e3, name: 'Digest', bot_name: null },
        ];
      }
      if (sql.includes('GROUP BY o.status')) return [{ status: 'review', cnt: 2 }];
      if (sql.includes("o.status IN ('planning','running','review')")) {
        return [{ owner_intent: 'Fix mobile login', status: 'review' }];
      }
      if (sql.includes('COUNT(*) AS cnt FROM metabots')) return [{ cnt: 4 }];
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
  // v2 buckets.
  assert.equal(facts.botActivity.length, 1);
  const bot = facts.botActivity[0];
  assert.equal(bot.botName, 'W');
  assert.equal(bot.isTwin, true, 'twinId 7 → isTwin');
  assert.equal(bot.totalSessions, 2);
  assert.equal(bot.totalMessages, 12);
  assert.equal(bot.sessions.length, 2);
  assert.equal(bot.sessions[0].title, '[编排任务] Deep work', 'sessions sorted by volume');
  assert.equal(bot.sessions[0].lastAssistantExcerpt, 'assistant says hi');
  assert.equal(bot.scheduledRunCount, 1);
  assert.deepEqual(bot.scheduledRuns, [{ taskName: 'Nightly inspect', status: 'success' }]);
  assert.equal(bot.externalChats.length, 1);
  assert.equal(bot.externalChats[0].peerName, 'BOT-007');
  assert.equal(bot.externalChats[0].lastExcerpt, 'peer chat excerpt');
  assert.deepEqual(bot.openTeam, [{ taskTitle: 'Remote jam', memberStatus: 'active', windowMessageCount: 2 }]);
  assert.deepEqual(bot.chainInteractions, [{ kind: 'paylike', count: 9, lastSummary: 'liked a pin' }]);
  assert.equal(bot.groupMessages, 2, 'merged from onlineActivity');
  assert.equal(facts.upcoming.scheduledFiresTotal, 2);
  assert.equal(facts.upcoming.scheduledFires[0].taskName, 'Server patrol');
  assert.match(facts.upcoming.scheduledFires[0].fireAtLocal, /^\d{2}:\d{2}$/);
  assert.deepEqual(facts.upcoming.openOrchestrationByStatus, { review: 2 });
  assert.equal(facts.upcoming.openOrchestrations.length, 1);
  assert.equal(facts.knownBotCount, 4);
  assert.equal(facts.hourlyActivity.local.reduce((sum, n) => sum + n, 0), 4);
  assert.equal(facts.hourlyActivity.online.reduce((sum, n) => sum + n, 0), 6, 'private + group online tables');
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

// ---------------------------------------------------------------------------
// v2 shaping: per-bot activity / upcoming / hourly
// ---------------------------------------------------------------------------

test('stripDailyReportSessionTitlePrefix: folds host-generated prefixes only', () => {
  assert.equal(stripDailyReportSessionTitlePrefix('[编排任务] MetaWeb Surf'), 'MetaWeb Surf');
  assert.equal(stripDailyReportSessionTitlePrefix('[定时] Patrol'), 'Patrol');
  assert.equal(stripDailyReportSessionTitlePrefix('[Orchestration Task] Build'), 'Build');
  assert.equal(stripDailyReportSessionTitlePrefix('[私聊] keep'), '[私聊] keep', 'non-generated prefixes stay');
});

test('shapeBotSessionsForBot: totals over all rows, top-N narrated with capped excerpts', () => {
  const rows = [
    { session_id: 'a', session_title: 'Big', session_type: 'standard', message_count: 10 },
    { session_id: 'b', session_title: 'Small', session_type: 'a2a', message_count: 2 },
    { session_id: 'c', session_title: 'Mid', session_type: 'browser', message_count: 5 },
  ];
  const shaped = shapeBotSessionsForBot(rows, new Map([['a', 'x'.repeat(300)]]), 2);
  assert.equal(shaped.totalSessions, 3);
  assert.equal(shaped.totalMessages, 17);
  assert.equal(shaped.sessions.length, 2);
  assert.deepEqual(shaped.sessions.map((s) => s.title), ['Big', 'Mid'], 'sorted by volume');
  assert.equal(shaped.sessions[0].lastAssistantExcerpt.length, 160, 'excerpt capped');
});

test('shapeExternalChatFacts: named peer, volume sort, metaid fallback, excerpt cap', () => {
  const rows = [
    { peer_global: 'p1', peer_name: 'BOT-007', message_count: 3 },
    { peer_global: 'p2', peer_name: null, message_count: 9 },
  ];
  const shaped = shapeExternalChatFacts(rows, new Map([['p2', 'y'.repeat(300)]]));
  assert.equal(shaped.length, 2);
  assert.equal(shaped[0].peerName, 'p2', 'unnamed peer falls back to the metaid prefix');
  assert.equal(shaped[0].messageCount, 9);
  assert.equal(shaped[0].lastExcerpt.length, 120);
  assert.equal(shaped[1].peerName, 'BOT-007');
});

test('chainKindFromPath + shapeChainInteractionFacts: last path segment, top-N', () => {
  assert.equal(chainKindFromPath('/protocols/paylike'), 'paylike');
  assert.equal(chainKindFromPath(''), 'write');
  const shaped = shapeChainInteractionFacts(
    [{ path: '/protocols/paylike', cnt: 2 }, { path: '/protocols/paycomment', cnt: 7 }],
    new Map([['/protocols/paycomment', 'replied']]),
  );
  assert.equal(shaped[0].kind, 'paycomment');
  assert.equal(shaped[0].lastSummary, 'replied');
});

test('shapeUpcomingFires: local HH:MM, sorted, total kept beyond the display cap', () => {
  const base = new Date(2026, 9, 22, 9, 0, 0).getTime();
  const shaped = shapeUpcomingFires([
    { next_run_at_ms: base + 7200e3, name: 'Later', bot_name: 'B' },
    { next_run_at_ms: base + 3600e3, name: 'Sooner', bot_name: null },
    { next_run_at_ms: 0, name: 'broken' },
  ], 1);
  assert.equal(shaped.scheduledFiresTotal, 2);
  assert.equal(shaped.scheduledFires.length, 1);
  assert.equal(shaped.scheduledFires[0].taskName, 'Sooner');
  assert.equal(shaped.scheduledFires[0].fireAtLocal, '10:00');
});

test('shapeHourlyActivity: 12 buckets, out-of-range hours dropped', () => {
  const shaped = shapeHourlyActivity(
    [{ h: 9, cnt: 4 }, { h: 25, cnt: 10 }, { bucket: 3, cnt: 2 }],
    [{ h: 1, cnt: 3 }],
  );
  assert.equal(shaped.local.length, 12);
  assert.equal(shaped.online.length, 12);
  assert.equal(shaped.local[4], 4, 'hour 9 lands in the 8-10 bucket');
  assert.equal(shaped.local[1], 2, 'bucket-style rows still feed in');
  assert.equal(shaped.online[0], 3);
  assert.equal(shaped.local.reduce((sum, n) => sum + n, 0), 6, 'hour 25 dropped');
});
