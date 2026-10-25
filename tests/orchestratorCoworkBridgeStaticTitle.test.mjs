/**
 * Nightly-token audit (2026-10-25): unattended orchestrator sessions that are
 * hidden from the session list (surf / study / exam) used to pay one
 * title-summarization LLM call per session for a title nobody ever sees.
 * `sessionTitle` on RunOrchestratorSkillTurnParams supplies a static body and
 * MUST bypass generateSessionTitle entirely; callers that omit it keep the
 * legacy summarization path unchanged.
 *
 * NOTE: imports the dist-electron build — run `pnpm run compile:electron` first.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const coworkUtil = require('../dist-electron/main/libs/coworkUtil.js');
const { runOrchestratorSkillTurn } = require('../dist-electron/main/services/orchestratorCoworkBridge.js');

function buildHarness() {
  const runner = new EventEmitter();
  const calls = [];
  const session = { id: 'session-static-title', messages: [] };
  const store = {
    getAppLanguage() { return 'en'; },
    createSession(title, cwd, systemPrompt, executionMode, activeSkillIds, metabotId) {
      calls.push({ type: 'createSession', title, cwd, systemPrompt, executionMode, activeSkillIds, metabotId });
      return session;
    },
    addMessage(sessionId, message) {
      const record = { id: `message-${session.messages.length + 1}`, timestamp: Date.now(), ...message };
      session.messages.push(record);
      return record;
    },
    getSession() { return session; },
    updateSession(sessionId, patch) { calls.push({ type: 'updateSession', sessionId, patch }); },
    setSessionAutoOrigin(sessionId, origin) { calls.push({ type: 'setSessionAutoOrigin', sessionId, origin }); },
  };
  runner.startSession = async (sessionId) => {
    session.messages.push({ id: 'assistant-1', type: 'assistant', content: 'done', timestamp: Date.now() });
    queueMicrotask(() => runner.emit('complete', sessionId));
  };
  return { runner, store, calls };
}

async function withPatchedTitleGenerator(run) {
  const original = coworkUtil.generateSessionTitle;
  const titleCalls = [];
  coworkUtil.generateSessionTitle = async (text) => {
    titleCalls.push(text);
    return 'LLM Generated Title';
  };
  try {
    return await run(titleCalls);
  } finally {
    coworkUtil.generateSessionTitle = original;
  }
}

test('sessionTitle skips the title-summarization LLM call and composes the static body', async () => {
  await withPatchedTitleGenerator(async (titleCalls) => {
    const { runner, store, calls } = buildHarness();
    await runOrchestratorSkillTurn(runner, store, {
      systemPrompt: '',
      userMessage: 'You are surfing MetaWeb tonight. Long unattended prompt follows...',
      cwd: '/tmp/idbots-surf',
      metabotId: 7,
      sessionTitle: 'MetaWeb Surf 2026-10-25',
    });
    assert.equal(titleCalls.length, 0, 'no title LLM call for a static-titled session');
    const created = calls.find((call) => call.type === 'createSession');
    assert.equal(created.title, '[Orchestration Task] MetaWeb Surf 2026-10-25');
  });
});

test('omitting sessionTitle keeps the legacy summarization path', async () => {
  await withPatchedTitleGenerator(async (titleCalls) => {
    const { runner, store, calls } = buildHarness();
    await runOrchestratorSkillTurn(runner, store, {
      systemPrompt: '',
      userMessage: 'Delegated work for a visible worker session',
      cwd: '/tmp/idbots-worker',
      metabotId: 7,
    });
    assert.equal(titleCalls.length, 1, 'legacy callers still summarize');
    const created = calls.find((call) => call.type === 'createSession');
    assert.equal(created.title, '[Orchestration Task] LLM Generated Title');
  });
});

test('group sessions keep their deterministic Group-<id> title regardless of sessionTitle', async () => {
  await withPatchedTitleGenerator(async (titleCalls) => {
    const { runner, store, calls } = buildHarness();
    store.upsertConversationMapping = () => {};
    await runOrchestratorSkillTurn(runner, store, {
      systemPrompt: '',
      userMessage: 'group turn',
      cwd: '/tmp/idbots-group',
      metabotId: 7,
      groupId: 'abcdef1234567890',
      sessionTitle: 'ignored for groups',
    });
    assert.equal(titleCalls.length, 0);
    const created = calls.find((call) => call.type === 'createSession');
    assert.match(created.title, /^Group-abcdef123456-\d+$/);
  });
});
