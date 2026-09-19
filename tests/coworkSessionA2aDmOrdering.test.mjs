import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoworkStore,
  createSqliteStore,
} from './memoryTestUtils.mjs';

/**
 * Regression tests for the session-list activity key (fix/a2a-owner-dm-visibility).
 *
 * The list sorts by the last "conversation event". Historically that was only
 * the last type='user' message (the anti-flicker fix), which sank bot-driven
 * threads: a bot DM'ing its owner (metaweb_private-synced assistant messages,
 * e.g. morning reports) never bumped the conversation, so the thread with a
 * three-day-old user message ranked ~#122 of 215 and the owner "could not
 * find the conversation". On-chain A2A private DMs (metadata.sourceChannel
 * === 'metaweb_private') are atomic daemon inserts, never local stream
 * chunks, so counting them keeps the original anti-flicker guarantee: local
 * streamed assistant messages (metadata like {"isStreaming":false}) still do
 * not move a session's list position.
 */

const HOUR = 3_600_000;
const backdate = (db, messageId, createdAtMs) => {
  db.run('UPDATE cowork_messages SET created_at = ? WHERE id = ?', [createdAtMs, messageId]);
};

test('a metaweb_private DM bumps the session above stream-only activity', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);

    // Bot-driven owner thread: one old user message, then fresh daemon-synced
    // DMs (assistant + sourceChannel=metaweb_private), like twin -> owner.
    const ownerThread = store.createSession('Sunny', '/tmp/owner', '', 'local', [], 1);
    const ownerUserMsg = store.addMessage(ownerThread.id, {
      type: 'user',
      content: 'owner wrote long ago',
    });
    const ownerDm = store.addMessage(ownerThread.id, {
      type: 'assistant',
      content: '[Daily report] delivered now',
      metadata: { sourceChannel: 'metaweb_private', direction: 'outgoing' },
    });
    backdate(db, ownerUserMsg.id, Date.now() - 72 * HOUR);
    backdate(db, ownerDm.id, Date.now() - 1 * 60_000);

    // Busy local task: same old user message, then MANY fresh streamed
    // assistant chunks (no sourceChannel) — must NOT out-rank the DM thread.
    const busyTask = store.createSession('busy local task', '/tmp/busy', '', 'local', [], 1);
    const busyUserMsg = store.addMessage(busyTask.id, {
      type: 'user',
      content: 'run the task',
    });
    const streamChunk = store.addMessage(busyTask.id, {
      type: 'assistant',
      content: 'streaming chunk',
      metadata: { isStreaming: false, isFinal: true },
    });
    backdate(db, busyUserMsg.id, Date.now() - 48 * HOUR);
    backdate(db, streamChunk.id, Date.now() - 30_000);

    const listed = store.listSessions({ metabotId: 1 });
    assert.equal(listed.length, 2);
    assert.equal(listed[0].id, ownerThread.id);
    assert.equal(listed[1].id, busyTask.id);
    // The DM timestamp (1 min ago) is the owner thread's activity, not the
    // 72h-old user message.
    assert.ok(listed[0].updatedAt >= Date.now() - 5 * 60_000);
  } finally {
    cleanup();
  }
});

test('a session with only metaweb_private messages (no user message) still has activity', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);

    const peerThread = store.createSession('peer', '/tmp/peer', '', 'local', [], 2);
    const dm = store.addMessage(peerThread.id, {
      type: 'assistant',
      content: 'bot -> peer DM',
      metadata: { sourceChannel: 'metaweb_private', direction: 'outgoing' },
    });
    backdate(db, dm.id, Date.now() - 2 * 60_000);

    const staleThread = store.createSession('older', '/tmp/older', '', 'local', [], 2);
    const staleMsg = store.addMessage(staleThread.id, {
      type: 'assistant',
      content: 'plain message from long ago',
      metadata: null,
    });
    backdate(db, staleMsg.id, Date.now() - 24 * HOUR);

    const listed = store.listSessions({ metabotId: 2 });
    assert.deepEqual(listed.map((summary) => summary.id), [peerThread.id, staleThread.id]);
  } finally {
    cleanup();
  }
});

test('internal sync channels (orchestrator/order) do not bump the activity key', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);

    // Thread with an OLD user message whose only recent traffic is an
    // orchestrator sync message: the internal burst must NOT lift it above a
    // thread whose last user message is genuinely newer. (The any-message
    // fallback for sessions WITHOUT a user message is untouched.)
    const quiet = store.createSession('quiet', '/tmp/quiet', '', 'local', [], 3);
    const quietUser = store.addMessage(quiet.id, {
      type: 'user',
      content: 'old turn',
    });
    const quietOrchestrator = store.addMessage(quiet.id, {
      type: 'assistant',
      content: 'orchestrator housekeeping',
      metadata: { sourceChannel: 'orchestrator' },
    });
    backdate(db, quietUser.id, Date.now() - 48 * HOUR);
    backdate(db, quietOrchestrator.id, Date.now() - 60_000);

    const chatty = store.createSession('chatty', '/tmp/chatty', '', 'local', [], 3);
    const chattyUser = store.addMessage(chatty.id, {
      type: 'user',
      content: 'recent human turn',
    });
    backdate(db, chattyUser.id, Date.now() - 10 * 60_000);

    const listed = store.listSessions({ metabotId: 3 });
    assert.deepEqual(listed.map((summary) => summary.id), [chatty.id, quiet.id]);
  } finally {
    cleanup();
  }
});
