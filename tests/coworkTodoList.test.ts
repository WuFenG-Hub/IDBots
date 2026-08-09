import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyTodoMessage,
  buildSessionTodoList,
  extractTaskIdFromResult,
  parseLegacyTaskListItems,
  parseTaskCreateItem,
  parseTaskUpdatePatch,
  parseTodoWriteItems,
  type TodoListState,
} from '../src/renderer/components/cowork/coworkTodoList';
import type { CoworkMessage } from '../src/renderer/types/cowork';

const toolUse = (
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId: string
): CoworkMessage => ({
  id: `use-${toolUseId}`,
  timestamp: Date.now(),
  type: 'tool_use',
  content: `Using tool: ${toolName}`,
  metadata: { toolName, toolInput, toolUseId },
});

const toolResult = (toolUseId: string, content: string): CoworkMessage => ({
  id: `result-${toolUseId}`,
  timestamp: Date.now(),
  type: 'tool_result',
  content,
  metadata: { toolResult: content, toolUseId },
});

const EMPTY: TodoListState = { items: [] };

test('TodoWrite replaces the full list', () => {
  const msg = toolUse('TodoWrite', {
    todos: [
      { content: 'Step A', status: 'completed', activeForm: 'Doing A' },
      { content: 'Step B', status: 'in_progress', activeForm: 'Doing B' },
      { content: 'Step C', status: 'pending', activeForm: 'Doing C' },
    ],
  }, 'tw-1');

  const state = applyTodoMessage(EMPTY, msg);
  assert.equal(state.items.length, 3);
  assert.equal(state.items[0].status, 'completed');
  assert.equal(state.items[0].primaryText, 'Doing A');
  assert.equal(state.items[1].status, 'in_progress');
  assert.equal(state.items[2].status, 'pending');

  const next = toolUse('TodoWrite', { todos: [{ content: 'Only', status: 'pending', activeForm: 'Only' }] }, 'tw-2');
  assert.equal(applyTodoMessage(state, next).items.length, 1);
});

test('TaskCreate appends a single pending task', () => {
  const msg = toolUse('TaskCreate', {
    subject: 'Fix auth bug',
    description: 'Resolve login flow issue',
    activeForm: 'Fixing auth bug',
  }, 'tc-1');

  const state = applyTodoMessage(EMPTY, msg);
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].primaryText, 'Fixing auth bug');
  assert.equal(state.items[0].secondaryText, 'Resolve login flow issue');
  assert.equal(state.items[0].status, 'pending');
  assert.equal(state.items[0].key, 'tc-1');
});

test('TaskCreate result binds the SDK task id', () => {
  const create = toolUse('TaskCreate', { subject: 'Fix auth bug' }, 'tc-1');
  const result = toolResult('tc-1', JSON.stringify({ id: 'task-42', status: 'pending' }));

  const messages = [create, result];
  const items = buildSessionTodoList(messages);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'task-42');
  assert.equal(items[0].key, 'task-42');
});

test('TaskUpdate flips status of the matching task', () => {
  const create = toolUse('TaskCreate', { subject: 'Fix auth bug' }, 'tc-1');
  const result = toolResult('tc-1', JSON.stringify({ id: 'task-42' }));
  const update = toolUse('TaskUpdate', {
    id: 'task-42',
    status: 'in_progress',
    activeForm: 'Fixing auth bug',
  }, 'tu-1');

  const items = buildSessionTodoList([create, result, update]);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'in_progress');
  assert.equal(items[0].primaryText, 'Fixing auth bug');

  const complete = toolUse('TaskUpdate', { id: 'task-42', status: 'completed' }, 'tu-2');
  const items2 = buildSessionTodoList([create, result, update, complete]);
  assert.equal(items2[0].status, 'completed');
});

test('TaskUpdate without a matching id is ignored', () => {
  const update = toolUse('TaskUpdate', { id: 'missing', status: 'completed' }, 'tu-1');
  const state = applyTodoMessage(EMPTY, update);
  assert.equal(state.items.length, 0);
});

test('Legacy tasks array shape still parses', () => {
  const items = parseLegacyTaskListItems({
    tasks: [
      { content: 'Old A', status: 'completed', activeForm: 'Old A' },
      { content: 'Old B', status: 'pending' },
    ],
  });
  assert.ok(items);
  assert.equal(items!.length, 2);
  assert.equal(items![0].status, 'completed');
});

test('parseTaskCreateItem requires subject/description/activeForm', () => {
  assert.equal(parseTaskCreateItem({}), null);
  assert.equal(parseTaskCreateItem({ subject: 'X' })?.primaryText, 'X');
  assert.equal(parseTaskCreateItem({ description: 'Y' })?.primaryText, 'Y');
  assert.equal(parseTaskCreateItem({ activeForm: 'Doing Z' })?.primaryText, 'Doing Z');
});

test('parseTaskUpdatePatch reads id and fields', () => {
  assert.equal(parseTaskUpdatePatch({ status: 'completed' }), null);
  const patch = parseTaskUpdatePatch({ id: 't1', status: 'completed', owner: 'alice' });
  assert.ok(patch);
  assert.equal(patch!.id, 't1');
  assert.equal(patch!.status, 'completed');
  assert.equal(patch!.owner, 'alice');
});

test('parseTodoWriteItems handles empty/unknown shapes', () => {
  assert.equal(parseTodoWriteItems(null), null);
  assert.equal(parseTodoWriteItems({}), null);
  assert.equal(parseTodoWriteItems({ todos: [] }), null);
});

test('extractTaskIdFromResult handles json and plain text', () => {
  assert.equal(extractTaskIdFromResult('{"id":"t-9"}'), 't-9');
  assert.equal(extractTaskIdFromResult('{"taskId":"t-8"}'), 't-8');
  assert.equal(extractTaskIdFromResult('{"task":{"id":"t-7"}}'), 't-7');
  assert.equal(extractTaskIdFromResult('Created task t-6 (task_id: t-6)'), 't-6');
  assert.equal(extractTaskIdFromResult('no id here'), null);
  assert.equal(extractTaskIdFromResult(''), null);
});

test('buildSessionTodoList replays a realistic multi-step session', () => {
  const messages: CoworkMessage[] = [
    toolUse('TaskCreate', { subject: 'Analyze codebase', description: 'Map modules', activeForm: 'Analyzing codebase' }, 'tc-1'),
    toolResult('tc-1', JSON.stringify({ id: 't1' })),
    toolUse('TaskCreate', { subject: 'Implement fix', description: 'Patch the bug', activeForm: 'Implementing fix' }, 'tc-2'),
    toolResult('tc-2', JSON.stringify({ id: 't2' })),
    toolUse('TaskUpdate', { id: 't1', status: 'in_progress', activeForm: 'Analyzing codebase' }, 'tu-1'),
    toolUse('TaskUpdate', { id: 't1', status: 'completed' }, 'tu-2'),
    toolUse('TaskUpdate', { id: 't2', status: 'in_progress', activeForm: 'Implementing fix' }, 'tu-3'),
  ];

  const items = buildSessionTodoList(messages);
  assert.equal(items.length, 2);
  assert.equal(items[0].status, 'completed');
  assert.equal(items[0].id, 't1');
  assert.equal(items[1].status, 'in_progress');
  assert.equal(items[1].id, 't2');
  assert.equal(items[1].primaryText, 'Implementing fix');
});
