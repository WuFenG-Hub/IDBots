import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

// Some transitive imports of privateChatDaemon may pull electron; mock it like
// the privateChatOpenTeamInterception tests do.
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
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');
const {
  buildOpenTeamInviteDisplayText,
  recordOpenTeamInviteA2ADisplay,
} = require('../dist-electron/main/services/privateChatDaemon.js');

Module._load = originalLoad;

const TXID = 'a'.repeat(64);
const INVITE_ID = `${TXID}i0`;
const INVITE_ID_2 = `${'f'.repeat(64)}i0`;
const GROUP_ID = `${'b'.repeat(64)}i0`;
const INVITER_GMID = 'idq1inviterabcdef1234567890abcdef1234567890';
const GUEST_GMID = 'idq1guestabcdef1234567890abcdef1234567890';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-openteam-a2a-display-'));

const insertWallet = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at) VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id]
  );
};

const insertMetabot = (db, { id, name, globalmetaid }) => {
  insertWallet(db, id);
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
      boss_global_metaid, llm_id, allow_chat_skills, bio, goal, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, id, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `public-${id}`, `chat-public-${id}`,
      name, 1, `metaid-${id}`, globalmetaid, 'worker', '0000', `${name} role`, `${name} soul`,
      null, null, '[]', null, null, 1700000000000 + id, 1700000000000 + id,
    ]
  );
};

const invitePayload = (overrides = {}) => ({
  v: 1,
  inviteId: INVITE_ID,
  groupId: GROUP_ID,
  taskTitle: 'External Task',
  goalSummary: 'help with a remote collaboration',
  requiredSkills: ['tarot', 'fortune'],
  inviterGlobalMetaId: INVITER_GMID,
  inviterName: 'Twin Bot',
  chairGlobalMetaId: INVITER_GMID,
  targetGlobalMetaId: GUEST_GMID,
  expiresAt: Math.floor(Date.now() / 1000) + 600,
  ...overrides,
});

const guestBot = { id: 7, name: 'Guest Bot', globalmetaid: GUEST_GMID };

const createCoworkStore = async () => {
  const store = await SqliteStore.create(makeTempDir());
  const db = store.getDatabase();
  insertMetabot(db, guestBot);
  return new CoworkStore(db, () => {});
};

// ---------------------------------------------------------------------------
// Display text
// ---------------------------------------------------------------------------

test('buildOpenTeamInviteDisplayText carries name/id/inviter/time/intent', () => {
  const text = buildOpenTeamInviteDisplayText(invitePayload(), 'Guest Bot');
  assert.ok(text.includes('invites Guest Bot to join the group task'), 'explicit join-intent');
  assert.ok(text.includes('External Task'), 'group task title');
  assert.ok(text.includes(GROUP_ID), 'group task identifier');
  assert.ok(text.includes('Twin Bot'), 'inviting bot name');
  assert.ok(text.includes(INVITER_GMID), 'inviting bot globalMetaId');
  assert.ok(text.includes(INVITE_ID), 'invite id');
  assert.ok(text.includes('Expires:'), 'expiry time visible');
  assert.ok(text.includes('Required skills: tarot, fortune'), 'required skills');
  assert.ok(text.includes('help with a remote collaboration'), 'goal summary');
});

test('buildOpenTeamInviteDisplayText falls back to groupId for an untitled task', () => {
  const text = buildOpenTeamInviteDisplayText(
    invitePayload({ taskTitle: '   ' }),
    'Guest Bot',
  );
  assert.ok(text.includes(`group task ${GROUP_ID}`), 'fallback uses the group id');
});

// ---------------------------------------------------------------------------
// recordOpenTeamInviteA2ADisplay — real CoworkStore
// ---------------------------------------------------------------------------

