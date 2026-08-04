import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

// groupTaskService -> groupChatTransport -> metaidCore imports electron; mock it.
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
const { GroupTaskStore } = require('../dist-electron/main/groupTaskStore.js');
const groupTaskService = require('../dist-electron/main/services/groupTaskService.js');

Module._load = originalLoad;

const {
  createGroupTask,
  listGroupTasks,
  getGroupTask,
  postGroupTaskMessage,
  joinGroupTaskMember,
  closeGroupTask,
  setGroupTaskServiceMetabotStoreGetter,
  setGroupTaskServiceGroupTaskStoreGetter,
  setGroupTaskServiceTransport,
  resetGroupTaskServiceTransport,
} = groupTaskService;

const GROUP_ID = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000i0';
const CREATE_PIN_ID = GROUP_ID;

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-group-task-svc-'));

const insertWallet = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at)
     VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id]
  );
};

const insertMetabot = (db, { id, walletId, name, type = 'worker', globalmetaid = null }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, walletId, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `public-${id}`, `chat-public-${id}`,
      name, 1, `metaid-${id}`, globalmetaid, type, '0000', `${name} role`, `${name} soul`,
      1700000000000 + id, 1700000000000 + id,
    ]
  );
};

/**
 * Harness: real SqliteStore + MetabotStore + GroupTaskStore, mocked transport.
 * state.joinFailures: Set of metabot ids whose joinGroupChat should reject.
 * state.indexed: what waitForGroupIndexed returns.
 */
const createHarness = async (overrides = {}) => {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  const metabotStore = new MetabotStore(db, store.getSaveFunction());
  const groupTaskStore = new GroupTaskStore(db, store.getSaveFunction());

  insertWallet(db, 1);
  if (overrides.withTwin !== false) {
    insertMetabot(db, { id: 1, walletId: 1, name: 'Twin Bot', type: 'twin', globalmetaid: 'gmid-twin' });
  }
  insertMetabot(db, { id: 2, walletId: 1, name: 'Coder Bot', type: 'worker', globalmetaid: 'gmid-coder' });
  insertMetabot(db, { id: 3, walletId: 1, name: 'Designer Bot', type: 'worker', globalmetaid: 'gmid-designer' });

  const calls = { create: [], join: [], send: [], wait: [] };
  const state = {
    joinFailures: new Set(overrides.joinFailures ?? []),
    indexed: overrides.indexed ?? true,
  };

  setGroupTaskServiceMetabotStoreGetter(() => metabotStore);
  setGroupTaskServiceGroupTaskStoreGetter(() => groupTaskStore);
  setGroupTaskServiceTransport({
    createGroupChat: async (metabotId, opts) => {
      calls.create.push({ metabotId, opts });
      return { groupId: GROUP_ID, pinId: CREATE_PIN_ID };
    },
    joinGroupChat: async (metabotId, groupId) => {
      calls.join.push({ metabotId, groupId });
      if (state.joinFailures.has(metabotId)) {
        throw new Error(`join failed for ${metabotId}`);
      }
      return { pinId: `join-pin-${metabotId}` };
    },
    sendGroupChatMessage: async (metabotId, groupId, opts) => {
      calls.send.push({ metabotId, groupId, opts });
      return { pinId: `msg-pin-${calls.send.length}` };
    },
    waitForGroupIndexed: async (groupId) => {
      calls.wait.push({ groupId });
      return state.indexed;
    },
  });

  return {
    store, db, metabotStore, groupTaskStore, calls, state,
    cleanup: () => {
      resetGroupTaskServiceTransport();
      store.close();
    },
  };
};

