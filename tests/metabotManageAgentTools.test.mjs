import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { buildMetabotManageAgentTools } = require('../dist-electron/main/libs/metabotManageAgentTools.js');

/**
 * Build the 4 tools against a mock control and return them keyed by name.
 * The mock `tool` factory captures each tool's handler so tests can invoke it
 * directly and assert on the returned text content.
 */
function makeHarness(controlOverrides = {}) {
  const calls = { create: [], update: [], delete: [], list: 0, listProviders: 0 };
  const control = {
    create: async (input) => {
      calls.create.push(input);
      return (
        controlOverrides.createResult ?? {
          success: true,
          metabot: {
            id: 42,
            name: input.name,
            metabot_type: 'worker',
            llm_id: input.llm_id,
            globalmetaid: 'gmid-42',
          },
        }
      );
    },
    update: async (id, input) => {
      calls.update.push({ id, input });
      return (
        controlOverrides.updateResult ?? {
          success: true,
          metabot: { id, name: input.name ?? 'Worker', metabot_type: 'worker' },
          sync: { skipped: false, success: true, txids: ['tx-1'] },
        }
      );
    },
    delete: async (id) => {
      calls.delete.push(id);
      return controlOverrides.deleteResult ?? { success: true };
    },
    list: () => {
      calls.list += 1;
      return (
        controlOverrides.listResult ?? [
          {
            id: 1,
            name: 'Alice',
            type: 'twin',
            enabled: true,
            llm_id: 'deepseek',
            fallback_llm_id: null,
            role: 'Boss',
            bio: null,
            goal: null,
            allow_chat_skills: [],
            a2a_max_incoming_turns: null,
            a2a_bye_cooldown_ms: null,
            a2a_auto_reply_enabled: null,
            globalMetaID: 'gmid-alice',
          },
        ]
      );
    },
    listProviders: () => {
      calls.listProviders += 1;
      return controlOverrides.providersResult ?? [
        { id: 'deepseek', label: 'Deepseek' },
        { id: 'openai', label: 'Openai' },
      ];
    },
    ...controlOverrides.control,
  };
  const tools = buildMetabotManageAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    control,
  });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { calls, byName };
}

const textOf = (result) => result.content[0].text;

test('builds the four metabot_manage tools', () => {
  const { byName } = makeHarness();
  assert.ok(byName.metabot_list, 'metabot_list tool must exist');
  assert.ok(byName.metabot_create, 'metabot_create tool must exist');
  assert.ok(byName.metabot_update, 'metabot_update tool must exist');
  assert.ok(byName.metabot_delete, 'metabot_delete tool must exist');
});

// ---------------------------------------------------------------------------
// metabot_list
// ---------------------------------------------------------------------------

test('metabot_list: returns bot lines plus the provider list', async () => {
  const { byName, calls } = makeHarness();
  const res = await byName.metabot_list.handler({});
  assert.equal(res.isError, undefined);
  const text = textOf(res);
  assert.match(text, /Alice/);
  assert.match(text, /id=1/);
  assert.match(text, /twin/);
  assert.match(text, /deepseek/);
  assert.match(text, /Available LLM providers/);
  assert.equal(calls.list, 1);
  assert.equal(calls.listProviders, 1);
});

test('metabot_list: reports when no providers are configured', async () => {
  const { byName } = makeHarness({ providersResult: [] });
  const text = textOf(await byName.metabot_list.handler({}));
  assert.match(text, /NONE/);
});

// ---------------------------------------------------------------------------
// metabot_create
// ---------------------------------------------------------------------------

test('metabot_create: success reports the new bot id and on-chain id', async () => {
  const { byName, calls } = makeHarness();
  const res = await byName.metabot_create.handler({ name: 'Bob', llm_id: 'deepseek' });
  assert.equal(res.isError, undefined);
  const text = textOf(res);
  assert.match(text, /MetaBot created: Bob/);
  assert.match(text, /id=42/);
  assert.match(text, /gmid-42/);
  assert.deepEqual(calls.create[0], {
    name: 'Bob',
    llm_id: 'deepseek',
    fallback_llm_id: null,
    role: undefined,
    soul: undefined,
    goal: undefined,
    bio: undefined,
    avatar: undefined,
  });
});

test('metabot_create: empty name is rejected', async () => {
  const { byName } = makeHarness();
  const res = await byName.metabot_create.handler({ name: '   ', llm_id: 'deepseek' });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /non-empty `name`/);
});

