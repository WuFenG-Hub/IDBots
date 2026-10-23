// Behavioral tests for the ACTIVE wrap-up mechanism wired into
// runOrchestratorSkillTurn (orchestratorCoworkBridge.ts): opt-in via
// params.wrapUpSignal only; every legacy caller (group-task, A2A, study,
// surf, private-chat routing — all without wrapUpSignal) keeps the passive
// watchdog semantics byte-for-byte, which the first test pins.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  runOrchestratorSkillTurn,
  SkillTurnTimeoutError,
} = require('../dist-electron/main/services/orchestratorCoworkBridge.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeHarness() {
  const runner = new EventEmitter();
  const calls = { startSession: [], updateSession: [] };
  const session = { id: 'wrap-up-session-1', messages: [] };
  const store = {
    getAppLanguage() { return 'en'; },
    createSession() { return session; },
    addMessage(sessionId, message) {
      const record = { id: `message-${session.messages.length + 1}`, timestamp: Date.now(), ...message };
      session.messages.push(record);
      return record;
    },
    getSession(sessionId) { return sessionId === session.id ? session : null; },
    updateSession(sessionId, patch) { calls.updateSession.push({ sessionId, patch }); },
    setSessionAutoOrigin() {},
  };
  // The worker session never completes on its own — the test drives every
  // 'complete'/'error' event to exercise the wrap-up timers deterministically.
  runner.startSession = async (sessionId, userMessage, options) => {
    calls.startSession.push({ sessionId, userMessage, options });
  };
  const pushAssistantReply = (content) => {
    session.messages.push({ id: `assistant-${session.messages.length}`, type: 'assistant', content, timestamp: Date.now() });
    runner.emit('complete', session.id);
  };
  const makeInjectRecorder = () => {
    const injected = [];
    return {
      injected,
      injectMessage: (message) => { injected.push(message); },
    };
  };
  return { runner, store, session, calls, pushAssistantReply, makeInjectRecorder };
}

const baseParams = (runner, store, extra = {}) => ({
  systemPrompt: 'worker system prompt',
  userMessage: 'do the delegated step',
  cwd: '/tmp/idbots-worker-2',
  metabotId: 2,
  sourceChannel: 'orchestrator',
  onSessionCreated: undefined,
  ...extra,
});

test('legacy callers (no wrapUpSignal): passive watchdog rejects, late completion still recovered', async () => {
  const { runner, store, pushAssistantReply } = makeHarness();
  const lateResults = [];
  const turn = runOrchestratorSkillTurn(runner, store, baseParams(runner, store, {
    skillTurnTimeoutMs: 60,
    lateCompletionTimeoutMs: 400,
    onLateCompletion: (late) => { lateResults.push(late); },
  }));

  await assert.rejects(turn, (error) => error instanceof SkillTurnTimeoutError);
  // Recovery stays attached: a late 'complete' flows to onLateCompletion.
  pushAssistantReply('late handoff after watchdog');
  await sleep(30);
  assert.equal(lateResults.length, 1);
  assert.equal(lateResults[0].replyText, 'late handoff after watchdog');
});

test('wrap-up signal: budget exhaustion injects ONE signal, promise stays pending, WRAP_UP reply resolves', async () => {
  const { runner, store, pushAssistantReply, makeInjectRecorder } = makeHarness();
  const recorder = makeInjectRecorder();

  const turn = runOrchestratorSkillTurn(runner, store, baseParams(runner, store, {
    skillTurnTimeoutMs: 80,
    wrapUpSignal: { graceMs: 500, extensionRatio: 0.5, injectMessage: recorder.injectMessage },
  }));

  // Budget fires ~80ms: exactly one injection with the full protocol.
  await sleep(160);
  assert.equal(recorder.injected.length, 1);
  const signal = recorder.injected[0];
  assert.ok(signal.includes('[ORCH-WRAP-UP]'), 'signal must carry the wrap-up banner');
  assert.ok(signal.includes('budget'), 'signal must state the budget exhaustion');
  assert.ok(signal.includes('EXTENSION_REQUEST:'), 'signal must teach the extension marker');
  assert.ok(signal.includes('WRAP_UP:'), 'signal must teach the wrap-up marker');

  // Promise must still be pending (the passive reject is suppressed).
  let settled = false;
  const tracked = Promise.race([turn.then(() => settled = true, () => settled = true), sleep(20).then(() => settled)]);
  await tracked;
  assert.equal(settled, false, 'wrap-up turn must stay pending inside the grace window');

  pushAssistantReply('WRAP_UP: finished — handoff with evidence');
  const reply = await turn;
  assert.equal(reply, 'WRAP_UP: finished — handoff with evidence');
  assert.equal(recorder.injected.length, 1, 'no further injections after a WRAP_UP reply');
});

