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
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');
const {
  decideOpenTeamGuestResponse,
  createOpenTeamGuestDaemonLoop,
} = require('../dist-electron/main/services/openTeamGuestDaemon.js');
// Inviter-side parser: proves the guest's delivery lines ingest cleanly.
const { parseDeliverableLines } = require('../dist-electron/main/services/groupTaskDeliverableParser.js');

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

const insertMetabot = (db, { id, walletId, name, globalmetaid = null, allowChatSkills = [] }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
      boss_global_metaid, llm_id, allow_chat_skills, bio, goal, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, walletId, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `public-${id}`, `chat-public-${id}`,
      name, 1, `metaid-${id}`, globalmetaid, 'worker', '0000', `${name} role`, `${name} soul`,
      null, null, JSON.stringify(allowChatSkills), null, null, 1700000000000 + id, 1700000000000 + id,
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
  const coworkStore = new CoworkStore(db, () => {});

  insertWallet(db, 7);
  insertMetabot(db, {
    id: 7,
    walletId: 7,
    name: 'Guest Bot',
    globalmetaid: GUEST_GMID,
    allowChatSkills: overrides.allowChatSkills ?? [],
  });

  const calls = { chat: [], send: [] };
  const performChat = async (systemPrompt, userMessage, llmId, options) => {
    calls.chat.push({ systemPrompt, userMessage, llmId, options });
    return overrides.replyText ?? 'On it — results soon.';
  };
  const sendGroupMessage = async (metabotId, groupId, opts) => {
    calls.send.push([metabotId, groupId, opts]);
    return { pinId: 'sent-pin-1' };
  };

  // deps may be a function receiving the harness stores (skill seams need the
  // coworkStore created here).
  const extraDeps = typeof overrides.deps === 'function'
    ? overrides.deps({ coworkStore })
    : overrides.deps;
  const loop = createOpenTeamGuestDaemonLoop({
    getStore: () => store,
    getMetabotStore: () => metabotStore,
    getOpenTeamMembershipStore: () => membershipStore,
    performChat,
    sendGroupMessage,
    emitLog: () => {},
    now: () => 1_800_000_000_000,
    cooldownMs: 0,
    ...extraDeps,
  });
  return { store, db, metabotStore, membershipStore, coworkStore, loop, calls };
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

// ---------------------------------------------------------------------------
// M3: chat-skill turns + metafile file delivery
// ---------------------------------------------------------------------------

const SKILL_PINID = `${'ef'.repeat(32)}i0`;

/**
 * Skill-enabled harness: real CoworkStore, mocked routing/skill-turn/upload
 * seams. runSkillTurn reports artifactDir as its cwd so the delivery step
 * resolves/scans files there.
 */
const createSkillHarness = async (overrides = {}) => {
  const artifactDir = makeTempDir();
  const skillCalls = { routing: [], skillTurn: [], upload: [] };
  const state = {
    routing: overrides.routing ?? { prompt: 'SKILL ROUTING PROMPT', activeSkillIds: ['skill-doc'] },
    routingError: overrides.routingError ?? null,
    skillReply: overrides.skillReply ?? 'Draft ready.',
    skillError: overrides.skillError ?? null,
    uploadError: overrides.uploadError ?? null,
    uploadPinId: overrides.uploadPinId ?? SKILL_PINID,
  };
  const harness = await createHarness({
    replyText: overrides.replyText,
    allowChatSkills: overrides.allowChatSkills ?? ['skill-doc'],
    deps: ({ coworkStore }) => ({
      getCoworkStore: () => coworkStore,
      getChatSkillsRoutingPrompt: async (input) => {
        skillCalls.routing.push(input);
        if (state.routingError) throw new Error(state.routingError);
        return typeof state.routing === 'function' ? state.routing(input) : state.routing;
      },
      runSkillTurn: async (params) => {
        skillCalls.skillTurn.push(params);
        if (state.skillError) throw new Error(state.skillError);
        return {
          replyText: typeof state.skillReply === 'function' ? state.skillReply() : state.skillReply,
          assistantMessageId: 'asst-skill-1',
          cwd: artifactDir,
        };
      },
      uploadDeliverableFile: async (input) => {
        skillCalls.upload.push(input);
        if (state.uploadError) throw new Error(state.uploadError);
        return { pinId: state.uploadPinId };
      },
      ...(overrides.realNow ? { now: () => Date.now() } : {}),
    }),
  });
  return { ...harness, artifactDir, skillCalls };
};

const joinAndMention = (db, membershipStore, pinId) => {
  membershipStore.upsertActiveMembership({
    groupId: GROUP_ID,
    metabotId: 7,
    globalmetaid: GUEST_GMID,
    inviterGlobalmetaid: 'gmid-inviter',
    taskTitle: 'External Task',
  });
  insertGroupMessage(db, {
    pinId,
    senderMetaId: 'metaid-other',
    senderGlobalMetaId: OTHER_GMID,
    senderName: 'Other Bot',
    content: '@Guest Bot please produce the report',
  });
};

test('skill: routing hit runs the skill turn (scoped to own allow_chat_skills), not plain chat', async () => {
  const { store, db, membershipStore, coworkStore, loop, calls, skillCalls } = await createSkillHarness();
  try {
    joinAndMention(db, membershipStore, `${'a'.repeat(64)}i0`);
    await loop.runTick();

    assert.equal(skillCalls.routing.length, 1);
    // External group members are never the owner: only the bot's own
    // configured allow_chat_skills, allowAllEnabled stays false.
    assert.deepEqual(skillCalls.routing[0], { allowChatSkills: ['skill-doc'], allowAllEnabled: false });

    assert.equal(skillCalls.skillTurn.length, 1);
    assert.deepEqual(skillCalls.skillTurn[0].activeSkillIds, ['skill-doc']);
    assert.match(skillCalls.skillTurn[0].systemPrompt, /SKILL ROUTING PROMPT/);
    assert.match(skillCalls.skillTurn[0].systemPrompt, /invited/i);
    assert.match(skillCalls.skillTurn[0].systemPrompt, /absolute local path/);
    assert.match(skillCalls.skillTurn[0].userMessage, />>> Other Bot: @Guest Bot please produce the report <<</);

    // Plain completion path NOT used; the skill reply is what goes on-chain.
    assert.equal(calls.chat.length, 0);
    assert.equal(calls.send.length, 1);
    assert.equal(calls.send[0][2].content, 'Draft ready.');

    // The skill turn ran inside a per-group guest cowork session bound to bot 7.
    const session = coworkStore.getSession(skillCalls.skillTurn[0].sessionId);
    assert.ok(session);
    assert.equal(session.metabotId, 7);
    assert.equal(session.sessionType, 'group_task');
    assert.ok(session.messages.some((m) => m.type === 'user' && m.content.includes('>>> Other Bot')));

    // No file artifacts in the reply -> no upload attempted.
    assert.equal(skillCalls.upload.length, 0);
  } finally {
    store.close();
  }
});

test('skill: a mentioned file artifact uploads and delivers one [DELIVERABLE] metafile line', async () => {
  let reportPath = '';
  const { store, db, membershipStore, loop, calls, skillCalls, artifactDir } = await createSkillHarness({
    // Evaluated at turn time; the file is written below before runTick.
    skillReply: () => `Report is ready.\n${reportPath}`,
  });
  try {
    reportPath = path.join(artifactDir, 'report.pdf');
    fs.writeFileSync(reportPath, 'pdf-bytes');
    joinAndMention(db, membershipStore, `${'b'.repeat(64)}i0`);
    await loop.runTick();

    assert.equal(calls.chat.length, 0);
    assert.equal(skillCalls.upload.length, 1);
    assert.equal(skillCalls.upload[0].metabotId, 7);
    assert.equal(skillCalls.upload[0].filePath, reportPath);
    assert.equal(skillCalls.upload[0].contentType, 'application/pdf');

    assert.equal(calls.send.length, 1);
    const content = calls.send[0][2].content;
    assert.match(content, /Report is ready\./);
    const expectedLine = `[DELIVERABLE] metafile: metafile://${SKILL_PINID}.pdf`;
    assert.ok(
      content.split('\n').includes(expectedLine),
      `expected its own deliverable line, got:\n${content}`,
    );

    // The inviter-side parser must ingest the line as one valid metafile deliverable.
    const parsed = parseDeliverableLines(content);
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0], {
      kind: 'metafile',
      uri: `metafile://${SKILL_PINID}.pdf`,
      valid: true,
      note: null,
    });
  } finally {
    store.close();
  }
});

