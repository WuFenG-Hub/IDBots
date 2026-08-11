import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyTodoMessage,
  buildSessionTodoList,
  extractTaskIdFromResult,
  getTodoSummary,
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

test('extractTaskIdFromResult parses the SDK plain-text TaskCreate result', () => {
  // Real Claude Agent SDK (0.3.x) TaskCreate result format.
  assert.equal(
    extractTaskIdFromResult('Task #1 created successfully: 创建任务拆解清单，验证任务列表面板显示'),
    '1'
  );
  assert.equal(
    extractTaskIdFromResult('Task #42 created successfully: Fix auth bug'),
    '42'
  );
  // Alphanumeric ids are covered by the SDK's own `Task #(\S+) created successfully` pattern.
  assert.equal(
    extractTaskIdFromResult('Task #t-7 created successfully: any subject'),
    't-7'
  );
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

test('real SDK session: TaskCreate text results + TaskUpdate by taskId stay in sync', () => {
  // Mirrors the 2026-08-11 bug reproduction: the SDK returns TaskCreate
  // results as plain text (`Task #N created successfully: <subject>`) and
  // TaskUpdate inputs carry `taskId`. Before the fix the created tasks kept a
  // null id, TaskUpdate could never pair, and the panel stuck at 0/3.
  const create1 = toolUse('TaskCreate', {
    subject: '创建任务拆解清单，验证任务列表面板显示',
    description: '验收任务列表功能的第一步',
    activeForm: '正在创建任务拆解清单',
  }, 'call-1');
  const result1 = toolResult('call-1', 'Task #1 created successfully: 创建任务拆解清单，验证任务列表面板显示');
  const create2 = toolUse('TaskCreate', {
    subject: '执行子任务：查询今日链上社区动态',
    activeForm: '正在查询链上社区动态',
  }, 'call-2');
  const result2 = toolResult('call-2', 'Task #2 created successfully: 执行子任务：查询今日链上社区动态');
  const create3 = toolUse('TaskCreate', {
    subject: '汇总验收结果并收尾',
    activeForm: '正在汇总验收结果',
  }, 'call-3');
  const result3 = toolResult('call-3', 'Task #3 created successfully: 汇总验收结果并收尾');

  // Task 1: pending -> in_progress -> completed
  const upd1a = toolUse('TaskUpdate', { taskId: '1', status: 'in_progress' }, 'upd-1a');
  const upd1b = toolUse('TaskUpdate', { taskId: '1', status: 'completed' }, 'upd-1b');
  // Task 2: pending -> in_progress
  const upd2a = toolUse('TaskUpdate', { taskId: '2', status: 'in_progress' }, 'upd-2a');

  let items = buildSessionTodoList([create1, result1, create2, result2, create3, result3]);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((item) => item.id), ['1', '2', '3']);
  assert.ok(items.every((item) => item.status === 'pending'));

  // After completing 1 of 3, the panel summary must read 1/3 (not 0/3).
  items = buildSessionTodoList([create1, result1, create2, result2, create3, result3, upd1a, upd1b]);
  assert.equal(items[0].status, 'completed');
  assert.equal(items[1].status, 'pending');
  const afterOne = getTodoSummary(items);
  assert.equal(afterOne.completed, 1);
  assert.equal(afterOne.total, 3);

  // One more in_progress: completed 1, in_progress 1.
  items = buildSessionTodoList([create1, result1, create2, result2, create3, result3, upd1a, upd1b, upd2a]);
  assert.equal(items[1].status, 'in_progress');
  const afterTwo = getTodoSummary(items);
  assert.equal(afterTwo.completed, 1);
  assert.equal(afterTwo.inProgress, 1);
});
