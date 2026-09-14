import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isDiagnosticSystemMetadata,
  isRenderableAssistantOrSystemMessage,
} from '../src/renderer/utils/coworkMessageVisibility';
import type { CoworkMessage } from '../src/renderer/types/cowork';

const msg = (overrides: Partial<CoworkMessage>): CoworkMessage => ({
  id: 'm1',
  type: 'system',
  content: '',
  timestamp: 1,
  ...overrides,
});

test('empty replyTruncatedTurn / emptyTerminalTurn / dshTurnStalled diagnostics stay renderable', () => {
  assert.equal(isRenderableAssistantOrSystemMessage(msg({ metadata: { replyTruncatedTurn: true } })), true);
  assert.equal(isRenderableAssistantOrSystemMessage(msg({ metadata: { emptyTerminalTurn: true } })), true);
  assert.equal(isRenderableAssistantOrSystemMessage(msg({ metadata: { dshTurnStalled: true } })), true);
  assert.equal(isRenderableAssistantOrSystemMessage(msg({ metadata: { dshTurnInterrupted: true } })), true);
  assert.equal(isDiagnosticSystemMetadata({ replyTruncatedTurn: true }), true);
  assert.equal(isDiagnosticSystemMetadata({ dshTurnInterrupted: true }), true);
});

test('empty system messages without a diagnostic flag stay hidden', () => {
  assert.equal(isRenderableAssistantOrSystemMessage(msg({ content: '', metadata: {} })), false);
  assert.equal(isRenderableAssistantOrSystemMessage(msg({ content: '   ' })), false);
});

test('finalized thinking with body stays renderable so the Think row can collapse', () => {
  assert.equal(
    isRenderableAssistantOrSystemMessage(msg({
      type: 'assistant',
      content: 'still figuring it out',
      metadata: { isThinking: true, isStreaming: false, isFinal: true },
    })),
    true,
  );
});

test('empty streaming thinking stays visible; empty finalized thinking is hidden', () => {
  assert.equal(
    isRenderableAssistantOrSystemMessage(msg({
      type: 'assistant',
      content: '',
      metadata: { isThinking: true, isStreaming: true },
    })),
    true,
  );
  assert.equal(
    isRenderableAssistantOrSystemMessage(msg({
      type: 'assistant',
      content: '',
      metadata: { isThinking: true, isStreaming: false, isFinal: true },
    })),
    false,
  );
});

test('ordinary assistant text and error metadata stay renderable', () => {
  assert.equal(isRenderableAssistantOrSystemMessage(msg({ type: 'assistant', content: 'done' })), true);
  assert.equal(isRenderableAssistantOrSystemMessage(msg({ content: '', metadata: { error: 'boom' } })), true);
});
