// One-time deliverable ledger repair (task #62 regression): the line-scoped
// [DELIVERABLE] parser dropped URIs delivered in the "description line + blank
// line + URI line" shape. The backfill re-parses every task's chat history
// with the fixed parser and inserts the missing on-chain rows — additive only,
// idempotent via the store's (msgPin,uri)/(author,uri) dedupe.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { GroupTaskStore } = require('../dist-electron/main/groupTaskStore.js');
const { backfillMultiLineDeliverables } = require('../dist-electron/main/services/groupTaskDeliverableBackfill.js');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-gt-deliverable-backfill-'));

const GROUP_ID = '4ea201ef85dcdebc8d5531f329753dab68bd71bf9f5369cf6daf1e60d4f86bbbi0';
const GMID_BUILDER = 'gmid-builder-0001';
const GMID_CHAIR = 'gmid-chair-0002';
const SHA256_A = 'e8b56972b85a7d4afa725eadc78ca82131655ddbafe79d6b39643878296ba7d2';

const openStores = async (tempDir) => {
  const store = await SqliteStore.create(tempDir);
  const groupTaskStore = new GroupTaskStore(store.getDatabase(), store.getSaveFunction());
  return { groupTaskStore, db: store.getDatabase() };
};

const insertChatMessage = (db, { pinId, content, gmid = GMID_BUILDER }) => {
  db.run(
    `INSERT INTO group_chat_messages (pin_id, group_id, sender_metaid, sender_global_metaid, sender_name, protocol, content)
     VALUES (?, ?, 'metabot-1', ?, 'Builder阿码', 'simplegroupchat', ?)`,
    [pinId, GROUP_ID, gmid, content],
  );
};

test('backfill inserts the missing multi-line URI rows as delivered and is idempotent', async () => {
  const tempDir = makeTempDir();
  const { groupTaskStore, db } = await openStores(tempDir);
  try {
    const task = groupTaskStore.createTask({
      groupId: GROUP_ID,
      title: 'Task 62',
      goal: 'Skill intro MetaApp',
      chairMetabotId: 1,
      createdBy: 'user',
      createPinId: 'create-pin-62',
    });

    // The historical record: two same-line pins (already recorded by the
    // daemon at the time) + one multi-line message whose three URIs were
    // dropped + one prose mention of the tag (text, no row expected).
    const msgMaterial = '542adae7d73d2a5895ac6307ac40853fa65a84194fb02d041260e2089c548d69i0';
    const msgBuzz = '54088fe1beb80ee2b54b84d1c1a4e72a6e648cba38b140b7dc09dff4ec1bb611i0';
    const msgBuilder = 'c48d2eb6e541abfcde8124a7a4b1b3ee883bdccce9da097afea206940566fe82i0';
    const msgProse = '7028db9f7c05d9d83bc06b0443ad6266ae50f2f2fb8834fb2ca7fbd01b7e96a7i0';
    insertChatMessage(db, {
      pinId: msgMaterial,
      gmid: GMID_CHAIR,
      content: '[DELIVERABLE] S1 内容素材包（simplenote，四块齐全）：pin://5345dcdcd40ca628113de5ed18087df16667021d5246437d4f927e4c17c72525i0',
    });
    insertChatMessage(db, {
      pinId: msgBuzz,
      gmid: GMID_CHAIR,
      content: '[DELIVERABLE] S4 buzz 已发布上链：pin://ed64f554ecb95e22a267a6314bd30ca3c0bac33f389e746ad5cbe04ceeda033ci0',
    });
    groupTaskStore.addDeliverable({
      taskId: task.id,
      msgPinId: msgMaterial,
      authorGlobalmetaid: GMID_CHAIR,
      kind: 'pinid',
      uri: 'pin://5345dcdcd40ca628113de5ed18087df16667021d5246437d4f927e4c17c72525i0',
    });
    groupTaskStore.addDeliverable({
      taskId: task.id,
      msgPinId: msgBuzz,
      authorGlobalmetaid: GMID_CHAIR,
      kind: 'pinid',
      uri: 'pin://ed64f554ecb95e22a267a6314bd30ca3c0bac33f389e746ad5cbe04ceeda033ci0',
    });
    insertChatMessage(db, {
      pinId: msgBuilder,
      content: [
        '[DELIVERABLE] metabot-skill 技能封装（vhs v1.0.0，sha256 e8b5…）：',
        '',
        'pin://4c04e5ee4afca2c91cb4a21d58d609b58912c653f74d462b31ede7558c5aa3dai0',
        '',
        '[DELIVERABLE] 技能包 zip（skill-file，公网 HTTP 200 实测）：',
        '',
        'metafile://70cc6df2433ba85898578e7ee8ba9cb7bfa94b17eefe945d14168b33c4aa7a2ai0.zip',
        '',
        '[DELIVERABLE] MetaApp 上链（v1.0.0，7 项质量门自检全过）：',
        '',
        'metaapp://020098ee0678125af7c2a1222b25d54699b3d52861249f11ff211612b691a8c9i0',
      ].join('\n'),
    });
    insertChatMessage(db, {
      pinId: msgProse,
      gmid: GMID_BUILDER,
      content: '状态澄清，非误期：前置条件未落地，故此时不可能有 [DELIVERABLE]。',
    });

    const first = backfillMultiLineDeliverables(groupTaskStore);
    assert.equal(first.inserted, 3, JSON.stringify(first));

    const rows = groupTaskStore.listDeliverables(task.id);
    const recovered = rows.filter((row) => row.msgPinId === msgBuilder);
    assert.equal(recovered.length, 3);
    const byUri = new Map(recovered.map((row) => [row.uri, row]));
    const skill = byUri.get('pin://4c04e5ee4afca2c91cb4a21d58d609b58912c653f74d462b31ede7558c5aa3dai0');
    const zip = byUri.get('metafile://70cc6df2433ba85898578e7ee8ba9cb7bfa94b17eefe945d14168b33c4aa7a2ai0.zip');
    const app = byUri.get('metaapp://020098ee0678125af7c2a1222b25d54699b3d52861249f11ff211612b691a8c9i0');
    assert.ok(skill && zip && app);
    assert.equal(skill.kind, 'pinid');
    assert.equal(zip.kind, 'metafile');
    assert.equal(app.kind, 'metaapp');
    for (const row of recovered) {
      assert.equal(row.status, 'delivered', 'backfilled rows read as delivered');
      assert.equal(row.confirmation, 'unconfirmed', 'honest: not re-verified');
      assert.equal(row.authorGlobalmetaid, GMID_BUILDER);
    }
    // Pre-existing rows untouched.
    assert.equal(rows.filter((row) => row.msgPinId === msgMaterial).length, 1);
    assert.equal(rows.filter((row) => row.msgPinId === msgBuzz).length, 1);

    // Second run is a no-op (idempotent).
    const second = backfillMultiLineDeliverables(groupTaskStore);
    assert.equal(second.inserted, 0, JSON.stringify(second));
    assert.equal(groupTaskStore.listDeliverables(task.id).length, rows.length);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
