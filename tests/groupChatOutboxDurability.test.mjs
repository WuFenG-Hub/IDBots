/**
 * Issue #40 regression tests: group-chat reply delivery durability.
 *
 * These tests exercise the REAL compiled orchestrator
 * (dist-electron/main/services/cognitiveOrchestrator.js) against an in-memory
 * sql.js database that mirrors the production group_chat_tasks /
 * group_chat_messages schema. The outbox table is intentionally NOT created by
 * the fixture: the fixed orchestrator must create it itself (idempotent
 * ensureGroupChatOutboxSchema), and a missing table is treated as "no
 * obligations yet" so the same file can also run against the pre-fix build to
 * reproduce the bug.
 *
 * Covered failure facts (issue #40):
 *   1. failed broadcast -> durable retry obligation (not a lost log line);
 *   2. failed broadcast -> cursor does NOT advance past the trigger message;
 *      it advances only once the obligation is terminal (submitted/abandoned);
 *   3. transport ACK (pinId) is captured on the obligation.
 *
 * Rework (N1 regression, second review): the outbox key and the reply gate are
 *   4. keyed (group_id, metabot_id, trigger_msg_id): ONE trigger message that
 *      reaches TWO bots of the same group delivers BOTH replies. Keying by
 *      (group_id, trigger_msg_id) alone swallowed the second bot's reply and
 *      advanced its cursor anyway.
 *
 * Run (fixed build):   npm run compile:electron && node --test tests/groupChatOutboxDurability.test.mjs
 * Cross-bot cases only: node --test --test-name-pattern='two bots|second bot' tests/groupChatOutboxDurability.test.mjs
 * Reproduce pre-fix:   git stash push -u -- src/main && npm run compile:electron
 *                      && node --test tests/groupChatOutboxDurability.test.mjs
 *                      # expect failures; then git stash pop && npm run compile:electron
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const initSqlJs = require('sql.js');
const { runTickOnce } = require('../dist-electron/main/services/cognitiveOrchestrator.js');

// Contract constant from the outbox module when available (fixed build);
// falls back to the pinned value so the pre-fix repro run still executes.
const outboxModule = (() => {
  try {
    return require('../dist-electron/main/services/groupChatOutbox.js');
  } catch {
    return null;
  }
})();
const MAX_ATTEMPTS = outboxModule?.GROUP_CHAT_OUTBOX_MAX_ATTEMPTS ?? 5;

const GROUP_ID = 'group-outbox-durability';
const BOT_NAME = 'TestBot';
const TRIGGER_TEXT = `${BOT_NAME}, please summarise the status.`;
const REPLY_TEXT = 'Status: all good (mock reply).';
const ACK_PIN = `${'ab'.repeat(32)}i0`; // 64 hex chars + i0

async function makeFixture() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE group_chat_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      metabot_id INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      reply_on_mention INTEGER NOT NULL DEFAULT 1,
      random_reply_probability REAL NOT NULL DEFAULT 0.1,
      cooldown_seconds INTEGER NOT NULL DEFAULT 15,
      context_message_count INTEGER NOT NULL DEFAULT 30,
      discussion_background TEXT,
      participation_goal TEXT,
      supervisor_metaid TEXT,
      supervisor_globalmetaid TEXT,
      allowed_skills TEXT,
      original_prompt TEXT,
      start_time TEXT,
      last_replied_at TEXT,
      last_processed_msg_id INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.run(`
    CREATE TABLE group_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pin_id TEXT UNIQUE NOT NULL,
      group_id TEXT NOT NULL,
      channel_id TEXT,
      sender_metaid TEXT,
      sender_global_metaid TEXT,
      sender_address TEXT,
      sender_name TEXT,
      content TEXT,
      content_type TEXT,
      encryption TEXT,
      reply_pin TEXT,
      mention TEXT,
      chain_timestamp INTEGER,
      chain TEXT,
      raw_data TEXT,
      is_processed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.run(
    `INSERT INTO group_chat_tasks
       (group_id, metabot_id, is_active, reply_on_mention, random_reply_probability,
        cooldown_seconds, context_message_count, last_processed_msg_id)
     VALUES (?, 7, 1, 1, 0, 0, 30, 0)`,
    [GROUP_ID]
  );
  db.run(
    `INSERT INTO group_chat_messages (pin_id, group_id, sender_name, content, is_processed)
     VALUES ('msg-pin-1', ?, 'Alice', ?, 0)`,
    [GROUP_ID, TRIGGER_TEXT]
  );
  return db;
}

function makeDeps(onBroadcast, options = {}) {
  const llmCalls = [];
  const broadcasts = [];
  const nameFor = options.botNameFor ?? (() => BOT_NAME);
  const getMetabotById = (id) => ({
    id,
    name: nameFor(id),
    role: 'helper',
    soul: 'direct',
    llm_id: null,
    globalmetaid: `bot-global-${id}`,
    metaid: `bot-meta-${id}`,
    boss_global_metaid: null,
    allow_chat_skills: [],
  });
  const performChatCompletion = async (systemPrompt, userMessage) => {
    llmCalls.push({ systemPrompt, userMessage });
    return REPLY_TEXT;
  };
  const broadcastGroupChat = async (metabotId, groupId, nickName, content) => {
    const call = { metabotId, groupId, nickName, content, at: broadcasts.length };
    broadcasts.push(call);
    return onBroadcast(call);
  };
  return { getMetabotById, performChatCompletion, broadcastGroupChat, llmCalls, broadcasts };
}

function tick(db, deps) {
  return runTickOnce(
    db,
    () => {},
    deps.getMetabotById,
    deps.performChatCompletion,
    deps.broadcastGroupChat
  );
}

function scalar(db, sql, params = []) {
  return db.exec(sql, params)[0]?.values?.[0]?.[0] ?? null;
}

/** Outbox rows, tolerant of a missing table (pre-fix build). */
function readOutboxRows(db) {
  try {
    const result = db.exec('SELECT * FROM group_chat_outbox ORDER BY id ASC');
    const columns = result[0]?.columns ?? [];
    return (result[0]?.values ?? []).map((row) => {
      const record = {};
      columns.forEach((col, i) => {
        record[col] = row[i];
      });
      return record;
    });
  } catch (err) {
    if (/no such table/i.test(String(err?.message))) return [];
    throw err;
  }
}

