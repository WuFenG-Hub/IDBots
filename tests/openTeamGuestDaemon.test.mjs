import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

// Some stores may transitively import electron; mock it like groupTaskDaemon tests do.
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
const { MetabotStore } = require('../dist-electron/main/metabotStore.js');
const { OpenTeamMembershipStore } = require('../dist-electron/main/openTeamMembershipStore.js');
const {
  decideOpenTeamGuestResponse,
  createOpenTeamGuestDaemonLoop,
} = require('../dist-electron/main/services/openTeamGuestDaemon.js');

Module._load = originalLoad;

const GROUP_ID = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000i0';
const GUEST_GMID = 'gmid-guest';
const OTHER_GMID = 'gmid-other';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-openteam-guest-daemon-'));

// ---------------------------------------------------------------------------
// Pure gating
// ---------------------------------------------------------------------------

const gateBot = () => ({ name: 'Guest Bot', globalmetaid: GUEST_GMID, metaid: 'metaid-guest' });
const gateMessage = (overrides = {}) => ({
  id: 1,
  pinId: null,
  senderMetaId: 'metaid-other',
  senderGlobalMetaId: OTHER_GMID,
  senderName: 'Other Bot',
  content: 'hello group',
  mention: null,
  ...overrides,
});
const gateInput = (overrides = {}) => ({
  message: gateMessage(),
  bot: gateBot(),
  lastReplyAt: 0,
  now: 100_000,
  cooldownMs: 20_000,
  ...overrides,
});

test('gating: responds only when mentioned (mention array or @name)', () => {
  assert.deepEqual(decideOpenTeamGuestResponse(gateInput()), { respond: false, reason: 'not_mentioned' });
  assert.deepEqual(
    decideOpenTeamGuestResponse(gateInput({ message: gateMessage({ mention: JSON.stringify([GUEST_GMID]) }) })),
    { respond: true, reason: 'mentioned' },
  );
  assert.deepEqual(
    decideOpenTeamGuestResponse(gateInput({ message: gateMessage({ mention: JSON.stringify(['metaid-guest']) }) })),
    { respond: true, reason: 'mentioned' },
  );
  assert.deepEqual(
    decideOpenTeamGuestResponse(gateInput({ message: gateMessage({ content: '@Guest Bot please take this' }) })),
    { respond: true, reason: 'mentioned' },
  );
  // Bare name without @ must NOT count as a mention.
  assert.deepEqual(
    decideOpenTeamGuestResponse(gateInput({ message: gateMessage({ content: 'Guest Bot already checked' }) })),
    { respond: false, reason: 'not_mentioned' },
  );
});

test('gating: skips own messages, empty content, and honors the cooldown', () => {
  assert.deepEqual(
    decideOpenTeamGuestResponse(gateInput({
      message: gateMessage({ senderGlobalMetaId: GUEST_GMID, content: '@Guest Bot hi' }),
    })),
    { respond: false, reason: 'self_message' },
  );
  assert.deepEqual(
    decideOpenTeamGuestResponse(gateInput({ message: gateMessage({ content: '   ' }) })),
    { respond: false, reason: 'empty_content' },
  );
  assert.deepEqual(
    decideOpenTeamGuestResponse(gateInput({
      message: gateMessage({ mention: JSON.stringify([GUEST_GMID]) }),
      lastReplyAt: 95_000,
      now: 100_000,
      cooldownMs: 20_000,
    })),
    { respond: false, reason: 'cooldown' },
  );
});

// ---------------------------------------------------------------------------
// Daemon loop harness (real sqlite stores, mocked LLM + send)
// ---------------------------------------------------------------------------

const insertWallet = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at) VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id]
  );
};

const insertMetabot = (db, { id, walletId, name, globalmetaid = null }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
      boss_global_metaid, llm_id, allow_chat_skills, bio, goal, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, walletId, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `public-${id}`, `chat-public-${id}`,
      name, 1, `metaid-${id}`, globalmetaid, 'worker', '0000', `${name} role`, `${name} soul`,
      null, null, '[]', null, null, 1700000000000 + id, 1700000000000 + id,
    ]
  );
};

