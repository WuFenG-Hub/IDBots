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
const {
  decideOpenTeamGuestResponse,
  isOpenTeamProtocolOnlyContent,
} = require('../dist-electron/main/services/openTeamGuestDaemon.js');
const { buildOpenTeamGuestPrompt } = require('../dist-electron/main/services/openTeamGuestPrompt.js');

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

// ---------------------------------------------------------------------------
// R2: chat-mode guest gating (decideOpenTeamGuestResponse)
// ---------------------------------------------------------------------------

const GUEST_GMID = 'idqguest';
const CHAIR_GMID = 'idqchair';
const OTHER_GMID = 'idqother';
const gateBot = () => ({ name: 'Guest Bot', globalmetaid: GUEST_GMID, metaid: 'metaid-guest' });
const gateMessage = (overrides = {}) => ({
  id: 1,
  pinId: null,
  senderMetaId: 'metaid-x',
  senderGlobalMetaId: CHAIR_GMID,
  senderName: 'Chair',
  content: 'hello there',
  mention: null,
  ...overrides,
});
const gateInput = (overrides = {}) => ({
  lastReplyAt: 0,
  now: 100_000,
  cooldownMs: 20_000,
  ...overrides,
});

test('task mode keeps the strict mention gate (regression)', () => {
  const bot = gateBot();
  const decision = decideOpenTeamGuestResponse({
    ...gateInput(),
    mode: 'task',
    inviterGlobalMetaId: CHAIR_GMID,
    message: gateMessage({ content: 'welcome to the group, make yourself at home', senderGlobalMetaId: CHAIR_GMID }),
    bot,
  });
  assert.equal(decision.respond, false);
  assert.equal(decision.reason, 'not_mentioned');
});

test('chat mode answers a no-@ conversational message from the chair (P1 incident replay)', () => {
  const bot = gateBot();
  const decision = decideOpenTeamGuestResponse({
    ...gateInput(),
    mode: 'chat',
    inviterGlobalMetaId: CHAIR_GMID,
    message: gateMessage({ content: 'welcome to the group, make yourself at home' }),
    bot,
  });
  assert.equal(decision.respond, true);
  assert.equal(decision.reason, 'chat_direct');
});

test('chat mode still answers @mentions with reason=mentioned', () => {
  const bot = gateBot();
  const decision = decideOpenTeamGuestResponse({
    ...gateInput(),
    mode: 'chat',
    inviterGlobalMetaId: CHAIR_GMID,
    message: gateMessage({ content: 'hey @Guest Bot, what do you think?' }),
    bot,
  });
  assert.equal(decision.respond, true);
  assert.equal(decision.reason, 'mentioned');
});

test('chat mode: non-@ messages from other members stay gated (storm insurance)', () => {
  const bot = gateBot();
  const decision = decideOpenTeamGuestResponse({
    ...gateInput(),
    mode: 'chat',
    inviterGlobalMetaId: CHAIR_GMID,
    message: gateMessage({ content: 'anyone want coffee?', senderGlobalMetaId: OTHER_GMID, senderName: 'Other' }),
    bot,
  });
  assert.equal(decision.respond, false);
  assert.equal(decision.reason, 'not_mentioned');
});

test('chat mode: protocol-only lines never wake the guest, even with an @', () => {
  const bot = gateBot();
  const decision = decideOpenTeamGuestResponse({
    ...gateInput(),
    mode: 'chat',
    inviterGlobalMetaId: CHAIR_GMID,
    message: gateMessage({ content: '[STATUS:DONE]\n[DELIVERABLE] note: pin://' + 'a'.repeat(64) + 'i0' }),
    bot,
  });
  assert.equal(decision.respond, false);
  assert.equal(decision.reason, 'protocol_line');
});

test('chat mode: mixed prose + status tag from the chair stays conversational', () => {
  const bot = gateBot();
  const decision = decideOpenTeamGuestResponse({
    ...gateInput(),
    mode: 'chat',
    inviterGlobalMetaId: CHAIR_GMID,
    message: gateMessage({ content: 'Great talking with you all — closing the room now.\n[STATUS:DONE]' }),
    bot,
  });
  assert.equal(decision.respond, true);
  assert.equal(decision.reason, 'chat_direct');
});