test('wrap-up signal: first-line EXTENSION_REQUEST grants ONE capped extension, handoff then resolves', async () => {
  const { runner, store, pushAssistantReply, makeInjectRecorder } = makeHarness();
  const recorder = makeInjectRecorder();

  // Micro-timescale of the cap arithmetic: budget 240ms, ratio 0.5 → the
  // extension is min(120, headroom≈huge) = 120ms — wide enough to assert
  // INSIDE the extension window without racing it.
  const turn = runOrchestratorSkillTurn(runner, store, baseParams(runner, store, {
    skillTurnTimeoutMs: 240,
    wrapUpSignal: { graceMs: 700, extensionRatio: 0.5, injectMessage: recorder.injectMessage },
  }));

  await sleep(300); // budget fires ~240ms, signal injected
  assert.equal(recorder.injected.length, 1);
  pushAssistantReply('EXTENSION_REQUEST: unit suite still running');

  // Grant notice lands immediately (sync on the complete event); the
  // 120ms extension window is still running at this checkpoint.
  await sleep(40);
  assert.equal(recorder.injected.length, 2);
  assert.ok(recorder.injected[1].includes('[ORCH-EXTENSION-GRANTED]'), 'second injection is the grant notice');
  assert.ok(recorder.injected[1].includes('only one'), 'grant notice marks the extension as the only one');

  pushAssistantReply('WRAP_UP: done after extension');
  const reply = await turn;
  assert.equal(reply, 'WRAP_UP: done after extension');
  assert.equal(recorder.injected.length, 2, 'no injection beyond the grant');
});

test('wrap-up signal: a SECOND extension request is ignored — it resolves like any reply', async () => {
  const { runner, store, pushAssistantReply, makeInjectRecorder } = makeHarness();
  const recorder = makeInjectRecorder();

  const turn = runOrchestratorSkillTurn(runner, store, baseParams(runner, store, {
    skillTurnTimeoutMs: 240, // extension = 120ms
    wrapUpSignal: { graceMs: 700, extensionRatio: 0.5, injectMessage: recorder.injectMessage },
  }));

  await sleep(300);
  pushAssistantReply('EXTENSION_REQUEST: first');
  await sleep(40);
  assert.equal(recorder.injected.length, 2);

  pushAssistantReply('EXTENSION_REQUEST: second — asking again');
  const reply = await turn;
  assert.equal(reply, 'EXTENSION_REQUEST: second — asking again');
  assert.equal(recorder.injected.length, 2, 'the second request must not grant or deny again');
});