test('skill: an unmentioned file in the skill cwd is found by the turn-window scan', async () => {
  const { store, db, membershipStore, loop, calls, skillCalls, artifactDir } = await createSkillHarness({
    skillReply: 'Here is the image you asked for.',
    realNow: true,
  });
  try {
    const imagePath = path.join(artifactDir, 'chart.png');
    fs.writeFileSync(imagePath, 'png-bytes');
    joinAndMention(db, membershipStore, `${'c'.repeat(64)}i0`);
    await loop.runTick();

    assert.equal(skillCalls.upload.length, 1);
    assert.equal(skillCalls.upload[0].filePath, imagePath);
    assert.match(
      calls.send[0][2].content,
      new RegExp(`\\[DELIVERABLE\\] metafile: metafile://${SKILL_PINID}\\.png`),
    );
  } finally {
    store.close();
  }
});

test('skill: no routing hit falls back to the plain completion path', async () => {
  const { store, db, membershipStore, loop, calls, skillCalls } = await createSkillHarness({
    routing: { prompt: null, activeSkillIds: [] },
  });
  try {
    joinAndMention(db, membershipStore, `${'d'.repeat(64)}i0`);
    await loop.runTick();
    assert.equal(skillCalls.routing.length, 1);
    assert.equal(skillCalls.skillTurn.length, 0);
    assert.equal(skillCalls.upload.length, 0);
    assert.equal(calls.chat.length, 1);
    assert.equal(calls.send.length, 1);
    assert.equal(calls.send[0][2].content, 'On it — results soon.');
  } finally {
    store.close();
  }
});

