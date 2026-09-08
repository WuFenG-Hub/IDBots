import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { GroupTaskStore } = require('../dist-electron/main/groupTaskStore.js');
const { OpenTeamMembershipStore } = require('../dist-electron/main/openTeamMembershipStore.js');
const {
  buildOpenTeamInviteMessage,
  parseOpenTeamEnvelope,
} = require('../dist-electron/main/services/openTeamProtocols.js');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-group-task-mode-'));

const openStores = async (tempDir) => {
  const store = await SqliteStore.create(tempDir);
  const groupTaskStore = new GroupTaskStore(store.getDatabase(), store.getSaveFunction());
  const membershipStore = new OpenTeamMembershipStore(
    store.getDatabase(),
    store.getSaveFunction(),
  );
  return { store, groupTaskStore, membershipStore, db: store.getDatabase() };
};

const baseTaskInput = (overrides = {}) => ({
  groupId: `group-${Math.random().toString(16).slice(2)}`,
  title: 'Mode test task',
  goal: 'verify the mode column',
  chairMetabotId: 1,
  createdBy: 'user',
  ...overrides,
});

// ---------------------------------------------------------------------------
// R1: group_tasks.mode — storage, defaults, chat-born-executing
// ---------------------------------------------------------------------------

test('group_tasks.mode column exists and defaults to task', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore } = await openStores(tempDir);
  try {
    const task = groupTaskStore.createTask(baseTaskInput());
    assert.equal(task.mode, 'task', 'absent mode normalizes to task');
    const reread = groupTaskStore.getTaskById(task.id);
    assert.equal(reread.mode, 'task');
  } finally {
    store.close();
  }
});

test('chat-mode tasks persist mode=chat and are born executing', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore } = await openStores(tempDir);
  try {
    const task = groupTaskStore.createTask(baseTaskInput({ mode: 'chat' }));
    assert.equal(task.mode, 'chat');
    assert.equal(task.status, 'executing', 'a conversation has no planning phase');
    const reread = groupTaskStore.getTaskById(task.id);
    assert.equal(reread.mode, 'chat');
    assert.equal(reread.status, 'executing');
  } finally {
    store.close();
  }
});

test('task-mode tasks keep the planning birth status (regression)', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore } = await openStores(tempDir);
  try {
    const task = groupTaskStore.createTask(baseTaskInput({ mode: 'task' }));
    assert.equal(task.status, 'planning');
    assert.equal(task.mode, 'task');
  } finally {
    store.close();
  }
});

test('unknown mode values are rejected by the column CHECK and normalize to task', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore, db } = await openStores(tempDir);
  try {
    const task = groupTaskStore.createTask(baseTaskInput());
    // The column CHECK is the durable guard: garbage cannot land at all.
    assert.throws(
      () => db.run('UPDATE group_tasks SET mode = ? WHERE id = ?', ['bogus', task.id]),
      /constraint/i,
    );
    const reread = groupTaskStore.getTaskById(task.id);
    assert.equal(reread.mode, 'task');
    // The pure normalizer covers wire/legacy inputs (envelope fields, JS calls).
    const { normalizeGroupTaskMode } = require('../dist-electron/main/libs/groupTaskMode.js');
    assert.equal(normalizeGroupTaskMode('chat'), 'chat');
    assert.equal(normalizeGroupTaskMode('task'), 'task');
    assert.equal(normalizeGroupTaskMode('bogus'), 'task');
    assert.equal(normalizeGroupTaskMode(undefined), 'task');
    assert.equal(normalizeGroupTaskMode(null), 'task');
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// R1: invite envelope carries the mode; absent field reads as task
// ---------------------------------------------------------------------------

const INVITE_BASE = {
  v: 1,
  inviteId: 'a'.repeat(64) + 'i0',
  groupId: 'b'.repeat(64) + 'i0',
  taskTitle: 'chat scene',
  goalSummary: 'free talk',
  requiredSkills: [],
  inviterGlobalMetaId: 'idqinviter',
  inviterName: 'Inviter',
  chairGlobalMetaId: 'idqinviter',
  targetGlobalMetaId: 'idqtarget',
  expiresAt: 4_102_444_800,
};

test('invite envelope round-trips mode=chat', () => {
  const envelope = parseOpenTeamEnvelope(buildOpenTeamInviteMessage({ ...INVITE_BASE, mode: 'chat' }));
  assert.equal(envelope?.kind, 'invite');
  assert.equal(envelope.invite.mode, 'chat');
});

test('invite envelope without mode omits the field (backward compatible)', () => {
  const legacy = parseOpenTeamEnvelope(buildOpenTeamInviteMessage({ ...INVITE_BASE }));
  assert.equal(legacy?.kind, 'invite');
  // The field is only carried when stated — a parsed legacy envelope stays
  // byte-identical to pre-mode parsers; consumers normalize undefined -> task.
  assert.equal(legacy.invite.mode, undefined);
  // Hand-written v1 envelope from an older inviter host (field entirely absent).
  const raw = parseOpenTeamEnvelope(
    `[OPENTEAM_INVITE] ${JSON.stringify({ ...INVITE_BASE, mode: undefined })}`,
  );
  assert.equal(raw?.kind, 'invite');
  assert.equal(raw.invite.mode, undefined);
});

test('invite envelope with a garbage mode omits the field', () => {
  const garbage = parseOpenTeamEnvelope(`[OPENTEAM_INVITE] ${JSON.stringify({ ...INVITE_BASE, mode: 'party' })}`);
  assert.equal(garbage?.kind, 'invite');
  assert.equal(garbage.invite.mode, undefined);
});

// ---------------------------------------------------------------------------
// R1: openteam_memberships.group_mode — persisted on accept, refreshed on revival
// ---------------------------------------------------------------------------

test('membership upsert persists groupMode and revivals keep it', async () => {
  const tempDir = makeTempDir();
  const { store, membershipStore } = await openStores(tempDir);
  try {
    const membership = membershipStore.upsertActiveMembership({
      groupId: 'g'.repeat(64) + 'i0',
      metabotId: 7,
      globalmetaid: 'idqguest',
      inviterGlobalmetaid: 'idqinviter',
      taskTitle: 'chat scene',
      groupMode: 'chat',
    });
    assert.equal(membership.groupMode, 'chat');

    // Left + re-invite (revival): an upsert without an explicit mode keeps the
    // stored chat mode (COALESCE), matching the task-title semantics.
    membershipStore.markLeft('g'.repeat(64) + 'i0', 7, { cause: 'kick' });
    const revived = membershipStore.upsertActiveMembership({
      groupId: 'g'.repeat(64) + 'i0',
      metabotId: 7,
    });
    assert.equal(revived.groupMode, 'chat');
    assert.equal(revived.status, 'active');
  } finally {
    store.close();
  }
});

test('membership without groupMode reads as task (legacy rows)', async () => {
  const tempDir = makeTempDir();
  const { store, membershipStore } = await openStores(tempDir);
  try {
    const membership = membershipStore.upsertActiveMembership({
      groupId: 'h'.repeat(64) + 'i0',
      metabotId: 8,
    });
    assert.equal(membership.groupMode, 'task');
  } finally {
    store.close();
  }
});