/** Force every pending obligation due (test seam for the backoff gate). */
function forceOutboxDue(db) {
  try {
    db.run('UPDATE group_chat_outbox SET next_attempt_at = 0');
    return true;
  } catch (err) {
    if (/no such table/i.test(String(err?.message))) return false;
    throw err;
  }
}

const cursor = (db) => Number(scalar(db, 'SELECT last_processed_msg_id FROM group_chat_tasks WHERE group_id = ?', [GROUP_ID]));

/** Cursor of ONE bot task in GROUP_ID (cross-bot cases run two tasks). */
const botCursor = (db, metabotId) =>
  Number(
    scalar(db, 'SELECT last_processed_msg_id FROM group_chat_tasks WHERE group_id = ? AND metabot_id = ?', [
      GROUP_ID,
      metabotId,
    ])
  );

test('failed broadcast persists a pending obligation and keeps the cursor before the trigger message', async () => {
  const db = await makeFixture();
  const deps = makeDeps(() => {
    throw new Error('simulated gateway 502');
  });

  await tick(db, deps);

  assert.equal(deps.llmCalls.length, 1, 'LLM reply generated once');
  assert.equal(deps.broadcasts.length, 1, 'one broadcast attempt');
  assert.equal(
    cursor(db),
    0,
    'cursor must NOT advance past the trigger message (id 1) while its reply is undelivered'
  );

  const rows = readOutboxRows(db);
  assert.equal(rows.length, 1, 'exactly one durable obligation must exist');
  const row = rows[0];
  assert.equal(row.state, 'pending');
  assert.equal(Number(row.attempts), 1);
  assert.equal(Number(row.trigger_msg_id), 1);
  assert.equal(row.content, REPLY_TEXT);
  assert.match(String(row.last_error), /simulated gateway 502/);
  assert.equal(row.pin_id, null);
});

test('pending obligation is retried with the stored text (no LLM re-run) and releases the cursor after success', async () => {
  const db = await makeFixture();
  const deps = makeDeps((call) => {
    if (call.at === 0) throw new Error('simulated fee spike');
    return { pinId: ACK_PIN };
  });

  await tick(db, deps); // inline attempt fails -> pending
  assert.equal(readOutboxRows(db)[0]?.state, 'pending');

  await tick(db, deps); // not due yet: backoff gate must skip the retry
  assert.equal(deps.broadcasts.length, 1, 'retry must wait for the backoff window');
  assert.equal(cursor(db), 0, 'cursor stays pinned while the obligation is pending');

  forceOutboxDue(db);
  await tick(db, deps); // retry succeeds

  assert.equal(deps.llmCalls.length, 1, 'retry reuses the stored text: the LLM must not run again');
  assert.equal(deps.broadcasts.length, 2, 'exactly one retry attempt');
  assert.equal(deps.broadcasts[1].content, REPLY_TEXT, 'retry broadcasts the stored obligation text');
  assert.equal(deps.broadcasts[1].nickName, BOT_NAME);

  const row = readOutboxRows(db)[0];
  assert.ok(row, 'obligation row must exist');
  assert.equal(row.state, 'submitted');
  assert.equal(Number(row.attempts), 2);
  assert.equal(row.pin_id, ACK_PIN);
  assert.equal(cursor(db), 1, 'cursor advances once the obligation is terminal');
});