const insertGroupMessage = (db, { pinId, groupId = GROUP_ID, senderMetaId, senderGlobalMetaId, senderName, content, mention = null }) => {
  db.run(
    `INSERT INTO group_chat_messages (
      pin_id, tx_id, group_id, channel_id, sender_metaid, sender_global_metaid, sender_address,
      sender_name, sender_avatar, sender_chat_pubkey, protocol, content, content_type, encryption,
      reply_pin, mention, chain_timestamp, chain, raw_data, is_processed, msg_index
    ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, '', '', '/protocols/simplegroupchat', ?, 'text/plain', NULL, '', ?, NULL, 'mvc', '{}', 0, NULL)`,
    [pinId, pinId.replace(/i0$/, ''), groupId, senderMetaId, senderGlobalMetaId, senderName, content,
      mention ? JSON.stringify(mention) : '[]'],
  );
};

const createHarness = async (overrides = {}) => {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  const metabotStore = new MetabotStore(db, store.getSaveFunction());
  const membershipStore = new OpenTeamMembershipStore(db, store.getSaveFunction());

  insertWallet(db, 7);
  insertMetabot(db, { id: 7, walletId: 7, name: 'Guest Bot', globalmetaid: GUEST_GMID });

  const calls = { chat: [], send: [] };
  const performChat = async (systemPrompt, userMessage, llmId, options) => {
    calls.chat.push({ systemPrompt, userMessage, llmId, options });
    return overrides.replyText ?? 'On it — results soon.';
  };
  const sendGroupMessage = async (metabotId, groupId, opts) => {
    calls.send.push([metabotId, groupId, opts]);
    return { pinId: 'sent-pin-1' };
  };

  const loop = createOpenTeamGuestDaemonLoop({
    getStore: () => store,
    getMetabotStore: () => metabotStore,
    getOpenTeamMembershipStore: () => membershipStore,
    performChat,
    sendGroupMessage,
    emitLog: () => {},
    now: () => 1_800_000_000_000,
    cooldownMs: 0,
    ...overrides.deps,
  });
  return { store, db, metabotStore, membershipStore, loop, calls };
};

const messageIdOf = (db, pinId) => {
  const result = db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', [pinId]);
  return Number(result[0]?.values?.[0]?.[0]);
};

test('loop: mentions trigger a reply; unrelated and own messages do not; cursor advances', async () => {
  const { store, db, membershipStore, loop, calls } = await createHarness();
  try {
    membershipStore.upsertActiveMembership({
      groupId: GROUP_ID,
      metabotId: 7,
      globalmetaid: GUEST_GMID,
      inviterGlobalmetaid: 'gmid-inviter',
      taskTitle: 'External Task',
    });

    insertGroupMessage(db, {
      pinId: `${'1'.repeat(64)}i0`,
      senderMetaId: 'metaid-other',
      senderGlobalMetaId: OTHER_GMID,
      senderName: 'Other Bot',
      content: 'unrelated chatter',
    });
    insertGroupMessage(db, {
      pinId: `${'2'.repeat(64)}i0`,
      senderMetaId: 'metaid-other',
      senderGlobalMetaId: OTHER_GMID,
      senderName: 'Other Bot',
      content: '@Guest Bot can you take the summary?',
    });
    insertGroupMessage(db, {
      pinId: `${'3'.repeat(64)}i0`,
      senderMetaId: 'metaid-guest',
      senderGlobalMetaId: GUEST_GMID,
      senderName: 'Guest Bot',
      content: 'my own earlier message',
    });

    await loop.runTick();
    assert.equal(calls.chat.length, 1);
    assert.equal(calls.send.length, 1);
    assert.deepEqual(calls.send[0][0], 7);
    assert.deepEqual(calls.send[0][1], GROUP_ID);
    assert.equal(calls.send[0][2].content, 'On it — results soon.');
    assert.equal(calls.send[0][2].nickName, 'Guest Bot');
    // The guest prompt explains the external-collaborator role.
    assert.match(calls.chat[0].systemPrompt, /invited/i);
    assert.match(calls.chat[0].systemPrompt, /External Task/);
    assert.match(calls.chat[0].userMessage, />>> Other Bot: @Guest Bot can you take the summary\? <<</);

    // Cursor advanced past ALL messages of the tick (including skipped ones).
    const membership = membershipStore.getMembership(GROUP_ID, 7);
    assert.equal(membership.lastProcessedMsgId, messageIdOf(db, `${'3'.repeat(64)}i0`));

    // Second tick: nothing new, no reprocessing.
    await loop.runTick();
    assert.equal(calls.chat.length, 1);
    assert.equal(calls.send.length, 1);
  } finally {
    store.close();
  }
});

