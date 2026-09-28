// Turn-object reuse for the cowork transcript.
//
// A live stream rewrites the messages array on every flush. The turns are a
// pure projection of their messages, so a turn whose messages are unchanged
// must be handed back by identity: AssistantTurnBlock is memoized on its props,
// and a fresh turn object would re-render — and re-parse the Markdown of — the
// whole transcript on every frame.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDisplayItems,
  buildConversationTurns,
} from '../src/renderer/components/cowork/CoworkSessionDetail';
import { reuseStableTurns, turnItemsAreStable } from '../src/renderer/components/cowork/conversationTurnReuse.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const userMessage = (id, content) => ({ id, type: 'user', content, timestamp: 1 });
const assistantMessage = (id, content, metadata) => ({
  id,
  type: 'assistant',
  content,
  timestamp: 2,
  ...(metadata ? { metadata } : {}),
});

const buildTurns = (messages) => buildConversationTurns(buildDisplayItems(messages));

test('only the streaming turn is rebuilt while its text grows', () => {
  const settledOne = assistantMessage('a1', 'first answer');
  const settledTwo = assistantMessage('a2', 'second answer');
  const messages = [
    userMessage('u1', 'one'),
    settledOne,
    userMessage('u2', 'two'),
    settledTwo,
    userMessage('u3', 'three'),
    assistantMessage('a3', '', { isStreaming: true }),
  ];

  const turns = buildTurns(messages);
  assert.equal(turns.length, 3);

  // One streamed chunk: immer replaces the streaming message object, the
  // settled ones keep their identity.
  const streamed = assistantMessage('a3', 'streaming token', { isStreaming: true });
  const nextMessages = [...messages.slice(0, 5), streamed];
  const stable = reuseStableTurns(turns, buildTurns(nextMessages));

  assert.equal(stable.length, 3);
  assert.equal(stable[0], turns[0], 'settled turn keeps its object');
  assert.equal(stable[1], turns[1], 'settled turn keeps its object');
  assert.notEqual(stable[2], turns[2], 'the streaming turn is rebuilt');
  assert.equal(stable[2].assistantItems[0].message, streamed, 'and it carries the new message');
  assert.equal(stable[2].assistantItems[0].message.content, 'streaming token');
});

test('an unchanged rebuild reuses every turn', () => {
  const messages = [
    userMessage('u1', 'one'),
    assistantMessage('a1', 'first answer'),
    userMessage('u2', 'two'),
    assistantMessage('a2', 'second answer'),
  ];
  const turns = buildTurns(messages);
  // Same messages, fresh arrays (what a non-streaming store update looks like).
  const stable = reuseStableTurns(turns, buildTurns([...messages]));

  assert.deepEqual(stable, turns);
  for (let index = 0; index < turns.length; index += 1) {
    assert.equal(stable[index], turns[index]);
  }
});

test('a turn whose tool result arrives is rebuilt, not served stale', () => {
  const toolUse = {
    id: 't1',
    type: 'tool_use',
    content: 'Using tool: read',
    timestamp: 3,
    metadata: { toolName: 'read', toolUseId: 'call-1' },
  };
  const messages = [userMessage('u1', 'read this'), toolUse];
  const turns = buildTurns(messages);
  assert.equal(turns[0].assistantItems[0].type, 'tool_group');
  assert.equal(turns[0].assistantItems[0].group.toolResult, undefined);

  const toolResult = {
    id: 't2',
    type: 'tool_result',
    content: 'file contents',
    timestamp: 4,
    metadata: { toolUseId: 'call-1' },
  };
  const stable = reuseStableTurns(turns, buildTurns([...messages, toolResult]));

  assert.notEqual(stable[0], turns[0], 'the paired turn cannot keep its old object');
  assert.equal(stable[0].assistantItems[0].group.toolResult, toolResult);
});

test('turns do not match across a shifted history or a different session', () => {
  const messages = [
    userMessage('u2', 'two'),
    assistantMessage('a2', 'second answer'),
  ];
  const turns = buildTurns(messages);

  const prepended = [{ id: 'u1', type: 'user', content: 'one', timestamp: 0 }, ...messages];
  const stable = reuseStableTurns(turns, buildTurns(prepended));
  assert.equal(stable.length, 2);
  assert.notEqual(stable[0], turns[0], 'the shifted turn is not the same turn');
  assert.equal(stable[0].userMessage.id, 'u1');

  const otherSession = buildTurns([userMessage('u9', 'other'), assistantMessage('a9', 'other answer')]);
  const crossed = reuseStableTurns(turns, otherSession);
  assert.equal(crossed[0], otherSession[0], 'a different session id never reuses the old turn');
});

test('turnItemsAreStable only reports identity-equal content', () => {
  const messages = [userMessage('u1', 'one'), assistantMessage('a1', 'answer')];
  const [turn] = buildTurns(messages);
  const [sameTurn] = buildTurns([...messages]);
  assert.equal(turnItemsAreStable(turn, sameTurn), true);

  const [changedUser] = buildTurns([userMessage('u1', 'edited'), messages[1]]);
  assert.equal(turnItemsAreStable(turn, changedUser), false);

  const [changedAssistant] = buildTurns([messages[0], assistantMessage('a1', 'answer plus more')]);
  assert.equal(turnItemsAreStable(turn, changedAssistant), false);
});

test('the transcript reuses turns and keeps onBranch stable', () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'components', 'cowork', 'CoworkSessionDetail.tsx'),
    'utf8',
  );
  assert.match(source, /import \{ reuseStableTurns \} from '\.\/conversationTurnReuse\.js'/, 'the reuse helper is wired');
  assert.match(source, /reuseStableTurns\(cache\.turns, rebuilt\)/, 'turns go through the reuse cache');
  assert.match(source, /cache\.sessionId !== sessionId/, 'the cache is scoped to one session');

  // onBranch rides a ref: a new identity would defeat AssistantTurnBlock's memo
  // for every turn on every stream flush.
  const branchHandlerIndex = source.indexOf('const handleBranchFromMessage = useCallback(');
  assert.notEqual(branchHandlerIndex, -1);
  const branchHandler = source.slice(branchHandlerIndex, branchHandlerIndex + 700);
  assert.match(branchHandler, /branchRequestRef\.current/, 'the handler reads the live session through the ref');
  assert.match(branchHandler, /\}, \[\]\)/, 'and its identity never changes');
});