test('createGroupTask happy path: twin chair, joins per member, kickoff, rows persisted', async () => {
  const h = await createHarness();
  try {
    const detail = await createGroupTask({
      title: 'Build MetaApp',
      goal: 'Build and publish the intro MetaApp',
      acceptanceCriteria: 'Preview URL works',
      memberMetabotIds: [2, 3],
      createdBy: 'twinbot',
    });

    // chair = twin resolved automatically; group created by the chair
    assert.equal(h.calls.create.length, 1);
    assert.equal(h.calls.create[0].metabotId, 1);
    assert.equal(h.calls.create[0].opts.groupName, 'Build MetaApp');
    assert.equal(h.calls.wait.length, 1);
    assert.equal(h.calls.wait[0].groupId, GROUP_ID);

    // task row persisted
    assert.equal(detail.groupId, GROUP_ID);
    assert.equal(detail.status, 'planning');
    assert.equal(detail.chairMetabotId, 1);
    assert.equal(detail.createdBy, 'twinbot');
    assert.equal(detail.createPinId, CREATE_PIN_ID);

    // members: chair + 2 workers, all joined on-chain
    assert.equal(detail.members.length, 3);
    const chair = detail.members.find((m) => m.role === 'chair');
    assert.equal(chair?.metabotId, 1);
    assert.equal(chair?.joinedPinId, CREATE_PIN_ID);
    assert.equal(chair?.globalmetaid, 'gmid-twin');
    for (const workerId of [2, 3]) {
      const worker = detail.members.find((m) => m.metabotId === workerId);
      assert.equal(worker?.role, 'worker');
      assert.equal(worker?.joinedPinId, `join-pin-${workerId}`);
    }
    assert.deepEqual(h.calls.join.map((c) => c.metabotId).sort(), [2, 3]);

    // kickoff message posted by the chair with goal + roster
    assert.equal(h.calls.send.length, 1);
    const kickoff = h.calls.send[0];
    assert.equal(kickoff.metabotId, 1);
    assert.equal(kickoff.groupId, GROUP_ID);
    assert.match(kickoff.opts.content, /\[GROUP TASK\] Build MetaApp/);
    assert.match(kickoff.opts.content, /Goal: Build and publish the intro MetaApp/);
    assert.match(kickoff.opts.content, /Acceptance: Preview URL works/);
    assert.match(kickoff.opts.content, /Chair: @Twin Bot/);
    assert.match(kickoff.opts.content, /@Coder Bot/);
    assert.match(kickoff.opts.content, /@Designer Bot/);
    assert.equal(kickoff.opts.nickName, 'Twin Bot');

    // listed too
    assert.equal((await listGroupTasks()).length, 1);
    const shown = await getGroupTask(detail.id);
    assert.equal(shown.members.length, 3);
    assert.deepEqual(shown.deliverables, []);
  } finally {
    h.cleanup();
  }
});

test('createGroupTask degrades on member join failure: task created, joined_pin_id NULL', async () => {
  const h = await createHarness({ joinFailures: [3] });
  try {
    const detail = await createGroupTask({
      title: 'T', goal: 'G', memberMetabotIds: [2, 3], createdBy: 'user',
    });
    assert.ok(detail.id > 0);
    const okWorker = detail.members.find((m) => m.metabotId === 2);
    const failedWorker = detail.members.find((m) => m.metabotId === 3);
    assert.equal(okWorker?.joinedPinId, 'join-pin-2');
    assert.equal(failedWorker?.joinedPinId, null);
    // kickoff still attempted
    assert.equal(h.calls.send.length, 1);
  } finally {
    h.cleanup();
  }
});

test('createGroupTask persists the task when waitForGroupIndexed times out', async () => {
  const h = await createHarness({ indexed: false });
  try {
    const detail = await createGroupTask({ title: 'T', goal: 'G', createdBy: 'user' });
    assert.ok(detail.id > 0);
    assert.equal(detail.groupId, GROUP_ID);
    assert.equal(detail.status, 'planning');
    // chair-only task: no worker joins; kickoff still attempted
    assert.equal(h.calls.join.length, 0);
    assert.equal(h.calls.send.length, 1);
    assert.match(h.calls.send[0].opts.content, /Members: \(chair only\)/);
  } finally {
    h.cleanup();
  }
});

test('createGroupTask rejects when no twin exists', async () => {
  const h = await createHarness({ withTwin: false });
  try {
    await assert.rejects(
      createGroupTask({ title: 'T', goal: 'G', createdBy: 'user' }),
      /[Tt]win/,
    );
    assert.equal(h.calls.create.length, 0);
  } finally {
    h.cleanup();
  }
});

