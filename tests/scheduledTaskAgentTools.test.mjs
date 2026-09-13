import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildScheduledTaskAgentTools, SURF_SCHEDULED_TASK_CAP } = require('../dist-electron/main/libs/scheduledTaskAgentTools.js');

const SESSION_ID = 'sess-surf-1';
const METABOT_ID = 7;

const futureLocalDatetime = () => {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

function makeHarness(overrides = {}) {
  const calls = [];
  const control = {
    createTask: (input) => {
      calls.push(input);
      if (overrides.createError) throw overrides.createError;
      return { id: `task-${calls.length}`, name: input.name, nextRunAtMs: overrides.nextRunAtMs ?? (Date.now() + 3600_000) };
    },
  };
  const surfState = 'surfState' in overrides
    ? overrides.surfState
    : { interactionBudget: 20, kbBudget: 40 };
  const tools = buildScheduledTaskAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    control,
    sessionId: SESSION_ID,
    resolveMetabotId: () => ('metabotId' in overrides ? overrides.metabotId : METABOT_ID),
    surfState,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName, surfState };
}

const validArgs = (overrides = {}) => ({
  name: 'Build the Pac-Man game',
  prompt: 'Build a Pac-Man clone as a single-file HTML MetaApp, publish it, then reply DONE under pin X.',
  scheduleType: 'at',
  at: futureLocalDatetime(),
  ...overrides,
});

test('registers create_scheduled_task', () => {
  const { byName } = makeHarness();
  assert.deepEqual(Object.keys(byName), ['create_scheduled_task']);
});

test('creates an "at" task, binds the session metabot, and records the receipt on the marker', async () => {
  const { calls, byName, surfState } = makeHarness();
  const result = await byName.create_scheduled_task.handler(validArgs());
  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].metabotId, METABOT_ID);
  assert.equal(calls[0].schedule.type, 'at');
  assert.match(result.content[0].text, /Scheduled task created/);
  assert.match(result.content[0].text, /task-1/);
  assert.equal(surfState.tasksScheduled, 1);
  assert.deepEqual(surfState.scheduledTaskIds, ['task-1']);
});

test('the per-run cap is a hard ceiling on the session marker (survives surface rebuilds)', async () => {
  const marker = { interactionBudget: 20, kbBudget: 40, tasksScheduled: SURF_SCHEDULED_TASK_CAP, scheduledTaskIds: ['task-x', 'task-y'] };
  const { calls, byName } = makeHarness({ surfState: marker });
  const result = await byName.create_scheduled_task.handler(validArgs());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /budget exhausted/);
  assert.equal(calls.length, 0);
  assert.equal(marker.tasksScheduled, SURF_SCHEDULED_TASK_CAP);
});

test('a failed host create does NOT spend the task budget', async () => {
  const { byName, surfState } = makeHarness({ createError: new Error('schedule never fires') });
  const result = await byName.create_scheduled_task.handler(validArgs());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /schedule never fires/);
  assert.equal(surfState.tasksScheduled ?? 0, 0);
  assert.equal((surfState.scheduledTaskIds ?? []).length, 0);
});

test('rejects a past "at" datetime before the host is touched', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.create_scheduled_task.handler(validArgs({ at: '2020-01-01T09:00:00' }));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /in the past/);
  assert.equal(calls.length, 0);
});

test('rejects an unparsable "at" datetime with format guidance', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.create_scheduled_task.handler(validArgs({ at: 'tomorrow morning' }));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Could not parse/);
  assert.equal(calls.length, 0);
});

test('rejects "at" without the at field, and cron without an expression', async () => {
  const { byName } = makeHarness();
  const noAt = await byName.create_scheduled_task.handler(validArgs({ at: undefined }));
  assert.equal(noAt.isError, true);
  assert.match(noAt.content[0].text, /needs the `at` field/);
  const noCron = await byName.create_scheduled_task.handler(validArgs({ scheduleType: 'cron', at: undefined }));
  assert.equal(noCron.isError, true);
  assert.match(noCron.content[0].text, /needs the `cron` field/);
});

test('normalizes an interval schedule to intervalMs', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.create_scheduled_task.handler(
    validArgs({ scheduleType: 'interval', at: undefined, intervalValue: 2, intervalUnit: 'hours' }),
  );
  assert.equal(result.isError, undefined);
  assert.equal(calls[0].schedule.type, 'interval');
  assert.equal(calls[0].schedule.intervalMs, 2 * 60 * 60 * 1000);
});

test('rejects a non-positive interval value', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.create_scheduled_task.handler(
    validArgs({ scheduleType: 'interval', at: undefined, intervalValue: 0, intervalUnit: 'hours' }),
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /positive integer/);
  assert.equal(calls.length, 0);
});

test('refuses unattributed sessions without guessing a bot', async () => {
  const { calls, byName } = makeHarness({ metabotId: undefined });
  const result = await byName.create_scheduled_task.handler(validArgs());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not bound to a MetaBot/);
  assert.equal(calls.length, 0);
});

test('enforces the name and prompt length caps', async () => {
  const { calls, byName } = makeHarness();
  const longName = await byName.create_scheduled_task.handler(validArgs({ name: 'n'.repeat(81) }));
  assert.equal(longName.isError, true);
  assert.match(longName.content[0].text, /80-char cap/);
  const longPrompt = await byName.create_scheduled_task.handler(validArgs({ prompt: 'p'.repeat(4001) }));
  assert.equal(longPrompt.isError, true);
  assert.match(longPrompt.content[0].text, /4000-char cap/);
  assert.equal(calls.length, 0);
});

test('without a surf marker there is no cap bookkeeping (defensive path)', async () => {
  const { byName } = makeHarness({ surfState: undefined });
  const result = await byName.create_scheduled_task.handler(validArgs());
  assert.equal(result.isError, undefined);
  assert.doesNotMatch(result.content[0].text, /Tasks remaining/);
});
