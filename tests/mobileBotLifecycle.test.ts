import assert from 'node:assert/strict';
import test from 'node:test';
import { createMobileMockBridge } from '../src/mobile/bridge/mockBridge.ts';
import type { MobileMetabot } from '../src/mobile/bridge/types.ts';

function makeBridge(t: test.TestContext) {
  const bridge = createMobileMockBridge({ streamTokenIntervalMs: 1, systemLocale: 'en-US' });
  t.after(() => bridge.destroy());
  return bridge.electron;
}

test('on-chain creation persists the selected brain and per-Bot skills with a confirmed chain state', async (t) => {
  const api = makeBridge(t);
  const result = await api.idbots.createMetaBotOnChain({
    name: 'Worker WP3',
    metabot_type: 'worker',
    role: 'Research worker',
    soul: 'Careful and concise',
    bio: 'WP3 fixture',
    llm_id: 'glm-flash',
    llm_provider: 'metaid-free',
    llm_effort: 'high',
    allow_chat_skills: ['web-search', 'memory'],
  });
  assert.equal(result.success, true);
  assert.equal(result.chainSetupPending, undefined);
  const bot = result.metabot as MobileMetabot;
  assert.equal(bot.llm_id, 'glm-flash');
  assert.equal(bot.llm_provider, 'metaid-free');
  assert.equal(bot.llm_effort, 'high');
  assert.deepEqual(bot.allow_chat_skills, ['web-search', 'memory']);
  assert.equal(bot.chain_sync_state, 'synced');
  assert.equal(bot.subsidy_state, 'claimed');

  const listed = await api.metabot.list();
  assert.ok(listed.list.some((entry) => entry.id === bot.id && entry.metabot_info_pinid));
  const balance = await api.idbots.getAddressBalance({ metabotId: bot.id });
  assert.equal(balance.success, true);
  assert.equal(balance.balance.mvc.unit, 'MVC');
});

test('a Bot default-brain update affects the next session without rebinding an existing session', async (t) => {
  const api = makeBridge(t);
  const existing = await api.cowork.startSession({
    prompt: 'existing session',
    metabotId: 2,
    model: 'session-owned-model',
    modelProvider: 'session-owned-provider',
  });
  assert.equal(existing.success, true);

  const updated = await api.metabot.update(2, {
    role: 'Updated worker',
    llm_id: 'glm-flash',
    llm_provider: 'metaid-free',
    llm_effort: 'low',
    allow_chat_skills: ['memory'],
  });
  assert.equal(updated.success, true);
  assert.equal(updated.sync.success, true);

  const next = await api.cowork.startSession({ prompt: 'next session', metabotId: 2 });
  assert.equal(next.session.model, 'glm-flash');
  assert.equal(next.session.modelProvider, 'metaid-free');
  assert.equal(next.session.metabotId, 2);

  const reopened = await api.cowork.getSession(existing.session.id);
  assert.equal(reopened.session.model, 'session-owned-model');
  assert.equal(reopened.session.modelProvider, 'session-owned-provider');
  const bot = await api.metabot.get(2);
  assert.equal(bot.metabot.role, 'Updated worker');
  assert.equal(bot.metabot.llm_effort, 'low');
  assert.deepEqual(bot.metabot.allow_chat_skills, ['memory']);
});

test('local pending Bots resume and full-sync through the existing lifecycle channels', async (t) => {
  const api = makeBridge(t);
  const local = await api.metabot.create({
    name: 'Pending worker',
    metabot_type: 'worker',
    role: 'Pending',
    soul: 'Pending',
    llm_id: 'deepseek-flash',
    llm_provider: 'metaid-free',
  });
  assert.equal(local.success, true);
  const id = local.metabot.id;
  assert.equal((local.metabot as MobileMetabot).chain_sync_state, 'partial');

  const resumed = await api.idbots.resumeMetabotSetup({ metabotId: id, mode: 'self-funded' });
  assert.equal(resumed.success, true);
  assert.equal((resumed.metabot as MobileMetabot).chain_sync_state, 'synced');

  const second = await api.metabot.create({
    name: 'Second pending worker',
    metabot_type: 'worker',
    role: 'Pending',
    soul: 'Pending',
    llm_id: 'deepseek-flash',
  });
  const synced = await api.idbots.syncMetaBot(second.metabot.id);
  assert.equal(synced.success, true);
  const enabled = await api.metabot.setEnabled(second.metabot.id, false);
  assert.equal(enabled.success, true);
  assert.equal(enabled.metabot.enabled, false);
});

test('the fallback brain (fallback_llm triad) persists through create, update and clear', async (t) => {
  const api = makeBridge(t);
  const result = await api.idbots.createMetaBotOnChain({
    name: 'Fallback worker',
    metabot_type: 'worker',
    role: 'Runner',
    soul: 'Runs things',
    bio: 'Fallback triad fixture',
    llm_id: 'glm-flash',
    llm_provider: 'metaid-free',
    llm_effort: 'low',
    fallback_llm_id: 'deepseek-flash',
    fallback_llm_provider: 'metaid-free',
    fallback_llm_effort: 'high',
    allow_chat_skills: [],
  });
  assert.equal(result.success, true);
  const bot = result.metabot as MobileMetabot;
  assert.equal(bot.fallback_llm_id, 'deepseek-flash');
  assert.equal(bot.fallback_llm_provider, 'metaid-free');
  assert.equal(bot.fallback_llm_effort, 'high');

  const cleared = await api.metabot.update(bot.id, {
    fallback_llm_id: null,
    fallback_llm_provider: null,
    fallback_llm_effort: null,
  });
  assert.equal(cleared.success, true);
  const updated = cleared.metabot as MobileMetabot;
  assert.equal(updated.fallback_llm_id ?? null, null);
  assert.equal(updated.fallback_llm_provider ?? null, null);
  assert.equal(updated.fallback_llm_effort ?? null, null);
});
