import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  formatStandingPagesList,
  formatStandingPageRead,
  findStandingPageForRead,
} = loadCompiled('../dist-electron/main/standingPageStore.js');
const { setStandingPageStore, getStandingPageStore } = loadCompiled('../dist-electron/main/standingPageRuntime.js');

const builtPage = (overrides = {}) => ({
  id: 'p1',
  metabotId: 9,
  pageKey: 'owner_profile',
  spec: 'owner_profile',
  name: 'Owner profile',
  question: 'Who is my owner?',
  sections: [
    { key: 'identity', title: '身份与工作', body: '独立开发者,做 AI 工具。' },
    { key: 'style', title: '协作风格', body: '先验证再交付。' },
  ],
  content: '## 身份与工作\n\n独立开发者,做 AI 工具。\n\n## 协作风格\n\n先验证再交付。',
  scopeFingerprint: 'fp',
  builtAt: Date.UTC(2026, 9, 24, 2, 0),
  status: 'active',
  isDefault: true,
  lastRefreshError: null,
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});

test('list formatting: only built pages, section titles and freshness ride the line', () => {
  const unbuilt = builtPage({ id: 'p2', pageKey: 'playbook', name: 'My playbook', builtAt: null, sections: [], content: '' });
  const failing = builtPage({
    id: 'p3', pageKey: 'work_threads', name: 'Current work threads',
    builtAt: null, sections: [], content: '', lastRefreshError: 'unparseable output',
  });
  const text = formatStandingPagesList([builtPage(), unbuilt, failing]);
  assert.match(text, /^Your standing pages \(1\):/);
  assert.match(text, /- owner_profile \| Owner profile — built 2026-10-24 02:00 UTC — 身份与工作 \/ 协作风格$/m);
  assert.ok(!text.includes('My playbook'), 'unbuilt pages stay off the agent surface');
  assert.equal(
    formatStandingPagesList([unbuilt]),
    'No standing pages are built yet. The nightly memory pass builds them once there is enough material; nothing to read now.'
  );
});

test('read formatting: markdown body, question header, refresh-failure warning', () => {
  const text = formatStandingPageRead(builtPage());
  assert.match(text, /^# Owner profile \(owner_profile\) — built 2026-10-24 02:00 UTC/);
  assert.ok(text.includes('Question it answers: Who is my owner?'));
  assert.ok(text.includes('## 身份与工作'));
  const failing = formatStandingPageRead(builtPage({ lastRefreshError: 'quota exhausted' }));
  assert.ok(failing.includes('Last refresh failed: quota exhausted'));
  assert.ok(formatStandingPageRead(builtPage({ content: '' })).includes('(This page has no sections yet.)'));
});

test('find by key, exact name, then partial name — never an unbuilt-only guess', () => {
  const pages = [builtPage(), builtPage({ id: 'p2', pageKey: 'playbook', name: 'My playbook', builtAt: null })];
  assert.equal(findStandingPageForRead(pages, 'Owner Profile').pageKey, 'owner_profile');
  assert.equal(findStandingPageForRead(pages, 'owner_profile').pageKey, 'owner_profile');
  assert.equal(findStandingPageForRead(pages, 'playbook').pageKey, 'playbook');
  assert.equal(findStandingPageForRead(pages, 'nope'), null);
  assert.equal(findStandingPageForRead(pages, '  '), null);
});

test('runtime accessor: set/get roundtrip with null default semantics', async () => {
  const previous = getStandingPageStore();
  try {
    setStandingPageStore(null);
    assert.equal(getStandingPageStore(), null, 'null store means "tool unavailable"');
    const { db, cleanup } = await createSqliteStore();
    const store = new StandingPageStore(db, () => {});
    setStandingPageStore(store);
    assert.equal(getStandingPageStore(), store);
    store.seedDefaultPages(9);
    assert.equal(getStandingPageStore().listStandingPages(9).length, 3);
    cleanup();
  } finally {
    setStandingPageStore(previous);
  }
});

test('wiring anchors: the standing_pages tool mounts behind a built-page probe and stays pull-only', () => {
  const source = readFileSync(new URL('../src/main/libs/coworkRunner.ts', import.meta.url), 'utf8');
  assert.match(source, /'standing_pages',/, 'tool is registered');
  assert.match(source, /hasBuiltStandingPages/, 'mount is gated on at least one BUILT page');
  assert.match(source, /runStandingPagesTool\(args, sessionId\)/, 'handler goes through the runner method');
  assert.match(source, /pages are NOT injected per turn/, 'description states the pull-only contract');
  assert.match(
    source,
    /getStandingPageStore\(\)/,
    'the runner pulls the store from the runtime accessor, never a constructor dep'
  );
  const mainSource = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
  assert.match(mainSource, /setStandingPageStore\(getStandingPageStore\(\)\);/, 'main pushes the store into the runtime');
  assert.match(mainSource, /setStandingPageStore\(null\);/, 'shutdown clears it symmetrically');
});
