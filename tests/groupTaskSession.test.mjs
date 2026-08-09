/**
 * P1-3 invite immediate wake-up: eager worker-session creation (shared
 * helper) + group-context injection (goal/roster/recent transcript), guest
 * variant binding to the on-chain group id.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

// coworkStore imports electron; mock it (same as groupTaskDaemon.test.mjs).
const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: () => process.cwd(),
      },
    };
  }
  return originalLoad.call(this, request, ...rest);
};

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { GroupTaskStore } = require('../dist-electron/main/groupTaskStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');
const {
  ensureGroupTaskSession,
  ensureGroupTaskMemberReady,
  ensureOpenTeamGuestSession,
  injectOpenTeamGuestContext,
  GROUP_TASK_CONVERSATION_CHANNEL,
} = require('../dist-electron/main/services/groupTaskSession.js');

Module._load = originalLoad;

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-group-session-'));

const insertMetabot = (db, { id, name, type = 'worker', globalmetaid }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, id, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `public-${id}`, `chat-public-${id}`,
      name, 1, `metaid-${id}`, globalmetaid, type, '0000', `${name} role`, `${name} soul`,
      1700000000000 + id, 1700000000000 + id,
    ],
  );
};

const insertWallet = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at)
     VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id],
  );
};

const setup = async () => {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  const groupTaskStore = new GroupTaskStore(db, store.getSaveFunction());
  const coworkStore = new CoworkStore(db, () => {});
  insertWallet(db, 1);
  insertWallet(db, 2);
  insertMetabot(db, { id: 1, name: 'Twin Bot', type: 'twin', globalmetaid: 'gmid-twin' });
  insertMetabot(db, { id: 2, name: 'Coder Bot', globalmetaid: 'gmid-coder' });
  const task = groupTaskStore.createTask({
    groupId: 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000i0',
    title: 'Build MetaApp',
    goal: 'Ship the intro MetaApp',
    acceptanceCriteria: 'Preview URL works',
    chairMetabotId: 1,
    createdBy: 'user',
  });
  groupTaskStore.addMember({ taskId: task.id, metabotId: 1, globalmetaid: 'gmid-twin', role: 'chair' });
  groupTaskStore.addMember({ taskId: task.id, metabotId: 2, globalmetaid: 'gmid-w2', role: 'worker' });
  return { store, db, groupTaskStore, coworkStore, task, tempDir };
};

test('ensureGroupTaskSession creates the mapping once and reuses it', async () => {
  const { store, coworkStore, task, tempDir } = await setup();
  try {
    const first = ensureGroupTaskSession(coworkStore, task, 2, 'Coder Bot');
    assert.equal(first.created, true);
    const mapping = coworkStore.getConversationMapping(GROUP_TASK_CONVERSATION_CHANNEL, `group-task:${task.id}`, 2);
    assert.ok(mapping, 'conversation mapping created');
    assert.equal(mapping.coworkSessionId, first.session.id);
    assert.equal(first.session.sessionType, 'group_task');
    assert.match(first.session.title, /Group Task #\d+ \(Coder Bot\)/);

    const second = ensureGroupTaskSession(coworkStore, task, 2, 'Coder Bot');
    assert.equal(second.created, false, 'existing session reused');
    assert.equal(second.session.id, first.session.id);
  } finally {
    store.close();
  }
});

test('ensureGroupTaskMemberReady injects goal, roster and recent transcript into a fresh session', async () => {
  const { store, db, coworkStore, groupTaskStore, task, tempDir } = await setup();
  try {
    // A kickoff-style message so the injected snapshot has transcript lines.
    db.run(
      `INSERT INTO group_chat_messages (pin_id, tx_id, group_id, sender_metaid, sender_global_metaid,
        sender_name, protocol, content, mention, is_processed)
       VALUES ('kick-i0', 'kick', ?, 'metaid-twin', 'gmid-twin', 'Twin Bot',
        '/protocols/simplegroupchat', 'Goal: ship it [STATUS:EXECUTING]', '[]', 0)`,
      [task.groupId],
    );
    const { sessionId, created } = ensureGroupTaskMemberReady({
      coworkStore,
      groupTaskStore,
      task,
      botId: 2,
      botName: 'Coder Bot',
    });
    assert.equal(created, true);
    const messages = coworkStore.getSessionMessages(sessionId);
    assert.equal(messages.length, 1, 'one injected context snapshot');
    const snapshot = messages[0].content;
    assert.match(snapshot, /\[SYSTEM group context snapshot/);
    assert.match(snapshot, /Goal: Ship the intro MetaApp/);
    assert.match(snapshot, /Acceptance criteria: Preview URL works/);
    assert.match(snapshot, /Coder Bot \[worker\]/);
    assert.match(snapshot, /Twin Bot \[chair\]/);
    assert.match(snapshot, /Goal: ship it/);

    // Idempotent: re-running does NOT re-inject into a non-empty session.
    ensureGroupTaskMemberReady({ coworkStore, groupTaskStore, task, botId: 2, botName: 'Coder Bot' });
    assert.equal(coworkStore.getSessionMessages(sessionId).length, 1, 'no duplicate injection');
  } finally {
    store.close();
  }
});

test('guest sessions bind to the on-chain group id and inject the guest snapshot', async () => {
  const { store, coworkStore, tempDir } = await setup();
  try {
    const membership = { groupId: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdei0', taskTitle: 'Remote task' };
    const { session, created } = ensureOpenTeamGuestSession(coworkStore, 5, 'Reviewer Bot', membership);
    assert.equal(created, true);
    const mapping = coworkStore.getConversationMapping(
      GROUP_TASK_CONVERSATION_CHANNEL,
      `openteam:${membership.groupId}`,
      5,
    );
    assert.ok(mapping, 'guest mapping uses openteam:<groupId> external id');
    assert.equal(mapping.coworkSessionId, session.id);

    injectOpenTeamGuestContext({
      coworkStore,
      sessionId: session.id,
      taskTitle: 'Remote task',
      inviterGlobalmetaid: 'gmid-twin',
      recentMessages: [{ senderName: 'Chair Bot', content: 'Welcome!' }],
    });
    const messages = coworkStore.getSessionMessages(session.id);
    assert.equal(messages.length, 1);
    assert.match(messages[0].content, /\[SYSTEM OpenTeam context snapshot/);
    assert.match(messages[0].content, /"Remote task"/);
    assert.match(messages[0].content, /Chair Bot: Welcome!/);
  } finally {
    store.close();
  }
});
