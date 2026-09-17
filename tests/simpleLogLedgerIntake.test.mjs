// SimpleLog → ledger intake (task #85): a REAL on-chain record's `deliverables`
// array (bare chain URIs) must reach the host ledger with no [DELIVERABLE] tag
// and no prose parsing — and must NOT be fooled by Markdown link dressing.
//
// The record below is the first SimpleLog entry published for THIS task
// (pin eedddc60614e4f8c7a2a551bf4b44bf829b923b6c719fd43234d90dc359fae2ci0,
// cast with the pilot CLI against the group task anchor b0eb2dd4…i0). The
// intake loop mirrors the daemon's per-candidate ledger path (valid candidates
// only, same-author/same-msg dedupe) — the extractor and the store are the
// real compiled modules, so the row this test reads back is the row the host
// ledger produces.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { GroupTaskStore } = require('../dist-electron/main/groupTaskStore.js');
const { parseSimpleLogDeliverables } = require('../dist-electron/main/services/groupTaskDeliverableParser.js');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-simplelog-intake-'));

const GROUP_ID = 'b0eb2dd4203bec74a641fa4b09f7370bf88504f83467f78ea5c40ff7aa1cd92di0';
const GMID_WORKER = 'idq1d5m392ahkhp79wsy9ur79e3vhak7tg729dwdr5';
const NOTE_PIN = 'eb7bd83c903313ebd27c79b1f5395cb2ca03ef05773141dea2f0bfaa22ec023ai0';
const PROTOCOL_PIN = 'e741dad270ce9bd4f8b638386fbe33c15fbc6db5006ca01f7a57dd443fe0178ci0';
const RECORD_PIN = 'eedddc60614e4f8c7a2a551bf4b44bf829b923b6c719fd43234d90dc359fae2ci0';

/** Verbatim on-chain content of the published record. */
const RECORD_CONTENT = JSON.stringify({
  v: 1,
  kind: 'status',
  summary: '第一棒完成：simplelog 写入工具与宿主台账提取器落地',
  taskid: GROUP_ID,
  step: '第一棒',
  status: 'executing',
  role: 'worker',
  deliverables: [`pin://${NOTE_PIN}`],
  refs: [`pin://${PROTOCOL_PIN}`],
});

const insertChatMessage = (db, { pinId, content, gmid = GMID_WORKER }) => {
  db.run(
    `INSERT INTO group_chat_messages (pin_id, group_id, sender_metaid, sender_global_metaid, sender_name, protocol, content)
     VALUES (?, ?, 'metabot-15', ?, 'Builder阿码', 'simplegroupchat', ?)`,
    [pinId, GROUP_ID, gmid, content],
  );
};

/** The daemon's per-candidate ledger path, over a stored message. */
const ingestSimpleLogRecord = (groupTaskStore, task, message) => {
  const rows = [];
  for (const candidate of parseSimpleLogDeliverables(message.content ?? '')) {
    if (!candidate.valid || !candidate.uri) continue;
    if (groupTaskStore.findDeliverableByMsgPinAndUri(task.id, message.pinId, candidate.uri, candidate.kind)) continue;
    if (
      message.senderGlobalMetaId
      && groupTaskStore.findDeliverableByAuthorAndUri(task.id, message.senderGlobalMetaId, candidate.uri)
    ) continue;
    rows.push(groupTaskStore.addDeliverable({
      taskId: task.id,
      msgPinId: message.pinId,
      authorGlobalmetaid: message.senderGlobalMetaId,
      kind: candidate.kind,
      uri: candidate.uri,
    }));
  }
  return rows;
};

test('a real SimpleLog record lands its bare URI array in the ledger (idempotently)', async () => {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  const groupTaskStore = new GroupTaskStore(db, store.getSaveFunction());
  try {
    const task = groupTaskStore.createTask({
      groupId: GROUP_ID,
      title: 'SimpleLog 协议配套',
      goal: '工具、查看页、复核、测试与生态公告',
      chairMetabotId: 1,
      createdBy: 'user',
      createPinId: GROUP_ID,
    });
    insertChatMessage(db, { pinId: RECORD_PIN, content: RECORD_CONTENT });
    const [message] = groupTaskStore.listGroupChatMessages(GROUP_ID);

    // The record is NOT a [DELIVERABLE] message: zero tag rows exist before.
    assert.equal(groupTaskStore.listGroupChatMessagesWithDeliverableTag(GROUP_ID).length, 0);

    const firstRun = ingestSimpleLogRecord(groupTaskStore, task, message);
    assert.equal(firstRun.length, 1);
    const rows = groupTaskStore.listDeliverables(task.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].uri, `pin://${NOTE_PIN}`);
    assert.equal(rows[0].kind, 'pinid');
    assert.equal(rows[0].msgPinId, RECORD_PIN);
    assert.equal(rows[0].authorGlobalmetaid, GMID_WORKER);

    // Replay-safe: the same record re-ingested folds into the existing row.
    assert.equal(ingestSimpleLogRecord(groupTaskStore, task, message).length, 0);
    assert.equal(groupTaskStore.listDeliverables(task.id).length, 1);
  } finally {
    db.close();
  }
});

test('Markdown-dressed URIs land clean; a broken target mints NO row', async () => {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  const groupTaskStore = new GroupTaskStore(db, store.getSaveFunction());
  try {
    const task = groupTaskStore.createTask({
      groupId: GROUP_ID,
      title: 'SimpleLog 协议配套',
      goal: 'g',
      chairMetabotId: 1,
      createdBy: 'user',
      createPinId: GROUP_ID,
    });

    // `[pin://X](pin://X)` — the MetaWeb habit — must reach the ledger bare.
    const dressedPin = `${'ab'.repeat(32)}i0`;
    insertChatMessage(db, {
      pinId: `${'11'.repeat(32)}i0`,
      content: JSON.stringify({
        v: 1,
        kind: 'review',
        summary: '包装 URIs 的合法记录',
        taskkey: 'local:184',
        deliverables: [`[pin://${dressedPin}](pin://${dressedPin})`],
      }),
    });
    // A truncated target behind a clean label must be rejected, not recorded.
    insertChatMessage(db, {
      pinId: `${'22'.repeat(32)}i0`,
      content: JSON.stringify({
        v: 1,
        kind: 'review',
        summary: '坏目标的记录',
        taskkey: 'local:184',
        deliverables: [`[pin://${dressedPin}](pin://${dressedPin.slice(0, 20)}…)`],
      }),
    });

    const messages = groupTaskStore.listGroupChatMessages(GROUP_ID);
    for (const message of messages) ingestSimpleLogRecord(groupTaskStore, task, message);
    const rows = groupTaskStore.listDeliverables(task.id);
    assert.equal(rows.length, 1, 'only the cleanly dressed URI becomes a row');
    assert.equal(rows[0].uri, `pin://${dressedPin}`);
  } finally {
    db.close();
  }
});
