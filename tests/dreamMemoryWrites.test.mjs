import test from 'node:test';
import assert from 'node:assert/strict';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const insertMetabot = (db, id, type = 'worker') => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key,
      chat_public_key, name, metaid, metabot_type, created_by, role, soul,
      created_at, updated_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'test', 'role', 'soul', 1, 1)`,
    [
      id,
      `mvc-${id}`,
      `btc-${id}`,
      `doge-${id}`,
      `pk-${id}`,
      `chatpk-${id}`,
      `bot-${id}`,
      `metaid-${id}`,
      type,
    ]
  );
};

test('memory origin defaults to conversation and accepts dream', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);

    const conversationEntry = store.createUserMemory({
      metabotId: 1,
      text: '用户喜欢简洁的回复',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
    });
    assert.equal(conversationEntry.origin, 'conversation');

    const dreamEntry = store.createUserMemory({
      metabotId: 1,
      text: '做梦时沉淀的重要事项',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      origin: 'dream',
    });
    assert.equal(dreamEntry.origin, 'dream');

    const dreamOnly = store.listUserMemories({
      metabotId: 1,
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      origin: 'dream',
    });
    assert.deepEqual(dreamOnly.map((entry) => entry.id), [dreamEntry.id]);
  } finally {
    cleanup();
  }
});

test('reviving an existing memory keeps its original origin', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);

    const original = store.createUserMemory({
      metabotId: 1,
      text: '用户偏好周五发布版本',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
    });
    // A dream write hitting the same fingerprint revives but must not rebrand origin.
    const revived = store.createUserMemory({
      metabotId: 1,
      text: '用户偏好周五发布版本',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      origin: 'dream',
    });
    assert.equal(revived.id, original.id);
    assert.equal(revived.origin, 'conversation');
  } finally {
    cleanup();
  }
});

test('listUserMemories filters by usageClass', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);

    store.createUserMemory({
      metabotId: 1,
      text: '普通事实记忆',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
    });
    const review = store.createUserMemory({
      metabotId: 1,
      text: '工作评价:为用户制作了演示视频,对方高度赞扬',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'work_review',
      origin: 'dream',
    });

    const reviews = store.listUserMemories({
      metabotId: 1,
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'work_review',
    });
    assert.deepEqual(reviews.map((entry) => entry.id), [review.id]);
    assert.equal(reviews[0].usageClass, 'work_review');
    assert.equal(reviews[0].origin, 'dream');
  } finally {
    cleanup();
  }
});

test('self_identity entries reject update and delete unless explicitly allowed', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);

    const identity = store.createUserMemory({
      metabotId: 1,
      text: '我是一个专注于视频创作的 MetaBot,做事先验证再交付……',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'self_identity',
      origin: 'dream',
    });
    assert.equal(identity.usageClass, 'self_identity');

    // Tool / IPC / implicit paths (no allowProtected) are refused.
    assert.equal(
      store.updateUserMemory({ id: identity.id, metabotId: 1, text: '试图改写我是谁' }),
      null
    );
    assert.equal(store.deleteUserMemory({ id: identity.id, metabotId: 1 }), false);
    assert.equal(store.deleteUserMemory(identity.id, 1), false);

    // The dream service carries the internal escape hatch.
    const updated = store.updateUserMemory({
      id: identity.id,
      metabotId: 1,
      text: '做梦服务合法更新的自我认知',
      allowProtected: true,
    });
    assert.equal(updated?.text, '做梦服务合法更新的自我认知');
    assert.equal(updated?.usageClass, 'self_identity');

    assert.equal(store.deleteUserMemory({ id: identity.id, metabotId: 1, allowProtected: true }), true);
  } finally {
    cleanup();
  }
});

test('dream_enabled policy defaults on and is settable per bot', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    insertMetabot(db, 7, 'worker');

    assert.equal(store.getEffectiveMemoryPolicyForMetabot(7).dreamEnabled, true);
    assert.equal(store.getEffectiveMemoryPolicyForMetabot(null).dreamEnabled, true);

    const updated = store.setMemoryPolicyForMetabot(7, { dreamEnabled: false });
    assert.equal(updated.dreamEnabled, false);
    assert.equal(store.getEffectiveMemoryPolicyForMetabot(7).dreamEnabled, false);

    const reenabled = store.setMemoryPolicyForMetabot(7, { dreamEnabled: true });
    assert.equal(reenabled.dreamEnabled, true);
  } finally {
    cleanup();
  }
});