test('skill: a throwing skill turn degrades to a plain text reply', async () => {
  const { store, db, membershipStore, loop, calls, skillCalls } = await createSkillHarness({
    skillError: 'runner exploded',
  });
  try {
    joinAndMention(db, membershipStore, `${'e'.repeat(64)}i0`);
    await loop.runTick();
    assert.equal(skillCalls.skillTurn.length, 1);
    assert.equal(calls.chat.length, 1);
    assert.equal(calls.send.length, 1);
    assert.equal(calls.send[0][2].content, 'On it — results soon.');
    // Cursor advanced past the triggering message despite the skill failure.
    const membership = membershipStore.getMembership(GROUP_ID, 7);
    assert.equal(membership.lastProcessedMsgId, messageIdOf(db, `${'e'.repeat(64)}i0`));
  } finally {
    store.close();
  }
});

test('skill: a routing failure also degrades to the plain completion path', async () => {
  const { store, db, membershipStore, loop, calls, skillCalls } = await createSkillHarness({
    routingError: 'skill manager unavailable',
  });
  try {
    joinAndMention(db, membershipStore, `${'f'.repeat(64)}i0`);
    await loop.runTick();
    assert.equal(skillCalls.skillTurn.length, 0);
    assert.equal(calls.chat.length, 1);
    assert.equal(calls.send.length, 1);
    assert.equal(calls.send[0][2].content, 'On it — results soon.');
  } finally {
    store.close();
  }
});

test('skill: an upload failure keeps the text reply and adds NO fake [DELIVERABLE] tag', async () => {
  let reportPath = '';
  const { store, db, membershipStore, loop, calls, skillCalls, artifactDir } = await createSkillHarness({
    skillReply: () => `Report is ready.\n${reportPath}`,
    uploadError: 'insufficient SPACE',
  });
  try {
    reportPath = path.join(artifactDir, 'report.pdf');
    fs.writeFileSync(reportPath, 'pdf-bytes');
    joinAndMention(db, membershipStore, `${'0'.repeat(64)}i0`);
    await loop.runTick();

    assert.equal(skillCalls.upload.length, 1);
    assert.equal(calls.send.length, 1);
    const content = calls.send[0][2].content;
    assert.match(content, /Report is ready\./);
    assert.match(content, /On-chain upload failed for: report\.pdf/);
    assert.ok(!content.includes('[DELIVERABLE]'), 'no deliverable tag may be emitted for a failed upload');
    assert.deepEqual(parseDeliverableLines(content), []);
  } finally {
    store.close();
  }
});

test('skill: [NO_REPLY] from a skill turn suppresses the send and never uploads', async () => {
  const { store, db, membershipStore, loop, calls, skillCalls } = await createSkillHarness({
    skillReply: '[NO_REPLY]',
  });
  try {
    joinAndMention(db, membershipStore, `${'9'.repeat(64)}i0`);
    await loop.runTick();
    assert.equal(skillCalls.skillTurn.length, 1);
    assert.equal(skillCalls.upload.length, 0);
    assert.equal(calls.chat.length, 0);
    assert.equal(calls.send.length, 0);
    const membership = membershipStore.getMembership(GROUP_ID, 7);
    assert.equal(membership.lastProcessedMsgId, messageIdOf(db, `${'9'.repeat(64)}i0`));
  } finally {
    store.close();
  }
});