test('metabot_create: missing llm_id surfaces the available providers', async () => {
  const { byName } = makeHarness();
  const res = await byName.metabot_create.handler({ name: 'Bob', llm_id: '' });
  assert.equal(res.isError, true);
  const text = textOf(res);
  assert.match(text, /requires an `llm_id`/);
  assert.match(text, /deepseek/); // provider list included
});

test('metabot_create: partial publish is surfaced, not treated as failure', async () => {
  const { byName } = makeHarness({
    createResult: {
      success: true,
      metabot: { id: 7, name: 'Cy', metabot_type: 'worker', llm_id: 'openai', globalmetaid: 'g' },
      chainPartial: true,
      chainError: 'avatar pin failed',
    },
  });
  const res = await byName.metabot_create.handler({ name: 'Cy', llm_id: 'openai' });
  // success:true at the core, but the tool must warn about the partial publish.
  assert.equal(res.isError, undefined);
  assert.match(textOf(res), /partial/);
});

test('metabot_create: core failure is an error result', async () => {
  const { byName } = makeHarness({ createResult: { success: false, error: 'boom' } });
  const res = await byName.metabot_create.handler({ name: 'X', llm_id: 'openai' });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /boom/);
});

// ---------------------------------------------------------------------------
// metabot_update
// ---------------------------------------------------------------------------

test('metabot_update: forwards only provided fields and reports on-chain sync', async () => {
  const { byName, calls } = makeHarness();
  const res = await byName.metabot_update.handler({ metabot_id: 5, name: 'Renamed', role: 'Dev' });
  assert.equal(res.isError, undefined);
  assert.equal(calls.update[0].id, 5);
  assert.deepEqual(calls.update[0].input, { name: 'Renamed', role: 'Dev' });
  assert.match(textOf(res), /published the change on-chain/);
});

test('metabot_update: local-only change reports no on-chain sync needed', async () => {
  const { byName } = makeHarness({
    updateResult: {
      success: true,
      metabot: { id: 5, name: 'W', metabot_type: 'worker' },
      sync: { skipped: true, success: true },
    },
  });
  const res = await byName.metabot_update.handler({ metabot_id: 5, enabled: false });
  assert.match(textOf(res), /applied locally/);
});

test('metabot_update: no editable fields is rejected', async () => {
  const { byName } = makeHarness();
  const res = await byName.metabot_update.handler({ metabot_id: 5 });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /no fields to change/);
});

test('metabot_update: invalid metabot_id is rejected', async () => {
  const { byName } = makeHarness();
  const res = await byName.metabot_update.handler({ metabot_id: -3, name: 'X' });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /positive integer `metabot_id`/);
});

test('metabot_update: chain sync failure is surfaced but local write kept', async () => {
  const { byName } = makeHarness({
    updateResult: {
      success: true,
      metabot: { id: 5, name: 'W', metabot_type: 'worker' },
      sync: { skipped: false, success: false, canSkip: false, error: 'pin timeout' },
    },
  });
  const res = await byName.metabot_update.handler({ metabot_id: 5, name: 'W2' });
  // success:true overall (local write ok), but text warns about the failed sync.
  assert.equal(res.isError, undefined);
  assert.match(textOf(res), /pin timeout/);
});

// ---------------------------------------------------------------------------
// metabot_delete
// ---------------------------------------------------------------------------

test('metabot_delete: success confirms and mentions Twin transfer possibility', async () => {
  const { byName, calls } = makeHarness();
  const res = await byName.metabot_delete.handler({ metabot_id: 9 });
  assert.equal(res.isError, undefined);
  assert.equal(calls.delete[0], 9);
  assert.match(textOf(res), /id=9/);
  assert.match(textOf(res), /Twin status was transferred/);
});

test('metabot_delete: last-bot guard error is surfaced', async () => {
  const { byName } = makeHarness({
    deleteResult: { success: false, error: 'Cannot delete the last remaining MetaBot.' },
  });
  const res = await byName.metabot_delete.handler({ metabot_id: 9 });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /last remaining MetaBot/);
});

test('metabot_delete: invalid id is rejected', async () => {
  const { byName } = makeHarness();
  const res = await byName.metabot_delete.handler({ metabot_id: 0 });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /positive integer `metabot_id`/);
});