test('successful broadcast records the transport ACK pinId on the obligation', async () => {
  const db = await makeFixture();
  const deps = makeDeps(() => ({ pinId: ACK_PIN }));

  await tick(db, deps);

  assert.equal(deps.llmCalls.length, 1);
  assert.equal(deps.broadcasts.length, 1);

  const row = readOutboxRows(db)[0];
  assert.ok(row, 'obligation row must exist');
  assert.equal(row.state, 'submitted');
  assert.equal(row.pin_id, ACK_PIN, 'transport ACK must be captured');
  assert.equal(Number(row.attempts), 1);
  assert.equal(cursor(db), 1);
});

test('after MAX attempts the obligation is abandoned (terminal) and the cursor unblocks', async () => {
  const db = await makeFixture();
  const deps = makeDeps(() => {
    throw new Error('simulated persistent outage');
  });

  await tick(db, deps); // attempt 1 (inline)
  for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
    forceOutboxDue(db);
    await tick(db, deps);
  }

  assert.equal(deps.llmCalls.length, 1, 'still no LLM re-run across retries');
  assert.equal(deps.broadcasts.length, MAX_ATTEMPTS, 'one inline attempt plus retries up to the cap');

  const row = readOutboxRows(db)[0];
  assert.ok(row, 'obligation row must exist (kept for audit)');
  assert.equal(row.state, 'abandoned');
  assert.equal(Number(row.attempts), MAX_ATTEMPTS);
  assert.match(String(row.last_error), /simulated persistent outage/);
  assert.equal(
    cursor(db),
    1,
    'abandoned is terminal: the cursor must advance so the group is not blocked forever'
  );
});

test('one bot\'s pending obligation never pins another bot task\'s cursor in the same group', async () => {
  const db = await makeFixture();
  db.run(
    `INSERT INTO group_chat_tasks
       (group_id, metabot_id, is_active, reply_on_mention, random_reply_probability,
        cooldown_seconds, context_message_count, last_processed_msg_id)
     VALUES (?, 8, 1, 1, 0, 0, 30, 0)`,
    [GROUP_ID]
  );
  db.run(
    `INSERT INTO group_chat_messages (pin_id, group_id, sender_name, content, is_processed)
     VALUES ('msg-pin-2', ?, 'Bob', 'OtherBot, your turn please.', 0)`,
    [GROUP_ID]
  );
  const deps = makeDeps(
    (call) => {
      if (call.metabotId === 7) throw new Error('simulated bot-A outage');
      return { pinId: ACK_PIN };
    },
    { botNameFor: (id) => (id === 7 ? BOT_NAME : 'OtherBot') }
  );

  await tick(db, deps);

  // Bot A (metabot 7) failed on message 1 -> pending, its own cursor pinned.
  const rows = readOutboxRows(db);
  assert.equal(rows.length, 2, 'both bots produced an obligation');
  const rowA = rows.find((row) => Number(row.metabot_id) === 7);
  const rowB = rows.find((row) => Number(row.metabot_id) === 8);
  assert.ok(rowA && rowB, 'both obligation rows must exist');
  assert.equal(rowA.state, 'pending');
  assert.equal(rowB.state, 'submitted');

  const cursorOf = (metabotId) =>
    Number(
      scalar(db, 'SELECT last_processed_msg_id FROM group_chat_tasks WHERE group_id = ? AND metabot_id = ?', [
        GROUP_ID,
        metabotId,
      ])
    );
  assert.equal(cursorOf(7), 0, 'bot A stays pinned before its undelivered trigger message');
  assert.equal(cursorOf(8), 2, 'bot B processes its own message stream unaffected by bot A');
});

/**
 * N1 regression (second review): ONE trigger message that mentions BOTH bots of
 * the same group. The outbox key was (group_id, trigger_msg_id), so the second
 * bot's enqueue was IGNORED, the reply gate matched the first bot's obligation
 * and the second bot's reply was silently swallowed while its cursor advanced.
 * Fixed: the key/gate are (group_id, metabot_id, trigger_msg_id).
 */
