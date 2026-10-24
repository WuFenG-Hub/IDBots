import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createSqliteStore } from './memoryTestUtils.mjs';

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
  StandingPageStore,
  applyStandingSectionOperations,
  normalizeStandingSection,
  normalizeStandingSectionKey,
  renderStandingPageMarkdown,
  STANDING_PAGE_MAX_SECTIONS,
  STANDING_PAGE_REVISIONS_KEEP,
  STANDING_PAGE_MAX_CUSTOM_PER_BOT,
} = loadCompiled('../dist-electron/main/standingPageStore.js');

const createStore = async () => {
  const { db, cleanup } = await createSqliteStore();
  return { db, cleanup, store: new StandingPageStore(db, () => {}) };
};

test('section helpers: slug keys, clipping caps, markdown rendering', () => {
  assert.equal(normalizeStandingSectionKey('Owner Profile & Style'), 'owner-profile-style');
  assert.match(normalizeStandingSectionKey('---'), /^s-[0-9a-f]{8}$/, 'degenerate keys fall back to a stable hash');
  assert.match(normalizeStandingSectionKey('中文键'), /^s-[0-9a-f]{8}$/, 'non-ascii keys fall back to a stable hash');

  const section = normalizeStandingSection({
    key: 'preferences',
    title: `P${'r'.repeat(200)}`,
    body: `B${'o'.repeat(1000)}`,
  });
  assert.equal(section.title.length, 80);
  assert.ok(section.title.endsWith('…'));
  assert.equal(section.body.length, 600);
  assert.equal(normalizeStandingSection({ title: '   ', body: '' }), null);

  assert.equal(
    renderStandingPageMarkdown([{ key: 'a', title: 'Who', body: 'A builder.' }, { key: 'b', title: 'Style', body: 'Direct.' }]),
    '## Who\n\nA builder.\n\n## Style\n\nDirect.'
  );
});

test('surgical section apply keeps unmentioned sections, replaces upserts, caps size', () => {
  const current = [
    { key: 'profile', title: 'Profile', body: 'v1' },
    { key: 'style', title: 'Style', body: 'direct' },
    { key: 'stale', title: 'Stale', body: 'gone soon' },
  ];
  const next = applyStandingSectionOperations(current, [
    { action: 'upsert', key: 'profile', title: 'Profile', body: 'v2 richer' },
    { action: 'delete', key: 'stale' },
  ]);
  assert.deepEqual(next, [
    { key: 'profile', title: 'Profile', body: 'v2 richer' },
    { key: 'style', title: 'Style', body: 'direct' },
  ], 'style is physically preserved untouched');

  assert.equal(
    applyStandingSectionOperations(current, [{ action: 'upsert', key: 'profile', title: 'Profile', body: 'v1' }]),
    null,
    'a no-op upsert is not a change'
  );
  assert.equal(applyStandingSectionOperations(current, []), null, 'empty operations = no change');

  const grown = applyStandingSectionOperations(
    Array.from({ length: 4 }, (_, index) => ({ key: `k${index}`, title: `T${index}`, body: 'x' })),
    Array.from({ length: 8 }, (_, index) => ({ action: 'upsert', key: `new${index}`, title: `N${index}`, body: 'y' }))
  );
  assert.equal(grown.length, STANDING_PAGE_MAX_SECTIONS, 'merged page caps at the section limit, current order first');
  assert.ok(grown.slice(0, 4).every((section) => section.key.startsWith('k')), 'kept sections come first');

  const deduped = applyStandingSectionOperations(
    [{ key: 'a', title: 'A', body: 'old' }],
    [{ action: 'upsert', key: 'a', title: 'A', body: 'new' }, { action: 'upsert', key: 'a', title: 'A', body: 'newer' }]
  );
  assert.deepEqual(deduped, [{ key: 'a', title: 'A', body: 'newer' }], 'duplicate upsert keys keep the last');
});

