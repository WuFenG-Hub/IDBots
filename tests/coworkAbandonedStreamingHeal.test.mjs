// 2026-09-14 session 50780b67: app restart (or electron:dev SIGKILL) left an
// empty assistant placeholder with isThinking+isStreaming and settled the
// session idle. The DSH stream gate never persist-finalized, resetRunningSessions
// only flipped status, and the renderer kept pulsing the Think row with no
// error banner.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...segments) => fs.readFileSync(path.join(projectRoot, ...segments), 'utf8');

test('boot heal finalizes abandoned streaming thinking and inserts a visible diagnostic', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const session = store.createSession('stuck think', process.cwd(), '', 'local', [], null);

    store.addMessage(session.id, {
      type: 'assistant',
      content: 'node 3 复核双票已派',
      metadata: { isFinal: true, isStreaming: false },
    });
    const thinking = store.addMessage(session.id, {
      type: 'assistant',
      content: '',
      metadata: { isThinking: true, isStreaming: true },
    });
    store.updateSession(session.id, { status: 'idle' });

    const healed = store.healAbandonedStreamingMessages();
    assert.ok(healed >= 1);

    const placeholder = store.getMessageById(session.id, thinking.id);
    assert.equal(placeholder.metadata.isStreaming, false);
    assert.equal(placeholder.metadata.isFinal, true);
    assert.equal(placeholder.metadata.isThinking, true);

    const page = store.getSessionMessagesPage(session.id, { limit: 20 });
    const diagnostic = page.messages.find((message) => message.metadata?.dshTurnInterrupted === true);
    assert.ok(diagnostic, 'heal must insert dshTurnInterrupted so the renderer can show a banner');
    assert.equal(diagnostic.type, 'system');
    assert.equal((diagnostic.content || '').trim(), '');

    assert.equal(store.healAbandonedStreamingMessages(), 0, 'heal is idempotent');
  } finally {
    sqlite.cleanup();
  }
});

test('boot heal ignores non-streaming metadata that merely mentions the flag in a string', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const session = store.createSession('note', process.cwd(), '', 'local', [], null);
    store.addMessage(session.id, {
      type: 'assistant',
      content: 'done',
      metadata: { isFinal: true, note: 'mentions "isStreaming":true in a comment' },
    });
    assert.equal(store.healAbandonedStreamingMessages(), 0);
  } finally {
    sqlite.cleanup();
  }
});

test('startup and DSH teardown persist-finalize abandoned streams instead of dropping them', () => {
  const mainSource = readSource('src', 'main', 'main.ts');
  const runnerSource = readSource('src', 'main', 'libs', 'coworkRunner.ts');
  const gateSource = readSource('src', 'main', 'libs', 'dshStreamUiGate.ts');

  assert.ok(mainSource.includes('healAbandonedStreamingMessages()'));
  assert.ok(
    mainSource.indexOf('healAbandonedStreamingMessages()') > mainSource.indexOf('resetRunningSessions()'),
    'heal leftover streaming placeholders after flipping running sessions idle',
  );
  assert.ok(gateSource.includes('finalizeSession('));
  assert.ok(runnerSource.includes('dshStreamUi.finalizeSession'));
  assert.ok(runnerSource.includes('dshTurnInterrupted: true'));
});