test('same trigger message reaching two bots in one group delivers BOTH replies (N1 regression)', async () => {
  const db = await makeFixture();
  // Second bot task in the SAME group; message 1 mentions BOTH bot names.
  db.run(
    `INSERT INTO group_chat_tasks
       (group_id, metabot_id, is_active, reply_on_mention, random_reply_probability,
        cooldown_seconds, context_message_count, last_processed_msg_id)
     VALUES (?, 8, 1, 1, 0, 0, 30, 0)`,
    [GROUP_ID]
  );
  db.run('UPDATE group_chat_messages SET content = ? WHERE id = 1', [
    `${BOT_NAME} and OtherBot, please summarise the status.`,
  ]);
  const pinA = `${'aa'.repeat(32)}i0`;
  const pinB = `${'bb'.repeat(32)}i0`;
  const deps = makeDeps(
    (call) => ({ pinId: call.metabotId === 7 ? pinA : pinB }),
    { botNameFor: (id) => (id === 7 ? BOT_NAME : 'OtherBot') }
  );

  await tick(db, deps);

  assert.equal(deps.llmCalls.length, 2, 'each bot runs its own reply pipeline');
  assert.equal(deps.broadcasts.length, 2, 'BOTH bots must broadcast their own reply (no silent swallow)');
  assert.deepEqual(
    deps.broadcasts.map((call) => call.metabotId).sort((a, b) => a - b),
    [7, 8],
    'both broadcast attempts must belong to the two different bots'
  );

  const rows = readOutboxRows(db);
  assert.equal(rows.length, 2, 'one obligation per (group, bot, trigger message)');
  const rowA = rows.find((row) => Number(row.metabot_id) === 7);
  const rowB = rows.find((row) => Number(row.metabot_id) === 8);
  assert.ok(rowA && rowB, 'both obligation rows must exist');
  assert.equal(Number(rowA.trigger_msg_id), 1);
  assert.equal(Number(rowB.trigger_msg_id), 1, 'both bots reply to the SAME trigger message');
  assert.equal(rowA.state, 'submitted');
  assert.equal(rowB.state, 'submitted');
  assert.equal(rowA.pin_id, pinA);
  assert.equal(rowB.pin_id, pinB, 'each obligation carries its own bot transport ACK');

  assert.equal(botCursor(db, 7), 1, 'bot A cursor advances after its own delivery');
  assert.equal(botCursor(db, 8), 1, 'bot B cursor advances after its own delivery (not silently skipped)');
});

/**
 * N1 regression, failure variant: bot A's send fails while bot B's succeeds on
 * the SAME trigger message. Bot B must still reply, and no mark submitted /
 * failure write may touch the other bot's obligation row.
 */
test("a failing first bot never suppresses the second bot's reply nor cross-writes its obligation", async () => {
  const db = await makeFixture();
  db.run(
    `INSERT INTO group_chat_tasks
       (group_id, metabot_id, is_active, reply_on_mention, random_reply_probability,
        cooldown_seconds, context_message_count, last_processed_msg_id)
     VALUES (?, 8, 1, 1, 0, 0, 30, 0)`,
    [GROUP_ID]
  );
  db.run('UPDATE group_chat_messages SET content = ? WHERE id = 1', [
    `${BOT_NAME} and OtherBot, please summarise the status.`,
  ]);
  const deps = makeDeps(
    (call) => {
      if (call.metabotId === 7) throw new Error('simulated bot-A outage');
      return { pinId: ACK_PIN };
    },
    { botNameFor: (id) => (id === 7 ? BOT_NAME : 'OtherBot') }
  );

  await tick(db, deps);

  assert.equal(deps.broadcasts.length, 2, 'both bots must attempt their own send');

  const rows = readOutboxRows(db);
  assert.equal(rows.length, 2, "bot B's reply must not be swallowed by bot A's obligation");
  const rowA = rows.find((row) => Number(row.metabot_id) === 7);
  const rowB = rows.find((row) => Number(row.metabot_id) === 8);
  assert.ok(rowA && rowB, 'both obligation rows must exist');

  assert.equal(rowA.state, 'pending', "bot A's failed obligation stays retryable");
  assert.equal(Number(rowA.attempts), 1);
  assert.equal(rowA.pin_id, null, "bot B's ACK must not be cross-written into bot A's row");

  assert.equal(rowB.state, 'submitted', "bot B's delivery is recorded on bot B's own row");
  assert.equal(Number(rowB.attempts), 1);
  assert.equal(rowB.pin_id, ACK_PIN);

  assert.equal(botCursor(db, 7), 0, 'bot A stays pinned before its undelivered trigger message');
  assert.equal(botCursor(db, 8), 1, 'bot B advances once its own reply is delivered');
});
