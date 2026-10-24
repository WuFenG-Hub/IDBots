// Regression test for the assistant-mode acceptance report "earlier
// narration bubbles disappear when the final report streams in", pinned to
// the 2026-10-24 owner_update design.
//
// Assistant mode surfaces progress ONLY through explicit host owner_update
// calls: each accepted call mints one whole chat bubble tagged
// metadata.{ narration: true, ownerUpdateKind } (coworkRunner
// emitAssistantOwnerUpdate, capped per turn). Ordinary model commentary
// folds into the hidden thinking display and never becomes a chat message.
// The live renderer path is: main emits `message` (new rows) and
// `messageUpdate` (stream/finalize for slotted rows) → coworkSlice reducers
// apply them to the open session. This test drives the REAL coworkSlice
// reducer with the exact live event sequence of a two-round turn whose
// progress arrives as owner_update bubbles plus a streamed final answer, and
// asserts every owner-update bubble survives — present and byte-identical,
// ownerUpdateKind included — at every point, including the turn-complete
// session refresh (windowed merge) and the transcript's turn projection.

import test from 'node:test';
import assert from 'node:assert/strict';

import reducer, {
  setSessions,
  setCurrentSession,
  addMessage,
  updateMessageContent,
} from '../src/renderer/store/slices/coworkSlice';
import {
  buildDisplayItems,
  buildConversationTurns,
} from '../src/renderer/components/cowork/CoworkSessionDetail';
import type {
  CoworkMessage,
  CoworkSession,
  CoworkSessionSummary,
} from '../src/renderer/types/cowork';

const summary = (overrides: Partial<CoworkSessionSummary>): CoworkSessionSummary => ({
  id: 'session-a',
  title: 'Session A',
  status: 'waiting',
  pinned: false,
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides,
});

const sessionWith = (messages: CoworkMessage[]): CoworkSession => ({
  id: 'session-a',
  title: 'Session A',
  claudeSessionId: null,
  status: 'running',
  pinned: false,
  cwd: '/tmp',
  systemPrompt: '',
  executionMode: 'local',
  activeSkillIds: [],
  messages,
  // The windowed-view cursor must be present for the merge path to keep
  // live-accumulated messages on a refresh (see setCurrentSession).
  messageHistory: { hasMoreBefore: false, beforeSequence: null, pageSize: 100 },
  createdAt: 1000,
  updatedAt: 1000,
});

let seq = 0;
const row = (overrides: Partial<CoworkMessage>): CoworkMessage => ({
  id: `m${++seq}`,
  type: 'assistant',
  content: '',
  timestamp: 2000 + seq,
  ...overrides,
});

interface OwnerUpdate {
  text: string;
  kind: 'opening' | 'milestone' | 'problem';
}

/** Assert every owner-update bubble is still present with its original text and kind. */
const assertNarrationsIntact = (state: { currentSession: CoworkSession | null }, expected: OwnerUpdate[]) => {
  const narrations = (state.currentSession?.messages ?? []).filter((m) => m.metadata?.narration === true);
  assert.deepEqual(
    narrations.map((m) => ({ text: m.content, kind: m.metadata?.ownerUpdateKind })),
    expected,
  );
};

test('owner-update bubbles survive the final answer and the turn-complete refresh', () => {
  let state = reducer(undefined, setSessions([summary({ id: 'session-a' })]));
  state = reducer(state, setCurrentSession(sessionWith([
    row({ id: 'u1', type: 'user', content: '帮我跑两轮再总结' }),
  ])));

  const ownerUpdates: OwnerUpdate[] = [
    { text: '好的，我这就动手。', kind: 'opening' },
    { text: '初步检索到三笔记录。', kind: 'milestone' },
  ];
  const expected: OwnerUpdate[] = [];

  // Two tool rounds, in the exact live event shape the DSH path emits in
  // assistant mode: the round's commentary folds into the hidden thinking
  // display (streaming thinking row → settled thinking row), then tool_use →
  // owner_update → tool_result. The ONE visible progress event arrives whole
  // from the host tool (single addMessage, narration + ownerUpdateKind,
  // never a rewritable stream).
  for (const [step, update] of ownerUpdates.entries()) {
    const thinking = row({ content: '', metadata: { isThinking: true, isStreaming: true } });
    state = reducer(state, addMessage({ sessionId: 'session-a', message: thinking }));
    state = reducer(state, updateMessageContent({
      sessionId: 'session-a',
      messageId: thinking.id,
      content: `round ${step + 1} reasoning`,
    }));
    state = reducer(state, updateMessageContent({
      sessionId: 'session-a',
      messageId: thinking.id,
      content: `round ${step + 1} reasoning`,
      metadata: { isStreaming: false, isFinal: true },
    }));
    state = reducer(state, addMessage({
      sessionId: 'session-a',
      message: row({ type: 'tool_use', content: 'Using tool: bash', metadata: { toolUseId: `c${step}` } }),
    }));
    state = reducer(state, addMessage({
      sessionId: 'session-a',
      message: row({ content: update.text, metadata: { narration: true, ownerUpdateKind: update.kind } }),
    }));
    expected.push(update);
    assertNarrationsIntact(state, expected);
    state = reducer(state, addMessage({
      sessionId: 'session-a',
      message: row({ type: 'tool_result', content: 'ok', metadata: { toolUseId: `c${step}` } }),
    }));
    assertNarrationsIntact(state, expected);
  }

  // The final answer mints an empty streaming bubble, then finalizes with the
  // report (the update is full-content, like every DSH finalize).
  const report = '## 汇总\n全部完成。';
  const reply = row({ content: '', metadata: { isStreaming: true } });
  state = reducer(state, addMessage({ sessionId: 'session-a', message: reply }));
  assertNarrationsIntact(state, expected);
  state = reducer(state, updateMessageContent({
    sessionId: 'session-a',
    messageId: reply.id,
    content: report,
    metadata: { isStreaming: false, isFinal: true },
  }));
  assertNarrationsIntact(state, expected);

  // Turn-complete refresh: the renderer re-reads the session through the
  // bounded newest-messages window. A long turn can push its own earliest
  // messages out of the window — the merge must still keep every message the
  // live stream accumulated (the reported erasure), owner_update bubbles
  // included, kinds intact.
  const windowed = sessionWith((state.currentSession?.messages ?? [])
    .filter((m) => m.content !== ownerUpdates[0].text));
  state = reducer(state, setCurrentSession(windowed));
  assertNarrationsIntact(state, expected);

  // Transcript projection: both owner-update bubbles stay ordinary assistant
  // items in the turn (the assistant-mode visibility filter only drops
  // thinking and tool chrome).
  const turns = buildConversationTurns(buildDisplayItems(state.currentSession!.messages));
  const lastTurn = turns[turns.length - 1];
  const renderedTexts = lastTurn.assistantItems
    .filter((item) => item.type === 'assistant')
    .map((item) => item.message.content);
  for (const update of ownerUpdates) {
    assert.ok(renderedTexts.includes(update.text), `turn projection must keep owner update: ${update.text}`);
  }
  assert.ok(renderedTexts.includes(report), 'turn projection must keep the final answer');
});
