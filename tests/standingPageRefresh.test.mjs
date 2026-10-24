import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

function loadCompiled(modulePath) {
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
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

const {
  sampleStandingPageScope,
  buildStandingPageRefreshPrompt,
  parseStandingPageRefreshOutput,
} = loadCompiled('../dist-electron/main/libs/standingPageRefresh.js');
const { StandingPageStore } = loadCompiled('../dist-electron/main/standingPageStore.js');
const { MemoryHygieneService } = loadCompiled('../dist-electron/main/services/memoryHygieneService.js');

const insertMetabot = (db, id) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key,
      chat_public_key, name, metaid, globalmetaid, metabot_type, created_by,
      role, soul, created_at, updated_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'worker', 'test', 'role', 'soul', 1, 1)`,
    [id, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `pub-${id}`, `chatpub-${id}`, `Bot ${id}`, `metaid-${id}`, `metaid://stub-owner`]
  );
};

const OWNER = { scopeKind: 'owner', scopeKey: 'owner:self' };

const seedFacts = (store, texts) => texts.map((text) => store.createUserMemory({
  metabotId: 9,
  text,
  ...OWNER,
  usageClass: 'profile_fact',
  origin: 'conversation',
  isExplicit: true,
  forceNew: true,
  source: { role: 'user', sourceType: 'turn_explicit', quote: `「${text}」的原始对话` },
}));

test('scope samplers: sediment gates, evidence quotes, fingerprint sensitivity', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    insertMetabot(db, 9);
    const coworkStore = createCoworkStore(db);
    seedFacts(coworkStore, [
      '用户是独立开发者,做 AI 工具',
      '用户偏好中文交流',
      '用户的工作时区是上海',
    ]);
    const stores = { coworkStore, dreamStore: null, knowledgeStore: null };

    assert.equal(sampleStandingPageScope(stores, 9, 'owner_profile'), null, '3 facts < minTotal 4');

    seedFacts(coworkStore, ['用户喜欢先验证再交付']);
    const first = sampleStandingPageScope(stores, 9, 'owner_profile');
    assert.ok(first);
    assert.equal(first.lines.length, 4);
    // Lines are recency-ordered (newest fact first) — match, don't assume position.
    const identityLine = first.lines.find((line) => line.includes('用户是独立开发者')) ?? '';
    assert.match(identityLine, /^- \[profile_fact\|proof=1\] /);
    assert.ok(identityLine.includes('引文:'), 'the evidence quote rides the line');

    // A corroborating restatement (new source row, same wording) changes proof → new fingerprint.
    coworkStore.createUserMemory({
      metabotId: 9,
      text: '用户是独立开发者,做 AI 工具',
      ...OWNER,
      source: { role: 'user', sourceType: 'turn_llm', quote: '再次提到自己在做 AI 工具' },
    });
    const second = sampleStandingPageScope(stores, 9, 'owner_profile');
    assert.notEqual(second.fingerprint, first.fingerprint);
    assert.match(second.lines.find((line) => line.includes('用户是独立开发者')) ?? '', /proof=2/, 'corroboration raises the proof count on the line');

    assert.equal(sampleStandingPageScope(stores, 9, 'work_threads'), null, 'no dream store → no summaries → null');
    assert.equal(sampleStandingPageScope(stores, 9, 'playbook'), null, 'no knowledge store → null');
  } finally {
    cleanup();
  }
});

test('refresh prompt distinguishes first build from surgical refresh; parser is tolerant', () => {
  const initial = buildStandingPageRefreshPrompt({
    botName: 'Twin', pageName: 'Owner profile',
    question: 'Who is my owner?',
    sections: [],
    lines: ['- [profile_fact|proof=1] 用户是独立开发者'],
  });
  assert.ok(initial.includes('The page is empty: write the full first version.'));
  assert.ok(!initial.includes('KEPT AUTOMATICALLY'));
  assert.ok(initial.includes('{"operations":'));

  const refresh = buildStandingPageRefreshPrompt({
    botName: 'Twin', pageName: 'Owner profile',
    question: 'Who is my owner?',
    sections: [{ key: 'identity', title: 'Identity', body: 'x' }, { key: 'style', title: 'Style', body: 'y' }],
    lines: ['- [profile_fact|proof=1] 用户是独立开发者'],
  });
  assert.ok(refresh.includes('KEPT AUTOMATICALLY'));
  assert.ok(refresh.includes('- identity | Identity'));
  assert.ok(refresh.includes('- style | Style'));

  const parsed = parseStandingPageRefreshOutput('```json\n' + JSON.stringify({
    operations: [
      { action: 'upsert', key: 'style', title: 'Working style', body: 'Validates before delivering.' },
      { action: 'delete', key: 'gone' },
      { action: 'upsert', key: '  ', title: 'no key', body: 'dropped' },
      { action: 'bogus', key: 'x', title: 't', body: 'b' },
      'not-an-object',
    ],
    notes: 'one upsert one delete',
  }) + '\n```');
  assert.deepEqual(parsed?.operations, [
    { action: 'upsert', key: 'style', title: 'Working style', body: 'Validates before delivering.' },
    { action: 'delete', key: 'gone' },
  ]);
  assert.deepEqual(parseStandingPageRefreshOutput(JSON.stringify({ operations: [], notes: '' })).operations, [], 'empty operations parse');
  assert.equal(parseStandingPageRefreshOutput('Let me think about this carefully without any JSON.'), null);
});