test('self messages and empty content stay filtered in chat mode', () => {
  const bot = gateBot();
  assert.equal(
    decideOpenTeamGuestResponse({
      ...gateInput(),
      mode: 'chat',
      inviterGlobalMetaId: CHAIR_GMID,
      message: gateMessage({ content: 'my own echo', senderGlobalMetaId: GUEST_GMID }),
      bot,
    }).reason,
    'self_message',
  );
  assert.equal(
    decideOpenTeamGuestResponse({
      ...gateInput(),
      mode: 'chat',
      inviterGlobalMetaId: CHAIR_GMID,
      message: gateMessage({ content: '   ' }),
      bot,
    }).reason,
    'empty_content',
  );
});

test('chat mode cooldown still gates direct messages (loop insurance)', () => {
  const bot = gateBot();
  const decision = decideOpenTeamGuestResponse({
    lastReplyAt: 90_000,
    now: 100_000,
    cooldownMs: 20_000,
    mode: 'chat',
    inviterGlobalMetaId: CHAIR_GMID,
    message: gateMessage({ content: 'still there?' }),
    bot,
  });
  assert.equal(decision.respond, false);
  assert.equal(decision.reason, 'cooldown');
});

test('isOpenTeamProtocolOnlyContent: tag-structural only', () => {
  assert.equal(isOpenTeamProtocolOnlyContent('[STATUS:EXECUTING]'), true);
  assert.equal(isOpenTeamProtocolOnlyContent('[STATUS:DONE]\n[NO_REPLY]'), true);
  // A line LED BY a protocol tag is protocol traffic even with a prose tail —
  // host notices are never conversational, whatever rides after the tag.
  assert.equal(isOpenTeamProtocolOnlyContent('[GROUP_TASK_NOTICE:welcome] hi'), true, 'notice-led line');
  assert.equal(isOpenTeamProtocolOnlyContent('Great chat — closing.\n[STATUS:DONE]'), false, 'mixed prose');
  assert.equal(isOpenTeamProtocolOnlyContent(''), false);
  assert.equal(isOpenTeamProtocolOnlyContent('[OPENTEAM_KICK] {"v":1}'), true);
});

// ---------------------------------------------------------------------------
// R3: chat-mode guest prompt (task playbook byte-identical regression)
// ---------------------------------------------------------------------------

const promptMetabot = { name: 'Guest Bot', role: 'pal', soul: 'curious', goal: '', bio: '' };
const promptMembershipBase = {
  groupId: 'c'.repeat(64) + 'i0',
  taskTitle: 'zero-preset collision',
  inviterGlobalmetaid: CHAIR_GMID,
};

test('task-mode guest prompt is byte-identical to the legacy prompt', () => {
  const legacy = buildOpenTeamGuestPrompt({
    metabot: promptMetabot,
    membership: { ...promptMembershipBase },
  });
  const taskMode = buildOpenTeamGuestPrompt({
    metabot: promptMetabot,
    membership: { ...promptMembershipBase, groupMode: 'task' },
  });
  assert.equal(taskMode, legacy);
});

test('chat-mode guest prompt drops the task-discipline lines', () => {
  const chat = buildOpenTeamGuestPrompt({
    metabot: promptMetabot,
    membership: { ...promptMembershipBase, groupMode: 'chat' },
  });
  assert.ok(!chat.includes('Respond ONLY when @-mentioned'), 'no silence gate line');
  assert.ok(!chat.includes('no small talk'), 'no small-talk ban');
  assert.ok(!chat.includes('#13 handshake'), 'no mandatory handshake');
  assert.ok(!chat.includes('[DELIVERABLE]'), 'no deliverable discipline');
  assert.ok(!chat.includes('stay on the task goal'), 'no task-goal tether');
  // Mode-neutral etiquette survives.
  assert.ok(chat.includes('NEVER disclose'), 'privacy rule kept');
  assert.ok(chat.includes('NEVER fabricate'), 'honesty rule kept');
  assert.ok(chat.includes('ONE VOICE PER TURN'), 'one-voice rule present');
  assert.ok(chat.includes('group CHAT'), 'chat framing present');
});

test('chat-mode prompt keeps the persona block intact', () => {
  const chat = buildOpenTeamGuestPrompt({
    metabot: promptMetabot,
    membership: { ...promptMembershipBase, groupMode: 'chat' },
  });
  assert.ok(chat.includes('You are Guest Bot'), 'persona block present');
});