test('records a visible user message in the inviter A2A session', async () => {
  const coworkStore = await createCoworkStore();
  const rendered = [];
  const result = recordOpenTeamInviteA2ADisplay({
    coworkStore,
    metabot: guestBot,
    invite: invitePayload(),
    senderGlobalMetaId: INVITER_GMID,
    senderName: 'Twin Bot',
    senderAvatar: 'avatar-1',
    envelopePinId: INVITE_ID,
    emitToRenderer: (channel, data) => rendered.push({ channel, data }),
  });
  assert.ok(result, 'display result expected');
  assert.equal(result.duplicate, false);

  const session = coworkStore.getSession(result.sessionId);
  assert.ok(session, 'A2A session created');
  assert.equal(session.peerGlobalMetaId, INVITER_GMID, 'session peer is the inviter');

  const userMessages = session.messages.filter((m) => m.type === 'user');
  assert.equal(userMessages.length, 1);
  const message = userMessages[0];
  assert.equal(message.metadata.sourceChannel, 'metaweb_private');
  assert.equal(message.metadata.openTeamInvite, true);
  assert.equal(message.metadata.direction, 'incoming');
  assert.equal(message.metadata.pinId, INVITE_ID, 'envelope pin id recorded for dedup');
  assert.equal(message.metadata.senderGlobalMetaId, INVITER_GMID);
  assert.ok(message.content.includes('External Task'));
  assert.ok(message.content.includes('Twin Bot'));
  assert.ok(Number.isFinite(message.timestamp), 'message carries the arrival time');
  assert.ok(rendered.length >= 1, 'renderer notified via cowork:stream:message');
});

test('the same envelope delivered twice produces a single bubble (duplicate)', async () => {
  const coworkStore = await createCoworkStore();
  const first = recordOpenTeamInviteA2ADisplay({
    coworkStore,
    metabot: guestBot,
    invite: invitePayload(),
    senderGlobalMetaId: INVITER_GMID,
    senderName: 'Twin Bot',
    envelopePinId: INVITE_ID,
  });
  const second = recordOpenTeamInviteA2ADisplay({
    coworkStore,
    metabot: guestBot,
    invite: invitePayload(),
    senderGlobalMetaId: INVITER_GMID,
    senderName: 'Twin Bot',
    envelopePinId: INVITE_ID,
  });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true, 'socket + backfill double delivery must not duplicate the bubble');
  const session = coworkStore.getSession(second.sessionId);
  assert.equal(session.messages.filter((m) => m.type === 'user').length, 1);
});

test('a different invite produces a second visible message', async () => {
  const coworkStore = await createCoworkStore();
  recordOpenTeamInviteA2ADisplay({
    coworkStore,
    metabot: guestBot,
    invite: invitePayload(),
    senderGlobalMetaId: INVITER_GMID,
    envelopePinId: INVITE_ID,
  });
  recordOpenTeamInviteA2ADisplay({
    coworkStore,
    metabot: guestBot,
    invite: invitePayload({
      inviteId: INVITE_ID_2,
      taskTitle: 'Second Task',
      requiredSkills: [],
    }),
    senderGlobalMetaId: INVITER_GMID,
    envelopePinId: INVITE_ID_2,
  });
  const summaries = coworkStore.listSessions({ metabotId: 7 });
  assert.equal(summaries.length, 1, 'a single canonical inviter session');
  const session = coworkStore.getSession(summaries[0].id);
  const userMessages = session.messages.filter((m) => m.type === 'user');
  assert.equal(userMessages.length, 2, 'each distinct invite is a distinct visible message');
  assert.ok(userMessages.some((m) => m.content.includes('Second Task')));
});

test('no sender globalMetaId -> nothing recorded', async () => {
  const coworkStore = await createCoworkStore();
  const result = recordOpenTeamInviteA2ADisplay({
    coworkStore,
    metabot: guestBot,
    invite: invitePayload(),
    senderGlobalMetaId: '',
    envelopePinId: INVITE_ID,
  });
  assert.equal(result, null);
  assert.equal(coworkStore.listSessions({ metabotId: 7 }).length, 0, 'no session created');
});