test('createGroupTask validates title/goal and skips unknown/duplicate member ids', async () => {
  const h = await createHarness();
  try {
    await assert.rejects(createGroupTask({ title: '', goal: 'G', createdBy: 'user' }), /title/);
    await assert.rejects(createGroupTask({ title: 'T', goal: ' ', createdBy: 'user' }), /goal/);

    // duplicates + chair id are deduped/excluded; unknown id is skipped with a warning
    const detail = await createGroupTask({
      title: 'T', goal: 'G', memberMetabotIds: [1, 2, 2, 99], createdBy: 'user',
    });
    assert.deepEqual(detail.members.map((m) => m.metabotId).sort(), [1, 2]);
    assert.deepEqual(h.calls.join.map((c) => c.metabotId), [2]);
  } finally {
    h.cleanup();
  }
});

test('postGroupTaskMessage: membership + terminal validation, nickName default', async () => {
  const h = await createHarness();
  try {
    const detail = await createGroupTask({
      title: 'T', goal: 'G', memberMetabotIds: [2], createdBy: 'user',
    });
    h.calls.send.length = 0;

    // non-member rejected
    await assert.rejects(
      postGroupTaskMessage(detail.id, 3, 'hello'),
      /not a member/,
    );
    // empty content rejected
    await assert.rejects(
      postGroupTaskMessage(detail.id, 2, '  '),
      /content/,
    );
    // member can post; nickName defaults to the bot display name
    const result = await postGroupTaskMessage(detail.id, 2, 'work done @Twin Bot', { replyPin: 'pin-x' });
    assert.equal(result.pinId, 'msg-pin-1');
    assert.equal(h.calls.send.length, 1);
    assert.equal(h.calls.send[0].metabotId, 2);
    assert.equal(h.calls.send[0].opts.nickName, 'Coder Bot');
    assert.equal(h.calls.send[0].opts.replyPin, 'pin-x');

    // terminal task rejects further messages
    await closeGroupTask(detail.id, { status: 'cancelled' });
    await assert.rejects(
      postGroupTaskMessage(detail.id, 2, 'still here'),
      /cancelled/,
    );
  } finally {
    h.cleanup();
  }
});

test('joinGroupTaskMember: on-chain join + member row; idempotent; surfaces chain failure', async () => {
  const h = await createHarness();
  try {
    const detail = await createGroupTask({ title: 'T', goal: 'G', createdBy: 'user' });
    assert.equal(detail.members.length, 1);

    const member = await joinGroupTaskMember(detail.id, 2);
    assert.equal(member.role, 'worker');
    assert.equal(member.joinedPinId, 'join-pin-2');
    assert.equal(h.calls.join.at(-1).metabotId, 2);
    // referrer is the chair's metaid
    assert.equal(h.calls.join.length, 1);

    // inviting again is a no-op
    const again = await joinGroupTaskMember(detail.id, 2);
    assert.equal(again.metabotId, 2);
    assert.equal(h.calls.join.length, 1);

    // unknown metabot -> error
    await assert.rejects(joinGroupTaskMember(detail.id, 99), /not found/);

    // chain failure surfaces (unlike create-flow degradation)
    h.state.joinFailures.add(3);
    await assert.rejects(joinGroupTaskMember(detail.id, 3), /join failed/);
  } finally {
    h.cleanup();
  }
});

test('closeGroupTask: state machine transitions and terminal lock', async () => {
  const h = await createHarness();
  try {
    const detail = await createGroupTask({ title: 'T', goal: 'G', createdBy: 'user' });

    // planning -> done is illegal through close too
    await assert.rejects(closeGroupTask(detail.id, { status: 'done' }), /Illegal/);

    const cancelled = await closeGroupTask(detail.id, { status: 'cancelled', reason: 'user stopped' });
    assert.equal(cancelled.status, 'cancelled');
    assert.ok(cancelled.closedAt);

    // already terminal: any further close throws
    await assert.rejects(closeGroupTask(detail.id, { status: 'done' }), /Illegal/);
    await assert.rejects(closeGroupTask(9999, { status: 'done' }), /not found/);
    await assert.rejects(closeGroupTask(detail.id, { status: 'executing' }), /done.*cancelled/);
  } finally {
    h.cleanup();
  }
});
