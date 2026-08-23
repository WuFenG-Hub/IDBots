import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createNativeSqliteDatabase } = await import('../dist-electron/main/nativeSqliteDatabase.js')
  .catch(() => import('../dist-electron/nativeSqliteDatabase.js'));
const { KnowledgeBaseStore } = await import('../dist-electron/main/knowledgeBaseStore.js')
  .catch(() => import('../dist-electron/knowledgeBaseStore.js'));
const { KnowledgeBaseService } = await import('../dist-electron/main/services/knowledgeBaseService.js')
  .catch(() => import('../dist-electron/services/knowledgeBaseService.js'));

const setup = () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-service-test-'));
  const db = createNativeSqliteDatabase(':memory:');
  assert.ok(db, 'native sqlite available in test runtime');
  const store = new KnowledgeBaseStore(db, () => {});
  const events = [];
  let nowValue = new Date('2026-08-23T10:00:00');
  const service = new KnowledgeBaseService({
    store,
    resolveUserDataDir: () => path.join(tmpDir, 'userData'),
    emitToRenderer: (channel, payload) => events.push({ channel, payload }),
    now: () => nowValue,
  });
  return {
    tmpDir,
    db,
    store,
    service,
    events,
    setNow: (date) => { nowValue = date; },
    cleanup: () => {
      service.stopAutoLearnSchedule();
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
};

const writeRaw = (dir, relpath, content) => {
  const abs = path.join(dir, relpath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
};

test('listing lazily creates the default knowledge base with its raw dir', async (t) => {
  const { service, tmpDir, cleanup } = setup();
  try {
    const list = service.listKnowledgeBases(7);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'default');
    assert.equal(list[0].isDefault, true);
    assert.equal(list[0].autoLearn, true);
    assert.ok(list[0].rawDir.includes(path.join('knowledge-bases', '7', 'default')));
    assert.ok(fs.existsSync(list[0].rawDir));
    // idempotent: no duplicate rows on a second call
    assert.equal(service.listKnowledgeBases(7).length, 1);
  } finally {
    cleanup();
  }
});

test('createKnowledgeBase uses an external raw directory in place (no copy)', async (t) => {
  const { service, tmpDir, cleanup } = setup();
  try {
    const external = path.join(tmpDir, 'legal-docs');
    writeRaw(external, '民法典.md', '# 中华人民共和国民法典\n\n合同自成立时生效。');
    const kb = service.createKnowledgeBase(7, {
      name: '法律知识',
      description: '法律法规与判例',
      rawDir: external,
    });
    assert.equal(kb.rawDir, external);
    assert.equal(kb.isDefault, false);
    assert.ok(fs.existsSync(path.join(external, '民法典.md')), 'external content untouched');
    assert.throws(() => service.createKnowledgeBase(7, { name: '  ' }), /name is required/);
  } finally {
    cleanup();
  }
});

test('learn is incremental: add, no-op, update, delete, and failure collection', async (t) => {
  const { service, cleanup, events } = setup();
  try {
    service.ensureDefaultKnowledgeBase(7);
    const kb = service.listKnowledgeBases(7)[0];
    writeRaw(kb.rawDir, '民法典.md', '# 民法典\n\n第四百六十五条 依法成立的合同，受法律保护。');
    writeRaw(kb.rawDir, 'notes/case.json', JSON.stringify({
      title: '典型案例', contentType: 'text/markdown', content: '某合同纠纷案的裁判要点。', createTime: '2026-01-01',
    }));
    writeRaw(kb.rawDir, 'broken.pdf', '%PDF-garbage-not-a-real-pdf');

    const first = await service.learnKnowledgeBase(7, kb.id);
    assert.equal(first.added, 2);
    assert.equal(first.failed.length, 1);
    assert.equal(first.failed[0].relpath, 'broken.pdf');
    assert.ok(first.chunksTotal > 0);
    assert.ok(events.some((e) => e.channel === 'knowledgeBase:learnStatus' && e.payload.state === 'done'));

    const second = await service.learnKnowledgeBase(7, kb.id);
    assert.equal(second.added, 0);
    assert.equal(second.unchanged, 2);
    assert.equal(second.failed.length, 1, 'failing file retried each run');

    const target = path.join(kb.rawDir, '民法典.md');
    fs.writeFileSync(target, '# 民法典\n\n第四百六十五条 依法成立的合同，受法律保护。\n\n第五百零二条 依法成立的合同，自成立时生效。', 'utf8');
    const stat = fs.statSync(target);
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(target, future, future);
    const third = await service.learnKnowledgeBase(7, kb.id);
    assert.equal(third.updated, 1);
    assert.equal(third.added, 0);

    fs.unlinkSync(path.join(kb.rawDir, 'notes/case.json'));
    const fourth = await service.learnKnowledgeBase(7, kb.id);
    assert.equal(fourth.removed, 1);
    assert.equal(fourth.docsTotal, 1);
  } finally {
    cleanup();
  }
});

test('full relearn rebuilds the index from scratch', async (t) => {
  const { service, cleanup } = setup();
  try {
    service.ensureDefaultKnowledgeBase(7);
    const kb = service.listKnowledgeBases(7)[0];
    writeRaw(kb.rawDir, 'a.md', '中华人民共和国合伙企业法');
    await service.learnKnowledgeBase(7, kb.id);
    // delete the raw file but only run a FULL learn on an empty dir later
    fs.unlinkSync(path.join(kb.rawDir, 'a.md'));
    const summary = await service.learnKnowledgeBase(7, kb.id, { full: true });
    assert.equal(summary.docsTotal, 0);
    assert.equal(summary.chunksTotal, 0);
  } finally {
    cleanup();
  }
});

test('query finds chunks by two-character Chinese words and merges across KBs', async (t) => {
  const { service, tmpDir, cleanup } = setup();
  try {
    service.ensureDefaultKnowledgeBase(7);
    const defaultKb = service.listKnowledgeBases(7)[0];
    writeRaw(defaultKb.rawDir, 'civil-code.md', '中华人民共和国民法典。依法成立的合同，自成立时生效。当事人应当按照约定全面履行自己的义务。');

    const external = path.join(tmpDir, 'cookbooks');
    const cookKb = service.createKnowledgeBase(7, { name: '食谱', description: '做菜', rawDir: external });
    writeRaw(external, 'mapo.md', '麻婆豆腐的做法：先炒香豆瓣酱，再下豆腐小火慢炖。');

    await service.learnAllKnowledgeBases(7);

    const scoped = service.queryKnowledgeBase(7, { query: '合同 生效', kbId: defaultKb.id });
    assert.ok(scoped.length > 0, 'expected hits in the legal KB');
    assert.equal(scoped[0].kbId, defaultKb.id);
    assert.ok(scoped[0].snippet.includes('合同'));
    assert.ok(scoped[0].docTitle.length > 0);

    const merged = service.queryKnowledgeBase(7, { query: '豆腐' });
    assert.equal(merged.length, 1);
    assert.equal(merged[0].kbId, cookKb.id);

    assert.deepEqual(service.queryKnowledgeBase(7, { query: '' }), []);
    const none = service.queryKnowledgeBase(7, { query: 'xylophone quantum' });
    assert.equal(none.length, 0);
  } finally {
    cleanup();
  }
});

test('addDocument wraps free-form content as simplenote JSON and lands in metabot-inbox', async (t) => {
  const { service, cleanup } = setup();
  try {
    service.ensureDefaultKnowledgeBase(7);
    const saved = service.addDocument(7, {
      title: '最新判例摘要',
      content: '法院认为：合同违约方应当承担损害赔偿责任。',
      source: { type: 'web', url: 'https://example.com/case' },
    });
    assert.equal(saved.kbId, 'default');
    assert.ok(saved.filePath.includes('metabot-inbox'));
    const payload = JSON.parse(fs.readFileSync(saved.filePath, 'utf8'));
    assert.equal(payload.contentType, 'text/markdown');
    assert.equal(payload.title, '最新判例摘要');
    assert.equal(payload['x-kb-source'].url, 'https://example.com/case');

    // learning picks the new document up incrementally
    const summary = await service.learnKnowledgeBase(7, 'default');
    assert.equal(summary.added, 1);
    const hits = service.queryKnowledgeBase(7, { query: '损害赔偿' });
    assert.ok(hits.length > 0);
  } finally {
    cleanup();
  }
});

test('addDocument keeps note-style JSON verbatim apart from provenance', async (t) => {
  const { service, cleanup } = setup();
  try {
    const pinBody = JSON.stringify({
      title: 'MetaWeb 教程', contentType: 'text/markdown', content: '第一步……', createTime: '2026-08-01', tags: ['tutorial'],
    });
    const saved = service.addDocument(7, {
      title: 'ignored-when-verbatim',
      content: pinBody,
      source: { type: 'metaweb', pinId: 'abc123i0', protocol: '/protocols/simplenote' },
    });
    const payload = JSON.parse(fs.readFileSync(saved.filePath, 'utf8'));
    assert.equal(payload.title, 'MetaWeb 教程');
    assert.deepEqual(payload.tags, ['tutorial']);
    assert.equal(payload['x-kb-source'].pinId, 'abc123i0');
    assert.throws(() => service.addDocument(7, { title: '', content: 'x' }), /title is required/);
    assert.throws(() => service.addDocument(7, { title: 'x', content: '  ' }), /content is required/);
  } finally {
    cleanup();
  }
});

test('importFiles copies supported types, skips others and de-dupes names', async (t) => {
  const { service, tmpDir, cleanup } = setup();
  try {
    service.ensureDefaultKnowledgeBase(7);
    const src = path.join(tmpDir, 'picked');
    const md = writeRaw(src, 'doc.md', '导入的文档');
    const exe = writeRaw(src, 'tool.exe', 'MZ');
    const result = service.importFiles(7, 'default', [md, exe]);
    assert.equal(result.imported.length, 1);
    assert.equal(result.skipped.length, 1);
    const again = service.importFiles(7, 'default', [md]);
    assert.ok(again.imported[0].endsWith('doc-2.md'), again.imported[0]);
  } finally {
    cleanup();
  }
});

test('removeKnowledgeBase refuses the default and preserves external raw dirs', async (t) => {
  const { service, tmpDir, cleanup } = setup();
  try {
    service.ensureDefaultKnowledgeBase(7);
    assert.throws(() => service.removeKnowledgeBase(7, 'default'), /default/);

    const external = path.join(tmpDir, 'keep-me');
    writeRaw(external, 'a.md', '内容');
    const kb = service.createKnowledgeBase(7, { name: '临时', rawDir: external });
    await service.learnKnowledgeBase(7, kb.id);
    service.removeKnowledgeBase(7, kb.id);
    assert.equal(service.store.getById(7, kb.id), null);
    assert.ok(fs.existsSync(path.join(external, 'a.md')), 'external raw dir preserved');
  } finally {
    cleanup();
  }
});

test('updateKnowledgeBase edits name/description/autoLearn with validation', async (t) => {
  const { service, cleanup } = setup();
  try {
    service.ensureDefaultKnowledgeBase(7);
    const updated = service.updateKnowledgeBase(7, 'default', { name: '通用知识', autoLearn: false });
    assert.equal(updated.name, '通用知识');
    assert.equal(updated.autoLearn, false);
    assert.throws(() => service.updateKnowledgeBase(7, 'default', { name: ' ' }), /name is required/);
  } finally {
    cleanup();
  }
});

test('auto-learn tick only runs inside the nightly window and once per day', async (t) => {
  const { service, setNow, cleanup } = setup();
  try {
    service.ensureDefaultKnowledgeBase(7);
    const kb = service.listKnowledgeBases(7)[0];
    writeRaw(kb.rawDir, 'nightly.md', '夜间学习的内容。');

    setNow(new Date('2026-08-23T10:00:00'));
    assert.deepEqual(await service.runAutoLearnTick(), { learned: 0 }, 'outside window');

    setNow(new Date('2026-08-24T01:30:00'));
    assert.deepEqual(await service.runAutoLearnTick(), { learned: 1 });
    assert.equal(service.store.getById(7, 'default').docCount, 1);
    assert.equal(service.store.getById(7, 'default').lastAutoLearnDate, '2026-08-24');

    setNow(new Date('2026-08-24T02:00:00'));
    assert.deepEqual(await service.runAutoLearnTick(), { learned: 0 }, 'already learned today');

    setNow(new Date('2026-08-25T05:59:00'));
    writeRaw(kb.rawDir, 'nightly2.md', '第二天的新文档。');
    assert.deepEqual(await service.runAutoLearnTick(), { learned: 1 });
    assert.equal(service.store.getById(7, 'default').docCount, 2);
  } finally {
    cleanup();
  }
});

test('invalid metabotId is rejected before any store/filesystem side effect', async () => {
  const { service, cleanup } = setup();
  try {
    assert.throws(() => service.listKnowledgeBases(Number('not-a-number')), /Invalid metabotId/);
    assert.throws(() => service.createKnowledgeBase(0, { name: 'x' }), /Invalid metabotId/);
    assert.throws(() => service.requireKnowledgeBase(-3, 'default'), /Invalid metabotId/);
    assert.throws(
      () => service.addDocument(Number.NaN, { title: 't', content: 'c' }),
      /Invalid metabotId/,
    );
  } finally {
    cleanup();
  }
});

test('addDocument bounds provenance fields (url/pinId/tags)', async () => {
  const { service, cleanup } = setup();
  try {
    const saved = service.addDocument(7, {
      title: 'bounded',
      content: 'hello',
      source: {
        type: 'metaweb',
        pinId: 'p'.repeat(300),
        url: `https://example.com/${'u'.repeat(800)}`,
        tags: Array.from({ length: 40 }, (_, index) => `tag-${index}-${'x'.repeat(100)}`),
      },
    });
    const stored = JSON.parse(fs.readFileSync(saved.filePath, 'utf8'));
    const source = stored['x-kb-source'];
    assert.equal(source.pinId.length, 128);
    assert.equal(source.url.length, 500);
    assert.equal(source.tags.length, 20);
    assert.ok(source.tags.every((tag) => tag.length <= 80));
  } finally {
    cleanup();
  }
});

test('a corrupt index self-heals: query survives, next learn rebuilds', async () => {
  const { service, cleanup } = setup();
  try {
    const kb = service.listKnowledgeBases(7)[0];
    writeRaw(kb.rawDir, 'a.md', '# 自主学习\n\n夜间学习的内容会进入知识库索引。');
    await service.learnKnowledgeBase(7, kb.id);
    const before = service.queryKnowledgeBase(7, { query: '自主学习' });
    assert.ok(before.length > 0, 'baseline query hits');

    // Corrupt the derived index on disk.
    const kbRoot = path.dirname(kb.rawDir);
    fs.writeFileSync(path.join(kbRoot, 'index', 'kb.sqlite'), 'this is not a sqlite database');
    const afterCorrupt = service.queryKnowledgeBase(7, { query: '自主学习' });
    assert.deepEqual(afterCorrupt, [], 'self-heal rebuilt an empty index instead of throwing');

    await service.learnKnowledgeBase(7, kb.id);
    const afterHeal = service.queryKnowledgeBase(7, { query: '自主学习' });
    assert.ok(afterHeal.length > 0, 'learn rebuilt the index from raw docs');
  } finally {
    cleanup();
  }
});

test('learn emits error (not a stuck spinner) when the index cannot be opened at all', async () => {
  const { service, events, cleanup } = setup();
  const kb = service.listKnowledgeBases(7)[0];
  const kbRoot = path.dirname(kb.rawDir);
  // A read-only KB root makes every open attempt fail (delete + recreate
  // included), so even the self-heal retry throws.
  fs.chmodSync(kbRoot, 0o444);
  try {
    await assert.rejects(() => service.learnKnowledgeBase(7, kb.id), /index/i);
    const states = events.filter((event) => event.payload?.kbId === kb.id).map((event) => event.payload.state);
    assert.ok(states.includes('running'));
    assert.equal(states[states.length - 1], 'error', 'failure surfaces as an error event');
  } finally {
    fs.chmodSync(kbRoot, 0o755);
    cleanup();
  }
});