test('loop: [NO_REPLY] suppresses the on-chain send but still advances the cursor', async () => {
  const { store, db, membershipStore, loop, calls } = await createHarness({ replyText: '[NO_REPLY]' });
  try {
    membershipStore.upsertActiveMembership({ groupId: GROUP_ID, metabotId: 7, globalmetaid: GUEST_GMID });
    insertGroupMessage(db, {
      pinId: `${'4'.repeat(64)}i0`,
      senderMetaId: 'metaid-other',
      senderGlobalMetaId: OTHER_GMID,
      senderName: 'Other Bot',
      content: '@Guest Bot thanks!',
    });
    await loop.runTick();
    assert.equal(calls.chat.length, 1);
    assert.equal(calls.send.length, 0);
    const membership = membershipStore.getMembership(GROUP_ID, 7);
    assert.equal(membership.lastProcessedMsgId, messageIdOf(db, `${'4'.repeat(64)}i0`));
  } finally {
    store.close();
  }
});

test('loop: disabled bot and left membership stay silent', async () => {
  const { store, db, metabotStore, membershipStore, loop, calls } = await createHarness();
  try {
    membershipStore.upsertActiveMembership({ groupId: GROUP_ID, metabotId: 7, globalmetaid: GUEST_GMID });
    insertGroupMessage(db, {
      pinId: `${'5'.repeat(64)}i0`,
      senderMetaId: 'metaid-other',
      senderGlobalMetaId: OTHER_GMID,
      senderName: 'Other Bot',
      content: '@Guest Bot are you there?',
    });
    // Left memberships are excluded from listActiveMemberships.
    membershipStore.markLeft(GROUP_ID, 7);
    await loop.runTick();
    assert.equal(calls.chat.length, 0);
    assert.equal(calls.send.length, 0);
  } finally {
    store.close();
  }
});

test('store: catchUpCursorToLatest fast-forwards past existing history', async () => {
  const { store, db, membershipStore } = await createHarness();
  try {
    membershipStore.upsertActiveMembership({ groupId: GROUP_ID, metabotId: 7, globalmetaid: GUEST_GMID });
    insertGroupMessage(db, {
      pinId: `${'6'.repeat(64)}i0`,
      senderMetaId: 'metaid-other',
      senderGlobalMetaId: OTHER_GMID,
      senderName: 'Other Bot',
      content: 'old history before join',
    });
    membershipStore.catchUpCursorToLatest(GROUP_ID, 7);
    const membership = membershipStore.getMembership(GROUP_ID, 7);
    assert.equal(membership.lastProcessedMsgId, messageIdOf(db, `${'6'.repeat(64)}i0`));

    // Cursor moves only forward.
    membershipStore.updateLastProcessedMsgId(GROUP_ID, 7, 1);
    assert.equal(
      membershipStore.getMembership(GROUP_ID, 7).lastProcessedMsgId,
      messageIdOf(db, `${'6'.repeat(64)}i0`),
    );
  } finally {
    store.close();
  }
});
