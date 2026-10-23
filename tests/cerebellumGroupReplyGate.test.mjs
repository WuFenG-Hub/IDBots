import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import {
  CEREBELLUM_GROUP_REPLY_INSTRUCTIONS,
  CEREBELLUM_GROUP_REPLY_MESSAGE_MAX_CHARS,
  CEREBELLUM_GROUP_REPLY_QUESTION_ID,
  CEREBELLUM_GROUP_REPLY_RECENT_MAX,
  CEREBELLUM_GROUP_REPLY_THRESHOLD,
  buildGroupReplyRequest,
  decideGroupReplyWithCerebellum,
  groupReplyFromNoul,
  parseGroupReplyNoul,
  resolveUnsolicitedGroupReply,
} from '../src/main/cerebellum/groupReplyGate.ts';

const require = createRequire(import.meta.url);
const initSqlJs = require('sql.js');
const { runTickOnce } = require('../dist-electron/main/services/cognitiveOrchestrator.js');

const TEST_CONFIG = {
  provider: 'typesafe-jev',
  apiKey: 'sk-jev-test',
  baseUrl: 'https://jev.example.com',
  model: 'jev-latest',
};

function okFetch(payload, captured = []) {
  return async (url, init) => {
    captured.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => payload };
  };
}

function noulPayload(noul) {
  return {
    model: 'jev-latest',
    answers: { [CEREBELLUM_GROUP_REPLY_QUESTION_ID]: { noul } },
    usage: { input_tokens: 80 },
  };
}

test('buildGroupReplyRequest keeps the group text and caps recent lines', () => {
  const recent = Array.from({ length: CEREBELLUM_GROUP_REPLY_RECENT_MAX + 3 }, (_, index) => `第${index}句`);
  const request = buildGroupReplyRequest({
    botName: '大管家',
    latestMessage: '这个接口 401 了，谁看下',
    recentMessages: recent,
    model: 'jev-fast',
  });
  assert.equal(request.model, 'jev-fast');
  assert.equal(request.state.bot_name, '大管家');
  assert.equal(request.state.latest_message, '这个接口 401 了，谁看下');
  assert.equal(request.state.recent_messages.length, CEREBELLUM_GROUP_REPLY_RECENT_MAX);
  assert.equal(request.state.recent_messages[0], `第${recent.length - CEREBELLUM_GROUP_REPLY_RECENT_MAX}句`);
  const question = request.questions[CEREBELLUM_GROUP_REPLY_QUESTION_ID];
  assert.equal(question.type, 'noul');
  assert.equal(question.instructions, CEREBELLUM_GROUP_REPLY_INSTRUCTIONS);
  assert.match(question.instructions, /`latest_message`/);
  assert.match(question.instructions, /`bot_name`/);
});

test('buildGroupReplyRequest caps a long latest message without a lone surrogate', () => {
  const request = buildGroupReplyRequest({
    botName: 'bot',
    latestMessage: `${'a'.repeat(CEREBELLUM_GROUP_REPLY_MESSAGE_MAX_CHARS)}😀`,
    model: 'jev-latest',
  });
  const text = request.state.latest_message;
  assert.ok(text.length <= CEREBELLUM_GROUP_REPLY_MESSAGE_MAX_CHARS);
  const tail = text.charCodeAt(text.length - 1);
  assert.ok(tail < 0xd800 || tail > 0xdbff);
});

test('parseGroupReplyNoul clamps and rejects junk', () => {
  assert.equal(parseGroupReplyNoul(noulPayload(0.4)), 0.4);
  assert.equal(parseGroupReplyNoul(noulPayload(1.4)), 1);
  assert.equal(parseGroupReplyNoul(noulPayload(-0.2)), 0);
  assert.equal(parseGroupReplyNoul(noulPayload('high')), null);
  assert.equal(parseGroupReplyNoul(null), null);
  assert.equal(parseGroupReplyNoul({ answers: {} }), null);
});

test('groupReplyFromNoul over-replies at the default threshold', () => {
  assert.equal(groupReplyFromNoul(CEREBELLUM_GROUP_REPLY_THRESHOLD), true);
  assert.equal(groupReplyFromNoul(CEREBELLUM_GROUP_REPLY_THRESHOLD - 0.01), false);
  // Pinned to the 2026-10-23 live-calibrated value (see constant docstring).
  assert.equal(CEREBELLUM_GROUP_REPLY_THRESHOLD, 0.5);
});

test('resolveUnsolicitedGroupReply replaces the coin flip only on a boolean verdict', () => {
  assert.equal(resolveUnsolicitedGroupReply({ relevance: true, randomSample: 0.99, probability: 0.1 }), true);
  assert.equal(resolveUnsolicitedGroupReply({ relevance: false, randomSample: 0.01, probability: 1 }), false);
  assert.equal(resolveUnsolicitedGroupReply({ relevance: null, randomSample: 0.2, probability: 0.5 }), true);
  assert.equal(resolveUnsolicitedGroupReply({ relevance: null, randomSample: 0.8, probability: 0.5 }), false);
});

test('decideGroupReplyWithCerebellum posts one noul and returns the thresholded verdict', async () => {
  const captured = [];
  const reply = await decideGroupReplyWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl: okFetch(noulPayload(0.9), captured),
    botName: '大管家',
    latestMessage: '这个接口 401 了',
    recentMessages: ['刚才还是好的'],
  });
  assert.equal(reply, true);
  assert.equal(captured[0].url, 'https://jev.example.com/v1/systemone');
  assert.equal(captured[0].init.headers.Authorization, 'Bearer sk-jev-test');
  assert.equal(captured[0].body.state.latest_message, '这个接口 401 了');
  const skip = await decideGroupReplyWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl: okFetch(noulPayload(0.05)),
    botName: '大管家',
    latestMessage: '哈哈哈哈',
  });
  assert.equal(skip, false);
});

