import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { openKnowledgeBaseIndex } = await import('../dist-electron/main/knowledgeBaseIndexStore.js')
  .catch(() => import('../dist-electron/knowledgeBaseIndexStore.js'));
const {
  buildKbFtsQuery,
  toKnowledgeBaseFtsText,
} = await import('../dist-electron/main/libs/knowledgeBaseText.js')
  .catch(() => import('../dist-electron/libs/knowledgeBaseText.js'));

const setup = () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-index-test-'));
  const index = openKnowledgeBaseIndex(tmpDir);
  assert.ok(index, 'index opens in test runtime');
  return {
    index,
    cleanup: () => {
      index.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
};

const doc = (relpath) => ({
  relpath,
  sha256: `sha-${relpath}`,
  size: 100,
  mtimeMs: 1,
  title: relpath,
  ingestedAt: '2026-08-23T00:00:00.000Z',
});

const chunk = (ord, text) => ({
  ord,
  text,
  tokenText: toKnowledgeBaseFtsText(text),
  startOffset: 0,
  endOffset: text.length,
});

test('fts5 index is probed on and ranks bm25 matches', () => {
  const { index, cleanup } = setup();
  try {
    assert.equal(index.ftsEnabled, true, 'node:sqlite ships FTS5');
    index.replaceDoc(doc('a.md'), [chunk(0, '中华人民共和国民法典，合同编通则。')]);
    index.replaceDoc(doc('b.md'), [chunk(0, '麻婆豆腐的家常做法。')]);

    const hits = index.searchFts(buildKbFtsQuery('民法'), 10);
    assert.equal(hits.length, 1);
    const chunks = index.getChunksByRowids(hits.map((hit) => hit.rowid));
    assert.equal(chunks[0].docRelpath, 'a.md');
    assert.ok(Number.isFinite(hits[0].rank));
  } finally {
    cleanup();
  }
});

test('replaceDoc re-indexes in place and removeDoc drops fts rows', () => {
  const { index, cleanup } = setup();
  try {
    index.replaceDoc(doc('a.md'), [chunk(0, '旧内容：关于合同的约定。')]);
    index.replaceDoc(doc('a.md'), [chunk(0, '新内容：关于侵权的责任。'), chunk(1, '第二块：赔偿范围。')]);

    assert.deepEqual(index.counts(), { docs: 1, chunks: 2 });
    assert.equal(index.searchFts(buildKbFtsQuery('合同'), 10).length, 0, 'stale fts rows removed');
    assert.ok(index.searchFts(buildKbFtsQuery('侵权'), 10).length > 0);

    index.removeDoc('a.md');
    assert.deepEqual(index.counts(), { docs: 0, chunks: 0 });
    assert.equal(index.searchFts(buildKbFtsQuery('侵权'), 10).length, 0);
  } finally {
    cleanup();
  }
});

test('clear wipes docs, chunks and fts rows', () => {
  const { index, cleanup } = setup();
  try {
    index.replaceDoc(doc('a.md'), [chunk(0, '内容甲')]);
    index.replaceDoc(doc('b.md'), [chunk(0, '内容乙')]);
    index.clear();
    assert.deepEqual(index.counts(), { docs: 0, chunks: 0 });
    assert.equal(index.searchFts(buildKbFtsQuery('内容'), 10).length, 0);
  } finally {
    cleanup();
  }
});

test('searchLike substring prefilter works regardless of fts availability', () => {
  const { index, cleanup } = setup();
  try {
    index.replaceDoc(doc('a.md'), [chunk(0, '依法成立的合同受法律保护')]);
    index.replaceDoc(doc('b.md'), [chunk(0, '今天天气不错')]);
    const rows = index.searchLike(['合同'], 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].docRelpath, 'a.md');
    assert.deepEqual(index.searchLike([], 10), []);
  } finally {
    cleanup();
  }
});

test('getChunksByRowids preserves the requested order', () => {
  const { index, cleanup } = setup();
  try {
    index.replaceDoc(doc('a.md'), [chunk(0, '第一块'), chunk(1, '第二块'), chunk(2, '第三块')]);
    const all = index.searchLike(['第'], 10);
    const rowids = all.map((row) => row.rowid).reverse();
    const ordered = index.getChunksByRowids(rowids);
    assert.deepEqual(ordered.map((row) => row.rowid), rowids);
  } finally {
    cleanup();
  }
});