test('hygiene step builds once, skips fresh scopes, refreshes surgically, retries after unparseable output', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    insertMetabot(db, 9);
    const coworkStore = createCoworkStore(db);
    const standingPages = new StandingPageStore(db, () => {});
    seedFacts(coworkStore, [
      '用户是独立开发者,做 AI 工具',
      '用户偏好中文交流',
      '用户的工作时区是上海',
      '用户喜欢先验证再交付',
    ]);

    const calls = [];
    let respondWith = () => JSON.stringify({
      operations: [
        { action: 'upsert', key: 'identity', title: '身份与工作', body: '独立开发者,做 AI 工具,上海时区。' },
        { action: 'upsert', key: 'style', title: '协作风格', body: '先验证再交付,偏好中文。' },
      ],
      notes: 'initial',
    });
    const service = new MemoryHygieneService({
      coworkStore,
      metabotStore: { listMetabots: () => [{ id: 9, name: 'Twin', llm_id: null, globalmetaid: 'metaid://stub-owner' }] },
      standingPageStore: standingPages,
      performChat: async (_system, user, _llmId, options) => {
        calls.push({ user, options });
        return respondWith();
      },
      now: () => new Date(2026, 9, 24, 10, 0),
    });

    // Run 1: initial build of owner_profile; work_threads + playbook lack sediment.
    const first = await service.runNow();
    assert.equal(first.counts.standingPagesBuilt, 1, 'owner_profile initial build');
    assert.equal(first.counts.standingPagesNoSediment, 2, 'work_threads (no dream store) + playbook (no knowledge)');
    assert.equal(first.counts.standingPagesFreshSkipped, 0);
    assert.equal(calls.length, 1, 'one LLM call — unchanged/unsampled pages cost nothing');
    const page = standingPages.getStandingPage(9, 'owner_profile');
    assert.equal(page.sections.length, 2);
    assert.ok(page.content.includes('## 身份与工作'));
    assert.ok(calls[0].options.webSearch === false && calls[0].options.thinking === 'disabled');

    // Run 2: scope unchanged → zero LLM calls.
    const second = await service.runNow();
    assert.equal(second.counts.standingPagesFreshSkipped, 1);
    assert.equal(second.counts.standingPagesBuilt + second.counts.standingPagesRefreshed, 0);
    assert.equal(calls.length, 1, 'fresh fingerprint = no tokens spent');

    // Run 3: new fact lands → surgical refresh touching one section only.
    seedFacts(coworkStore, ['用户养了一只叫 Pixel 的猫']);
    respondWith = () => JSON.stringify({
      operations: [{ action: 'upsert', key: 'identity', title: '身份与工作', body: '独立开发者,做 AI 工具,上海时区,养猫一只(Pixel)。' }],
      notes: 'absorbed the new fact',
    });
    const third = await service.runNow();
    assert.equal(third.counts.standingPagesRefreshed, 1);
    assert.equal(calls.length, 2);
    const refreshed = standingPages.getStandingPage(9, 'owner_profile');
    assert.equal(refreshed.sections.find((section) => section.key === 'style').body, '先验证再交付,偏好中文。', 'untouched section survives verbatim');
    const revisions = standingPages.listPageRevisions(refreshed.id);
    assert.equal(revisions.length, 2, 'the initial build also records a revision (empty -> content)');
    assert.equal(revisions[0].reason, 'scope_refresh');
    assert.equal(revisions[1].reason, 'initial');

    // Run 4: unparseable output → error on the row, page untouched; run 5 recovers.
    seedFacts(coworkStore, ['用户的项目代号是 Loom']);
    respondWith = () => '我觉得这页不需要改动,就保持现状吧。';
    const fourth = await service.runNow();
    assert.equal(fourth.counts.standingPagesRefreshed, 0);
    assert.ok(standingPages.getStandingPage(9, 'owner_profile').lastRefreshError.includes('unparseable'));
    assert.equal(standingPages.getStandingPage(9, 'owner_profile').sections.find((section) => section.key === 'identity').body.includes('Pixel'), true, 'failed refresh never damages the page');

    respondWith = () => JSON.stringify({ operations: [], notes: 'nothing needs changing' });
    const fifth = await service.runNow();
    assert.equal(fifth.counts.standingPagesRefreshed + fifth.counts.standingPagesBuilt, 1, 'recovery run commits (a no-op refresh still stamps the fingerprint)');
    assert.equal(standingPages.getStandingPage(9, 'owner_profile').lastRefreshError, null, 'a clean commit clears the error');
  } finally {
    cleanup();
  }
});