test('decideGroupReplyWithCerebellum returns null on failure and blank text', async () => {
  const entries = {
    botName: '大管家',
    latestMessage: '看一下这个报错',
  };
  for (const status of [401, 429, 500]) {
    assert.equal(await decideGroupReplyWithCerebellum({
      config: TEST_CONFIG,
      fetchImpl: async () => ({ ok: false, status, json: async () => ({}) }),
      ...entries,
    }), null);
  }
  assert.equal(await decideGroupReplyWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl: async () => { throw new Error('ECONNRESET'); },
    ...entries,
  }), null);
  assert.equal(await decideGroupReplyWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl: okFetch({ nope: true }),
    ...entries,
  }), null);
  let calls = 0;
  assert.equal(await decideGroupReplyWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl: async () => { calls += 1; return { ok: true, status: 200, json: async () => ({}) }; },
    botName: '大管家',
    latestMessage: '   ',
  }), null);
  assert.equal(calls, 0);
});

test('decideGroupReplyWithCerebellum aborts past the timeout', async () => {
  let abortSeen = false;
  const fetchImpl = (_url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
      abortSeen = true;
      reject(new Error('aborted'));
    });
  });
  const started = Date.now();
  const verdict = await decideGroupReplyWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl,
    botName: '大管家',
    latestMessage: 'hello',
    timeoutMs: 30,
  });
  assert.equal(verdict, null);
  assert.equal(abortSeen, true);
  assert.ok(Date.now() - started < 1000);
});

test('eval script builds the request through the module', () => {
  const source = readFileSync(new URL('../scripts/cerebellum-group-reply-eval.mjs', import.meta.url), 'utf8');
  assert.match(source, /buildGroupReplyRequest/);
  assert.match(source, /parseGroupReplyNoul/);
  assert.match(source, /groupReplyFromNoul/);
});

async function makeGroupDb({ content, probability = 1, replyOnMention = 1 }) {
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
      cooldown_seconds INTEGER NOT NULL DEFAULT 0,
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
      sender_metaid TEXT,
      sender_global_metaid TEXT,
      sender_name TEXT,
      content TEXT,
      mention TEXT,
      is_processed INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.run(
    `INSERT INTO group_chat_tasks (group_id, metabot_id, is_active, reply_on_mention, random_reply_probability, cooldown_seconds)
     VALUES ('g1', 7, 1, ?, ?, 0)`,
    [replyOnMention, probability],
  );
  db.run(
    `INSERT INTO group_chat_messages (pin_id, group_id, sender_name, sender_global_metaid, content, is_processed)
     VALUES ('pin-1', 'g1', 'Alice', 'alice-gmid', ?, 0)`,
    [content],
  );
  return db;
}

const BOT = {
  id: 7,
  name: 'TestBot',
  role: '',
  soul: '',
  globalmetaid: 'bot-gmid',
  metaid: 'bot-meta',
  boss_global_metaid: null,
};

async function runDecision({ content, probability, gate }) {
  const db = await makeGroupDb({ content, probability });
  const calls = [];
  const gateCalls = [];
  await runTickOnce(
    db,
    () => {},
    () => BOT,
    async () => {
      calls.push('llm');
      return 'ok';
    },
    async () => ({ pinId: `${'ab'.repeat(32)}i0` }),
    gate
      ? {
          cerebellumGroupReplyGate: async (input) => {
            gateCalls.push(input);
            return gate(input);
          },
        }
      : {},
  );
  return { calls, gateCalls };
}

test('runner: a mention replies without consulting the gate', async () => {
  const { calls, gateCalls } = await runDecision({
    content: 'TestBot 看一下这个报错',
    probability: 1,
    gate: () => false,
  });
  assert.equal(gateCalls.length, 0);
  assert.equal(calls.length, 1);
});

test('runner: a false verdict skips the unsolicited reply', async () => {
  const { calls, gateCalls } = await runDecision({
    content: '哈哈，今晚吃火锅',
    probability: 1,
    gate: () => false,
  });
  assert.equal(gateCalls.length, 1);
  assert.equal(gateCalls[0].botName, 'TestBot');
  assert.equal(gateCalls[0].latestMessage, '哈哈，今晚吃火锅');
  assert.equal(calls.length, 0);
});

test('runner: a true verdict replies even when the coin flip would miss', async () => {
  const { calls } = await runDecision({
    content: '这个接口 401 了谁看下',
    probability: 0.0000001,
    gate: () => true,
  });
  assert.equal(calls.length, 1);
});

test('runner: a null verdict keeps the coin flip', async () => {
  const replied = await runDecision({
    content: '随便聊聊',
    probability: 1,
    gate: () => null,
  });
  const silent = await runDecision({
    content: '随便聊聊',
    probability: 0,
    gate: () => null,
  });
  assert.equal(replied.calls.length, 1);
  assert.equal(silent.gateCalls.length, 0);
  assert.equal(silent.calls.length, 0);
});

test('runner: a throwing gate falls back to the coin flip', async () => {
  const { calls, gateCalls } = await runDecision({
    content: '随便聊聊',
    probability: 1,
    gate: () => { throw new Error('cerebellum exploded'); },
  });
  assert.equal(gateCalls.length, 1);
  assert.equal(calls.length, 1);
});

test('runner: an unwired gate with probability 1 still replies', async () => {
  const { calls, gateCalls } = await runDecision({
    content: '随便聊聊',
    probability: 1,
    gate: null,
  });
  assert.equal(gateCalls.length, 0);
  assert.equal(calls.length, 1);
});
