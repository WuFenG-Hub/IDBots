import test from 'node:test';
import assert from 'node:assert/strict';

import { getSqlJs } from './memoryTestUtils.mjs';

const { MetaIDExperienceStore, ensureMetaIDExperienceSchema } = await import('../dist-electron/main/metaidExperienceStore.js');
const { MetaIDImpressionStore, ensureMetaIDImpressionSchema } = await import('../dist-electron/main/metaidImpressionStore.js');
const { MetaIDContactViewService } = await import('../dist-electron/main/services/metaidContactViewService.js');

const OBSERVER = 'idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz'; // AI_Sunny
const SUBJECT = 'idq18x8zm89zrmdf5susdgxtyg4lraf2z5rdejd984'; // AI_小新
const OTHER = 'idq1d5m392ahkhp79wsy9ur79e3vhak7tg729dwdr5'; // Builder / 阿码

function createSchema(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS metabots (
      id INTEGER PRIMARY KEY,
      name TEXT,
      avatar TEXT,
      metabot_type TEXT,
      globalmetaid TEXT UNIQUE
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS cowork_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      cwd TEXT NOT NULL,
      metabot_id INTEGER,
      session_type TEXT NOT NULL DEFAULT 'standard',
      peer_global_metaid TEXT,
      peer_name TEXT,
      peer_avatar TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS private_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pin_id TEXT UNIQUE,
      tx_id TEXT,
      from_metaid TEXT NOT NULL,
      from_global_metaid TEXT,
      from_name TEXT,
      to_metaid TEXT NOT NULL,
      to_global_metaid TEXT,
      content TEXT,
      content_type TEXT,
      reply_pin TEXT,
      chain_timestamp INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS group_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pin_id TEXT UNIQUE,
      tx_id TEXT,
      reply_pin TEXT,
      mention TEXT,
      group_id TEXT NOT NULL,
      channel_id TEXT,
      sender_metaid TEXT NOT NULL,
      sender_global_metaid TEXT,
      sender_name TEXT,
      sender_avatar TEXT,
      content TEXT,
      chain_timestamp INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      msg_index INTEGER
    );
  `);
  ensureMetaIDExperienceSchema(db);
  ensureMetaIDImpressionSchema(db);
}

function makeService(db) {
  const experienceStore = new MetaIDExperienceStore(db, () => {});
  const impressionStore = new MetaIDImpressionStore(db, () => {});
  const service = new MetaIDContactViewService({ db, experienceStore, impressionStore });
  return { service, experienceStore, impressionStore };
}

async function seedPrivateChatEpisode(db, { store, pinId, messageId, content, fromName, occurredAt }) {
  db.run(`
    INSERT INTO private_chat_messages
      (pin_id, from_metaid, from_global_metaid, from_name, to_metaid, to_global_metaid, content, chain_timestamp)
    VALUES (?, 'local', ?, ?, 'local', ?, ?, ?)
  `, [pinId, SUBJECT, fromName, OBSERVER, content, occurredAt]);

  const episode = store.createEpisode({
    ownerGlobalMetaID: OBSERVER,
    episodeType: 'direct_interaction',
    sourceChannel: 'metaweb_private',
    sourceKey: `a2a:metaweb-private:${SUBJECT}`,
    startedAt: occurredAt,
  }).episode;
  store.addParticipant({ episodeId: episode.id, globalMetaID: SUBJECT, role: 'peer', source: 'test' });
  store.addEvidence({
    episodeId: episode.id,
    evidenceType: 'message',
    sourceKey: `message:${messageId}`,
    pinId,
    publisherGlobalMetaID: SUBJECT,
    messageId: String(messageId),
    occurredAt,
    metadata: { direction: 'incoming' },
  });
  return episode;
}

async function seedGroupTaskEpisode(db, { store, taskId, messageId, content, senderName, occurredAt }) {
  db.run(`
    INSERT INTO group_chat_messages
      (pin_id, group_id, sender_metaid, sender_global_metaid, sender_name, content, chain_timestamp)
    VALUES (?, 'group-1', 'local', ?, ?, ?, ?)
  `, [`pin-group-${messageId}`, SUBJECT, senderName, content, occurredAt]);

  const episode = store.createEpisode({
    ownerGlobalMetaID: OBSERVER,
    episodeType: 'task_participation',
    sourceChannel: 'group_task',
    sourceKey: `task:${taskId}`,
    taskId: String(taskId),
    startedAt: occurredAt,
  }).episode;
  store.addParticipant({ episodeId: episode.id, globalMetaID: SUBJECT, role: 'worker', source: 'test' });
  store.addEvidence({
    episodeId: episode.id,
    evidenceType: 'group_task_message',
    sourceKey: `message:${messageId}`,
    pinId: `pin-group-${messageId}`,
    publisherGlobalMetaID: SUBJECT,
    messageId: String(messageId),
    occurredAt,
    metadata: { taskId: String(taskId), groupId: 'group-1' },
  });
  return episode;
}

test('listContacts aggregates participants, excludes the observer, and resolves names', async () => {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  createSchema(db);
  db.run("INSERT INTO metabots (id, name, avatar, metabot_type, globalmetaid) VALUES (1, 'AI_Sunny', NULL, 'twin', ?)", [OBSERVER]);
  db.run("INSERT INTO metabots (id, name, avatar, metabot_type, globalmetaid) VALUES (2, 'AI_小新', NULL, 'worker', ?)", [SUBJECT]);
  db.run("INSERT INTO metabots (id, name, avatar, metabot_type, globalmetaid) VALUES (3, 'Builder / 阿码', NULL, 'worker', ?)", [OTHER]);
  const { service, experienceStore } = makeService(db);

  // One private episode with AI_小新 and one with Builder/阿码 (local bot name fallback).
  await seedPrivateChatEpisode(db, {
    store: experienceStore, pinId: 'pin-1', messageId: 1, content: 'hi', fromName: 'AI_小新', occurredAt: 1000,
  });
  const otherEpisode = experienceStore.createEpisode({
    ownerGlobalMetaID: OBSERVER,
    episodeType: 'direct_interaction',
    sourceChannel: 'metaweb_private',
    sourceKey: `a2a:metaweb-private:${OTHER}`,
    startedAt: 2000,
  }).episode;
  experienceStore.addParticipant({ episodeId: otherEpisode.id, globalMetaID: OTHER, role: 'peer', source: 'test' });

  const contacts = service.listContacts(OBSERVER);
  assert.equal(contacts.length, 2);

  const xiaoxin = contacts.find((c) => c.globalMetaID === SUBJECT);
  assert.equal(xiaoxin.name, 'AI_小新');
  assert.equal(xiaoxin.interactionCount, 1);
  assert.equal(xiaoxin.directInteractionCount, 1);

  const builder = contacts.find((c) => c.globalMetaID === OTHER);
  assert.equal(builder.name, 'Builder / 阿码');
});

test('listContacts falls back to peer_name then group sender_name when not a local bot', async () => {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  createSchema(db);
  const { service, experienceStore } = makeService(db);

  // Subject is NOT a local bot; peer_name present in cowork_sessions.
  db.run(`
    INSERT INTO cowork_sessions
      (id, title, status, cwd, metabot_id, session_type, peer_global_metaid, peer_name, created_at, updated_at)
    VALUES ('s-1', 'chat', 'idle', '/tmp', 1, 'a2a', ?, 'Peer From Session', 1, 2)
  `, [SUBJECT]);
  await seedPrivateChatEpisode(db, {
    store: experienceStore, pinId: 'pin-2', messageId: 2, content: 'hi', fromName: 'ignored', occurredAt: 1000,
  });

  const contacts = service.listContacts(OBSERVER);
  const subject = contacts.find((c) => c.globalMetaID === SUBJECT);
  assert.equal(subject.name, 'Peer From Session');

  // Remove the session so the group sender_name fallback kicks in.
  db.run('DELETE FROM cowork_sessions WHERE id = ?', ['s-1']);
  await seedGroupTaskEpisode(db, {
    store: experienceStore, taskId: 9, messageId: 99, content: 'group msg', senderName: '群任务名字', occurredAt: 1500,
  });
  const contactsAfter = service.listContacts(OBSERVER);
  const subjectAfter = contactsAfter.find((c) => c.globalMetaID === SUBJECT);
  assert.equal(subjectAfter.name, '群任务名字');
});

test('getContactDetail returns snapshot, observations and episodes with evidence text joined by message_id', async () => {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  createSchema(db);
  db.run("INSERT INTO metabots (id, name, avatar, metabot_type, globalmetaid) VALUES (2, 'AI_小新', NULL, 'worker', ?)", [SUBJECT]);
  const { service, experienceStore, impressionStore } = makeService(db);

  const occurredAt = 1000;
  const episode = await seedPrivateChatEpisode(db, {
    store: experienceStore, pinId: 'pin-3', messageId: 10, content: '这是私聊消息原文', fromName: 'AI_小新', occurredAt,
  });
  const evidence = experienceStore.listEvidence(episode.id)[0];

  const observation = impressionStore.appendObservation({
    observerGlobalMetaID: OBSERVER,
    subjectGlobalMetaID: SUBJECT,
    evidenceIds: [evidence.id],
    observationText: 'Observed behavior text',
    interpretationText: '协作总体可靠',
    dimensions: { styleDescriptors: ['严谨'], cooperation: '可靠' },
    communicationGuidance: '提供完整路径',
    confidence: { level: 'medium', uncertainty: '待观察' },
    dreamDate: '2026-08-08',
    dreamVersion: 4,
    sourceHash: 'a'.repeat(64),
    idempotencyKey: 'key-1',
  }).observation;
  assert.equal(impressionStore.rebuildSnapshot(OBSERVER, SUBJECT)?.summaryText, '协作总体可靠');

  const detail = service.getContactDetail(OBSERVER, SUBJECT);
  assert.equal(detail.subjectName, 'AI_小新');
  assert.equal(detail.snapshot.summaryText, '协作总体可靠');
  assert.equal(detail.snapshot.styleDescriptors[0], '严谨');
  assert.equal(detail.observations.length, 1);
  assert.equal(detail.observations[0].id, observation.id);

  assert.equal(detail.episodes.length, 1);
  const episodeView = detail.episodes[0];
  assert.equal(episodeView.episode.episodeType, 'direct_interaction');
  assert.equal(episodeView.evidence.length, 1);
  assert.equal(episodeView.evidenceTexts[0].content, '这是私聊消息原文');
  assert.equal(episodeView.evidenceTexts[0].direction, 'incoming');
  assert.equal(episodeView.evidenceTexts[0].pinId, 'pin-3');
});

test('getContactDetail joins group task text and treats orders as metadata-only', async () => {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  createSchema(db);
  const { service, experienceStore } = makeService(db);

  await seedGroupTaskEpisode(db, {
    store: experienceStore, taskId: 7, messageId: 57, content: '群任务交付消息原文', senderName: 'AI_小新', occurredAt: 3000,
  });

  const orderEpisode = experienceStore.createEpisode({
    ownerGlobalMetaID: OBSERVER,
    episodeType: 'service_order',
    sourceChannel: 'service_order',
    sourceKey: `order:order-1`,
    orderId: 'order-1',
    status: 'completed',
    startedAt: 4000,
    endedAt: 5000,
  }).episode;
  experienceStore.addParticipant({ episodeId: orderEpisode.id, globalMetaID: SUBJECT, role: 'buyer', source: 'test' });
  experienceStore.addEvidence({
    episodeId: orderEpisode.id,
    evidenceType: 'service_order_event',
    sourceKey: 'event:created',
    occurredAt: 4000,
    metadata: { event: 'created', role: 'buyer' },
  });

  const detail = service.getContactDetail(OBSERVER, SUBJECT);
  assert.equal(detail.episodes.length, 2);

  const groupView = detail.episodes.find((v) => v.episode.sourceChannel === 'group_task');
  assert.equal(groupView.evidenceTexts[0].content, '群任务交付消息原文');
  assert.equal(groupView.evidenceTexts[0].senderName, 'AI_小新');

  const orderView = detail.episodes.find((v) => v.episode.sourceChannel === 'service_order');
  assert.equal(orderView.evidenceTexts[0].content, null);
  assert.equal(orderView.episode.status, 'completed');
});

test('getContactDetail falls back to pin_id when message_id is missing', async () => {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  createSchema(db);
  const { service, experienceStore } = makeService(db);

  db.run(`
    INSERT INTO private_chat_messages
      (pin_id, from_metaid, from_global_metaid, from_name, to_metaid, to_global_metaid, content, chain_timestamp)
    VALUES ('pin-orphan', 'local', ?, 'AI_小新', 'local', ?, '靠 pin 找回的消息', 6000)
  `, [SUBJECT, OBSERVER]);

  const episode = experienceStore.createEpisode({
    ownerGlobalMetaID: OBSERVER,
    episodeType: 'direct_interaction',
    sourceChannel: 'metaweb_private',
    sourceKey: 'a2a:metaweb-private:orphan',
    startedAt: 6000,
  }).episode;
  experienceStore.addParticipant({ episodeId: episode.id, globalMetaID: SUBJECT, role: 'peer', source: 'test' });
  // No message_id — only the pin_id links back to the local message row.
  experienceStore.addEvidence({
    episodeId: episode.id,
    evidenceType: 'message',
    sourceKey: 'message:orphan',
    pinId: 'pin-orphan',
    publisherGlobalMetaID: SUBJECT,
    messageId: null,
    occurredAt: 6000,
  });

  const detail = service.getContactDetail(OBSERVER, SUBJECT);
  assert.equal(detail.episodes.length, 1);
  assert.equal(detail.episodes[0].evidenceTexts[0].content, '靠 pin 找回的消息');
});

test('listContacts ranks by latest evidence, not episode start', async () => {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  createSchema(db);
  const { service, experienceStore } = makeService(db);

  await seedPrivateChatEpisode(db, {
    store: experienceStore, pinId: 'pin-old', messageId: 1, content: 'old', fromName: 'Old Peer', occurredAt: 1_000,
  });
  const recent = experienceStore.createEpisode({
    ownerGlobalMetaID: OBSERVER,
    episodeType: 'direct_interaction',
    sourceChannel: 'metaweb_private',
    sourceKey: `a2a:metaweb-private:${OTHER}`,
    startedAt: 500,
  }).episode;
  experienceStore.addParticipant({ episodeId: recent.id, globalMetaID: OTHER, role: 'peer', source: 'test' });
  experienceStore.addEvidence({
    episodeId: recent.id,
    evidenceType: 'message',
    sourceKey: 'message:recent',
    publisherGlobalMetaID: OTHER,
    occurredAt: 9_000,
  });

  const contacts = service.listContacts(OBSERVER);
  assert.deepEqual(contacts.map((contact) => contact.globalMetaID), [OTHER, SUBJECT]);
  assert.equal(contacts[0].lastSeenAt, 9_000);
});

test('getContactDetail rejects self-impressions', async () => {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  createSchema(db);
  const { service } = makeService(db);

  assert.throws(() => service.getContactDetail(OBSERVER, OBSERVER), /Self impressions/);
});
