import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore, getRow } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

function loadDreamServiceModule() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => process.cwd(),
        },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    const compiledRoot = require.resolve('../dist-electron/main/services/dreamService.js');
    return require(compiledRoot);
  } catch {
    return require('../dist-electron/services/dreamService.js');
  } finally {
    Module._load = originalLoad;
  }
}

const { DreamService } = loadDreamServiceModule();

const DAY = '2026-07-30';
const DAY_START = new Date(2026, 6, 30).getTime();

const seedActivity = (coworkStore, db) => {
  const session = coworkStore.createSession('和用户聊发布', '/tmp/a', '', 'local', [], 5);
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['m1', session.id, 'user', '视频做好了吗', '{}', DAY_START + 1000, 1]
  );
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['m2', session.id, 'assistant', '做好了,你看下', '{}', DAY_START + 2000, 2]
  );
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['m3', session.id, 'user', '太棒了,就是这个效果', '{}', DAY_START + 3000, 3]
  );
  return session;
};

const metabotStoreStub = () => ({
  listMetabots: () => [
    { id: 5, name: '小火', role: '视频创作者', soul: '认真严谨', llm_id: 'bot-own-llm', enabled: true },
  ],
});

const LONG_IDENTITY = `我是一个专注于视频创作的 MetaBot,名叫小火。${'我认真对待每一次交付,先验证再交付。'.repeat(10)}`;

const makePayload = (overrides = {}) => JSON.stringify({
  daily_summary: '今天为用户交付了演示视频,获得高度赞扬。',
  sections: { human: '和用户确认视频效果' },
  work_reviews: [
    { subject: '制作演示视频', counterparty: '用户', evaluation: 'warming', note: '用户从只回表情到主动追问细节' },
  ],
  important_memories: ['用户喜欢先验证再交付的节奏'],
  value_lessons: [{ rule: '交付前先自己验证一遍', source: '用户连续追问了两处细节' }],
  self_identity: LONG_IDENTITY,
  ...overrides,
});

const setup = async (performChat) => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const { DreamStore } = await import('../dist-electron/main/dreamStore.js').catch(() => import('../dist-electron/dreamStore.js'));
  const dreamStore = new DreamStore(db, () => {});
  seedActivity(coworkStore, db);
  const events = [];
  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    performChat,
    emitToRenderer: (channel, payload) => events.push({ channel, payload }),
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 1, 3, 0),
  });
  return { db, cleanup, coworkStore, dreamStore, service, events };
};

test('runNow completes the full dream pipeline and writes all artifacts', async () => {
  const calls = [];
  const { cleanup, coworkStore, dreamStore, service, events } = await setup(async (system, user, llmId, options) => {
    calls.push({ llmId, maxTokens: options?.maxTokens });
    return makePayload();
  });
  try {
    await service.runNow(5, DAY);

    const run = dreamStore.getRun(5, DAY);
    assert.equal(run.status, 'completed');
    assert.equal(run.llmId, 'bot-own-llm');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].maxTokens, 4096);

    const summary = dreamStore.getDailySummary(5, DAY);
    assert.equal(summary.summaryText, '今天为用户交付了演示视频,获得高度赞扬。');
    assert.equal(summary.sections.human, '和用户确认视频效果');
    assert.equal(summary.stats.sessionCount, 1);
    assert.equal(summary.stats.messageCount, 3);
    assert.equal(summary.sessionRefs.length, 1);
    assert.equal(summary.sessionRefs[0].title, '和用户聊发布');
    assert.equal(summary.sessionRefs[0].sessionType, 'standard');

    const dreamMemories = coworkStore.listUserMemories({
      metabotId: 5, scopeKind: 'owner', scopeKey: 'owner:self', origin: 'dream', status: 'all',
    });
    const byClass = (cls) => dreamMemories.filter((m) => m.usageClass === cls);
    assert.equal(byClass('profile_fact').length, 1);
    assert.equal(byClass('profile_fact')[0].text, '用户喜欢先验证再交付的节奏');
    assert.equal(byClass('work_review').length, 1);
    assert.ok(byClass('work_review')[0].text.includes('升温'));
    assert.equal(byClass('value_boundary').length, 1);
    assert.ok(byClass('value_boundary')[0].text.includes('交付前先自己验证一遍'));
    assert.ok(byClass('value_boundary')[0].text.includes('源自:'));
    assert.equal(byClass('value_boundary')[0].origin, 'dream');
    assert.equal(byClass('self_identity').length, 1);
    assert.equal(byClass('self_identity')[0].text, LONG_IDENTITY);
    assert.equal(byClass('self_identity')[0].origin, 'dream');

    // Protection still holds for dream-written identity entries.
    const identity = byClass('self_identity')[0];
    assert.equal(coworkStore.updateUserMemory({ id: identity.id, metabotId: 5, text: '篡改' }), null);

    // Dreaming status events bracket the run.
    assert.deepEqual(events, [
      { channel: 'metabot:dreamStatusChanged', payload: { metabotId: 5, dreaming: true } },
      { channel: 'metabot:dreamStatusChanged', payload: { metabotId: 5, dreaming: false } },
    ]);
    assert.equal(service.isDreaming(5), false);
  } finally {
    cleanup();
  }
});