test('default pages seed idempotently; list/get roundtrip; archive + restore for defaults, delete for customs', async () => {
  const { cleanup, store } = await createStore();
  try {
    assert.equal(store.seedDefaultPages(1), 3, 'owner_profile / work_threads / playbook');
    assert.equal(store.seedDefaultPages(1), 0, 'second call is a no-op');
    const pages = store.listStandingPages(1);
    assert.deepEqual(pages.map((page) => page.spec).sort(), ['owner_profile', 'playbook', 'work_threads']);
    assert.ok(pages.every((page) => page.isDefault && page.builtAt === null && page.sections.length === 0));

    const profile = store.getStandingPage(1, 'owner_profile');
    assert.ok(profile);
    assert.match(profile.question, /Who is my owner/, 'the standing question is stored with the page');

    // Archiving a default hides it from the default list; seeding must not resurrect it.
    assert.equal(store.removeStandingPage(1, 'owner_profile'), true);
    assert.equal(store.listStandingPages(1).length, 2);
    assert.equal(store.seedDefaultPages(1), 0, 'archived defaults stay archived');
    assert.equal(store.listStandingPages(1, { includeArchived: true }).length, 3);
    assert.equal(store.restoreStandingPage(1, 'owner_profile'), true);
    assert.equal(store.listStandingPages(1).length, 3);

    // Custom pages: create up to the cap, then delete for real.
    const custom = store.createCustomPage({ metabotId: 1, name: '服务器清单', question: '我主人的服务器都在跑什么?' });
    assert.equal(custom.spec, 'custom');
    assert.equal(custom.isDefault, false);
    for (let index = 0; index < STANDING_PAGE_MAX_CUSTOM_PER_BOT - 1; index += 1) {
      store.createCustomPage({ metabotId: 1, name: `页 ${index}`, question: `问题 ${index}?` });
    }
    assert.throws(() => store.createCustomPage({ metabotId: 1, name: '超了', question: '超限?' }), /at most/);
    assert.throws(() => store.createCustomPage({ metabotId: 1, name: '  ', question: '缺名字' }), /required/);
    assert.equal(store.removeStandingPage(1, custom.pageKey), true);
    assert.equal(store.getStandingPage(1, custom.pageKey), null, 'custom removal is a hard delete');

    // Bot isolation.
    store.seedDefaultPages(2);
    assert.equal(store.listStandingPages(2).length, 3);
    assert.equal(store.getStandingPage(1, 'owner_profile').metabotId, 1);
  } finally {
    cleanup();
  }
});

test('commitPageRefresh stamps fingerprints, records bounded revisions, and a no-op refresh does not bump history', async () => {
  const { cleanup, store } = await createStore();
  try {
    store.seedDefaultPages(1);
    const page = store.getStandingPage(1, 'playbook');

    const first = store.commitPageRefresh({
      pageId: page.id,
      operations: [
        { action: 'upsert', key: 'deploy', title: 'Deployment', body: 'Run pnpm build before packaging.' },
        { action: 'upsert', key: 'review', title: 'Reviews', body: 'Read the diff twice.' },
      ],
      scopeFingerprint: 'fp-1',
      reason: 'initial',
    });
    assert.equal(first.builtAt != null, true);
    assert.equal(first.scopeFingerprint, 'fp-1');
    assert.equal(first.sections.length, 2);
    assert.ok(first.content.startsWith('## Deployment'));
    assert.equal(store.listPageRevisions(page.id).length, 1);
    assert.equal(store.listPageRevisions(page.id)[0].reason, 'initial');

    // Surgical refresh: only one section changes, the other is untouched.
    const second = store.commitPageRefresh({
      pageId: page.id,
      operations: [{ action: 'upsert', key: 'deploy', title: 'Deployment', body: 'Run pnpm build && test before packaging.' }],
      scopeFingerprint: 'fp-2',
      reason: 'scope_refresh',
    });
    assert.equal(second.sections.find((section) => section.key === 'review').body, 'Read the diff twice.');
    const revisions = store.listPageRevisions(page.id);
    assert.equal(revisions.length, 2, 'a changed refresh records its predecessor');

    // No-op refresh (model looked, nothing to change): fingerprint stamped, no new revision.
    const noop = store.commitPageRefresh({ pageId: page.id, operations: [], scopeFingerprint: 'fp-3', reason: 'scope_refresh' });
    assert.equal(noop.scopeFingerprint, 'fp-3');
    assert.equal(noop.builtAt >= second.builtAt, true, '"looked, nothing to do" still counts as a build');
    assert.equal(store.listPageRevisions(page.id).length, 2);

    // Refresh errors are surfaced and cleared by the next clean commit.
    store.setRefreshError(page.id, 'unparseable output (no complete JSON object)');
    assert.ok(store.getStandingPage(1, 'playbook').lastRefreshError.includes('unparseable'));
    store.commitPageRefresh({ pageId: page.id, operations: [{ action: 'upsert', key: 'deploy', title: 'Deployment', body: 'v3' }], scopeFingerprint: 'fp-4', reason: 'scope_refresh' });
    assert.equal(store.getStandingPage(1, 'playbook').lastRefreshError, null);

    // History stays bounded.
    for (let index = 0; index < STANDING_PAGE_REVISIONS_KEEP + 3; index += 1) {
      store.commitPageRefresh({
        pageId: page.id,
        operations: [{ action: 'upsert', key: 'deploy', title: 'Deployment', body: `v${index}` }],
        scopeFingerprint: `fp-loop-${index}`,
        reason: 'scope_refresh',
      });
    }
    assert.equal(store.listPageRevisions(page.id, 50).length, STANDING_PAGE_REVISIONS_KEEP);
    assert.equal(store.listPageRevisions(page.id, 50)[0].previousSections.find((section) => section.key === 'deploy').body, `v${STANDING_PAGE_REVISIONS_KEEP + 1}`);
  } finally {
    cleanup();
  }
});
