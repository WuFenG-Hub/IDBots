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

test('fix-v2 B6: a mid-task session (re)creation injects the authoritative task ledger', async () => {
  const { store, db, coworkStore, groupTaskStore, task, tempDir } = await setup();
  try {
    // Simulate a task mid-flight: status moved to executing, one deliverable
    // delivered by the worker (the chair's session was rebuilt at this point
    // in task #55 — it must recover this state from the host, not memory).
    groupTaskStore.updateTaskStatus(task.id, 'executing');
    groupTaskStore.addDeliverable({
      taskId: task.id,
      msgPinId: 'delivery-pin-i0',
      authorGlobalmetaid: 'gmid-w2',
      kind: 'metaapp',
      uri: `metaapp://${'cd'.repeat(32)}i0`,
    });
    // The source message whose pin matches the deliverable row — the ledger
    // joins the author name from it.
    db.run(
      `INSERT INTO group_chat_messages (pin_id, tx_id, group_id, sender_metaid, sender_global_metaid,
        sender_name, protocol, content, mention, is_processed)
       VALUES ('delivery-pin-i0', 'del', ?, 'metaid-2', 'gmid-w2', 'Coder Bot',
        '/protocols/simplegroupchat', '[DELIVERABLE] metaapp done', '[]', 0)`,
      [task.groupId],
    );

    const { sessionId, created } = ensureGroupTaskMemberReady({
      coworkStore,
      groupTaskStore,
      task: groupTaskStore.getTaskById(task.id),
      botId: 1,
      botName: 'Twin Bot',
    });
    assert.equal(created, true);
    const snapshot = coworkStore.getSessionMessages(sessionId)[0].content;
    assert.match(snapshot, /Task ledger \(authoritative host state/);
    assert.match(snapshot, /Status: executing/);
    assert.match(snapshot, /Status trail: planning -> executing/);
    assert.match(snapshot, /Deliverables on the ledger \(1\)/);
    assert.match(snapshot, /\[metaapp\] metaapp:\/\/cd+.*\(pending, unconfirmed\) by Coder Bot/);
  } finally {
    store.close();
  }
});

test('fix-v2 B4: each task gets its own workspace folder; recreation keeps it', async () => {
  const { store, coworkStore, groupTaskStore, task } = await setup();
  try {
    const { resolveGroupTaskSessionWorkspace } = require('../dist-electron/main/services/groupTaskSession.js');
    const { session } = ensureGroupTaskSession(coworkStore, task, 2, 'Coder Bot');
    assert.ok(session.cwd.endsWith(`group-task-${task.id}`), `per-task folder, got ${session.cwd}`);

    // A second task for the same bot lands in a DIFFERENT folder — previous
    // episodes' files cannot leak into this task's context.
    const task2 = groupTaskStore.createTask({
      groupId: `${'cd'.repeat(32)}i0`,
      title: 'Second task',
      goal: 'Another goal',
      chairMetabotId: 1,
      createdBy: 'user',
    });
    const second = ensureGroupTaskSession(coworkStore, task2, 2, 'Coder Bot');
    assert.notEqual(second.session.cwd, session.cwd, 'distinct folders per task');
    assert.ok(second.session.cwd.endsWith(`group-task-${task2.id}`));

    // Same task, recreated session (mapping lost) → SAME folder, so mid-task
    // rebuilds keep their artifacts.
    const again = resolveGroupTaskSessionWorkspace('/tmp/base', `group-task:${task.id}`);
    assert.equal(again, `/tmp/base/group-task-${task.id}`);
    // Guest bindings sanitize the on-chain group id (no ':' in a folder name).
    const guest = resolveGroupTaskSessionWorkspace('/tmp/base', `openteam:${'ab'.repeat(32)}i0`);
    assert.ok(!guest.includes(':') && guest.includes('openteam-'));
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