test('wrap-up signal: extension expiry injects the FINAL wrap-up (no extension offer), reply resolves', async () => {
  const { runner, store, pushAssistantReply, makeInjectRecorder } = makeHarness();
  const recorder = makeInjectRecorder();

  const turn = runOrchestratorSkillTurn(runner, store, baseParams(runner, store, {
    skillTurnTimeoutMs: 240, // extension = 120ms
    wrapUpSignal: { graceMs: 900, extensionRatio: 0.5, injectMessage: recorder.injectMessage },
  }));

  await sleep(300);
  pushAssistantReply('EXTENSION_REQUEST: need the extension');
  await sleep(40);
  assert.equal(recorder.injected.length, 2);

  // Let the 120ms extension watchdog fire (~120ms later, with margin).
  await sleep(250);
  assert.equal(recorder.injected.length, 3, 'final wrap-up signal after the extension expiry');
  const finalSignal = recorder.injected[2];
  assert.ok(finalSignal.includes('[ORCH-WRAP-UP]'));
  assert.ok(finalSignal.includes('No further extension is available'), 'final signal must withdraw the extension offer');
  assert.ok(!finalSignal.includes('EXTENSION_REQUEST: <one-line reason>'));

  pushAssistantReply('WRAP_UP: final handoff');
  const reply = await turn;
  assert.equal(reply, 'WRAP_UP: final handoff');
});

test('wrap-up signal: extension request in the FINAL window is ignored — reply resolves', async () => {
  const { runner, store, pushAssistantReply, makeInjectRecorder } = makeHarness();
  const recorder = makeInjectRecorder();

  const turn = runOrchestratorSkillTurn(runner, store, baseParams(runner, store, {
    skillTurnTimeoutMs: 240, // extension = 120ms
    wrapUpSignal: { graceMs: 900, extensionRatio: 0.5, injectMessage: recorder.injectMessage },
  }));

  await sleep(300);
  pushAssistantReply('EXTENSION_REQUEST: first');
  await sleep(250); // extension (120ms) expires → final wrap-up injected
  assert.equal(recorder.injected.length, 3);

  pushAssistantReply('EXTENSION_REQUEST: ignored — here is the handoff anyway');
  const reply = await turn;
  assert.equal(reply, 'EXTENSION_REQUEST: ignored — here is the handoff anyway');
  assert.equal(recorder.injected.length, 3, 'ignored request must not trigger another grant');
});

test('wrap-up signal: grace expiry rejects with SkillTurnTimeoutError and keeps late recovery attached', async () => {
  const { runner, store, pushAssistantReply, makeInjectRecorder } = makeHarness();
  const recorder = makeInjectRecorder();
  const lateResults = [];

  const turn = runOrchestratorSkillTurn(runner, store, baseParams(runner, store, {
    skillTurnTimeoutMs: 80,
    lateCompletionTimeoutMs: 200,
    wrapUpSignal: { graceMs: 80, extensionRatio: 0.5, injectMessage: recorder.injectMessage },
    onLateCompletion: (late) => { lateResults.push(late); },
  }));

  await assert.rejects(
    turn,
    (error) => error instanceof SkillTurnTimeoutError,
    'grace expiry must settle as the legacy watchdog failure',
  );
  assert.equal(recorder.injected.length, 1, 'exactly one signal before the expiry settle');

  // Recovery semantics preserved: a later completion flows to onLateCompletion
  // instead of vanishing (the 2026-10-21 silent-death pattern).
  pushAssistantReply('handoff eventually written');
  await sleep(40);
  assert.equal(lateResults.length, 1);
  assert.equal(lateResults[0].replyText, 'handoff eventually written');
});

test('wrap-up signal: a real session error during the wrap phase fails the turn like the legacy path', async () => {
  const { runner, store, session, makeInjectRecorder } = makeHarness();
  const recorder = makeInjectRecorder();

  const turn = runOrchestratorSkillTurn(runner, store, baseParams(runner, store, {
    skillTurnTimeoutMs: 80,
    // Short recovery window so the (intentional) post-fail recovery timer
    // cannot keep the test process alive for the 12h default.
    lateCompletionTimeoutMs: 300,
    wrapUpSignal: { graceMs: 400, extensionRatio: 0.5, injectMessage: recorder.injectMessage },
  }));

  await sleep(150); // wrap-up engaged
  assert.equal(recorder.injected.length, 1);
  runner.emit('error', session.id, 'boom mid-wrap-up');

  await assert.rejects(turn, /boom mid-wrap-up/);
});