test('empty day completes without calling the LLM or writing a summary', async () => {
  let calls = 0;
  const { cleanup, dreamStore, service } = await setup(async () => {
    calls += 1;
    return makePayload();
  });
  try {
    await service.runNow(5, '2026-07-29');
    assert.equal(calls, 0);
    assert.equal(dreamStore.getRun(5, '2026-07-29').status, 'completed');
    assert.equal(dreamStore.getDailySummary(5, '2026-07-29'), null);
  } finally {
    cleanup();
  }
});

test('unparseable output retries once then fails the run, not the service', async () => {
  let calls = 0;
  const { cleanup, dreamStore, service } = await setup(async () => {
    calls += 1;
    return '这不是 JSON';
  });
  try {
    await service.runNow(5, DAY);
    assert.equal(calls, 2, 'one fix-up retry');
    const run = dreamStore.getRun(5, DAY);
    assert.equal(run.status, 'failed');
    assert.ok(run.error?.includes('unparseable'));
  } finally {
    cleanup();
  }
});

test('short self_identity triggers one expansion retry and keeps the long version', async () => {
  const seen = [];
  const { cleanup, coworkStore, service } = await setup(async (system, user) => {
    seen.push(user);
    return seen.length === 1 ? makePayload({ self_identity: '太短' }) : makePayload();
  });
  try {
    await service.runNow(5, DAY);
    assert.equal(seen.length, 2);
    assert.ok(seen[1].includes('不少于 200'));

    const identities = coworkStore.listUserMemories({
      metabotId: 5, scopeKind: 'owner', scopeKey: 'owner:self', usageClass: 'self_identity', status: 'all',
    });
    assert.equal(identities.length, 1);
    assert.equal(identities[0].text, LONG_IDENTITY);
  } finally {
    cleanup();
  }
});

test('re-dreaming the same date updates the single self_identity entry in place', async () => {
  const { cleanup, coworkStore, dreamStore, service } = await setup(async () => makePayload());
  try {
    await service.runNow(5, DAY);
    await service.runNow(5, DAY);

    const identities = coworkStore.listUserMemories({
      metabotId: 5, scopeKind: 'owner', scopeKey: 'owner:self', usageClass: 'self_identity', status: 'all',
    });
    assert.equal(identities.length, 1, 'still exactly one identity entry');

    const run = dreamStore.getRun(5, DAY);
    assert.equal(run.status, 'completed');
    assert.equal(run.attemptCount, 2);
  } finally {
    cleanup();
  }
});

test('global dreamLlmId override wins over the bot own llm_id', async () => {
  const seen = [];
  const ctx = await setup(async (system, user, llmId) => {
    seen.push(llmId);
    return makePayload();
  });
  try {
    ctx.db.run(
      `INSERT INTO cowork_config (key, value, updated_at) VALUES ('dreamLlmId', 'cheap-global-llm', 1)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );
    await ctx.service.runNow(5, DAY);
    assert.deepEqual(seen, ['cheap-global-llm']);
  } finally {
    ctx.cleanup();
  }
});
