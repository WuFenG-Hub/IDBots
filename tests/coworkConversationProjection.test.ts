import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CoworkMessage } from '../src/renderer/types/cowork';
import {
  buildConversationTurns,
  buildDisplayItems,
  getVisibleAssistantItems,
} from '../src/renderer/services/coworkConversationProjection';

function message(
  id: string,
  type: CoworkMessage['type'],
  content: string,
  metadata?: CoworkMessage['metadata'],
): CoworkMessage {
  return { id, type, content, timestamp: 1, ...(metadata ? { metadata } : {}) };
}

const mixedTranscript: CoworkMessage[] = [
  message('u1', 'user', 'Prepare the report'),
  message('thinking', 'assistant', 'Private reasoning', { isThinking: true, isStreaming: true }),
  message('tool', 'tool_use', 'RAW_TOOL_USE', { toolName: 'Bash', toolUseId: 'call-1' }),
  message('result', 'tool_result', '', { toolUseId: 'call-1', toolResult: 'report.md written' }),
  message('progress', 'assistant', 'I am preparing the report.', { narration: true }),
  message('subagent', 'system', 'INTERNAL_SUBAGENT', {
    subagentEvent: { event: 'task_started', taskId: 'task-1' },
  }),
  message('answer', 'assistant', 'The report is ready.'),
  message('empty-terminal', 'system', '', { emptyTerminalTurn: true }),
];

describe('shared cowork conversation projection', () => {
  it('pairs tools and filters control traffic without mutating raw messages', () => {
    const before = structuredClone(mixedTranscript);
    const display = buildDisplayItems(mixedTranscript);
    const turns = buildConversationTurns(display);

    assert.deepEqual(mixedTranscript, before);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.userMessage?.id, 'u1');
    assert.ok(turns[0]?.assistantItems.some((item) => item.type === 'tool_group'
      && item.group.toolUse.id === 'tool'
      && item.group.toolResult?.id === 'result'));
    assert.ok(!display.some((item) => item.type === 'message' && item.message.id === 'subagent'));
  });

  it('uses the same Assistant visibility rules for thinking, tools, owner updates, and diagnostics', () => {
    const [turn] = buildConversationTurns(buildDisplayItems(mixedTranscript));
    assert.ok(turn);
    const visible = getVisibleAssistantItems(turn.assistantItems, true);
    assert.deepEqual(
      visible.map((item) => item.type === 'tool_group' ? item.group.toolUse.id : item.message.id),
      ['progress', 'answer', 'empty-terminal'],
    );
  });

  it('keeps professional tool groups and active reasoning while hiding finalized empty rows', () => {
    const [turn] = buildConversationTurns(buildDisplayItems([
      ...mixedTranscript,
      message('finished-thinking', 'assistant', '', { isThinking: true, isStreaming: false }),
    ]));
    assert.ok(turn);
    const visible = getVisibleAssistantItems(turn.assistantItems, false);
    assert.deepEqual(
      visible.map((item) => item.type === 'tool_group' ? item.group.toolUse.id : item.message.id),
      ['thinking', 'tool', 'progress', 'answer', 'empty-terminal'],
    );
  });

  it('keeps an empty terminal turn reachable even when no final answer exists', () => {
    const turns = buildConversationTurns(buildDisplayItems([
      message('u2', 'user', 'Do work'),
      message('thinking-only', 'assistant', 'No owner-facing answer', { isThinking: true }),
      message('terminal', 'system', '', { dshTurnStalled: true }),
    ]));
    assert.equal(turns.length, 1);
    assert.deepEqual(
      getVisibleAssistantItems(turns[0]!.assistantItems, true).map((item) => item.message.id),
      ['terminal'],
    );
  });

  it('retains unmatched tool results instead of dropping them', () => {
    const [turn] = buildConversationTurns(buildDisplayItems([
      message('orphan-result', 'tool_result', '', { error: 'tool failed' }),
    ]));
    assert.ok(turn);
    assert.equal(turn.userMessage, null);
    assert.deepEqual(
      getVisibleAssistantItems(turn.assistantItems, false).map((item) => item.message.id),
      ['orphan-result'],
    );
  });
});
