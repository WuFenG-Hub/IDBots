import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  SUPPORTED_KB_EXTENSIONS,
  KnowledgeBaseTextError,
  cleanKnowledgeBaseText,
  extractKnowledgeBaseText,
  extractKbDocTitle,
  chunkKnowledgeBaseText,
  tokenizeKnowledgeBaseText,
  toKnowledgeBaseFtsText,
  buildKbFtsQuery,
  buildKbCitationSnippet,
  phraseScore,
  sha256File,
} = await import('../dist-electron/main/libs/knowledgeBaseText.js')
  .catch(() => import('../dist-electron/libs/knowledgeBaseText.js'));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-text-test-'));

const writeTmp = (name, content) => {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
};

test('cleanKnowledgeBaseText normalizes whitespace and control chars', () => {
  assert.equal(cleanKnowledgeBaseText('a\r\nb\t\tc   d\n\n\n\ne'), 'a\nb c d\n\ne');
  assert.equal(cleanKnowledgeBaseText('   padded  '), 'padded');
  assert.equal(cleanKnowledgeBaseText(null), '');
});

test('tokenize emits latin tokens, CJK unigrams and in-run CJK bigrams', () => {
  const tokens = tokenizeKnowledgeBaseText('民法典 Contract_v2 生效');
  assert.ok(tokens.includes('contract_v2'));
  for (const unigram of ['民', '法', '典', '生', '效']) assert.ok(tokens.includes(unigram), unigram);
  assert.ok(tokens.includes('民法'));
  assert.ok(tokens.includes('法典'));
  assert.ok(tokens.includes('生效'));
  // bigrams must never span punctuation / script boundaries
  assert.ok(!tokens.includes('典生'));
});

test('tokenize lowercases latin input', () => {
  assert.ok(tokenizeKnowledgeBaseText('HelloWorld').includes('helloworld'));
});

test('toKnowledgeBaseFtsText joins tokens with spaces', () => {
  const fts = toKnowledgeBaseFtsText('合同 生效');
  assert.ok(fts.includes(' '));
  assert.ok(fts.split(' ').includes('合同'));
});

test('buildKbFtsQuery quotes tokens, ORs them, dedupes and caps the count', () => {
  const query = buildKbFtsQuery('民法 民法 contract');
  const parts = query.split(' OR ');
  assert.deepEqual([...parts].sort(), ['"contract"', '"民"', '"民法"', '"法"'].sort());
  assert.equal(buildKbFtsQuery('!!!'), '');
  const capped = buildKbFtsQuery(Array.from({ length: 50 }, (_, i) => `t${i}`).join(' '), 10);
  assert.equal(capped.split(' OR ').length, 10);
});

test('chunkKnowledgeBaseText keeps short text as a single chunk', () => {
  const chunks = chunkKnowledgeBaseText('短小文档');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, '短小文档');
  assert.deepEqual([chunks[0].startOffset, chunks[0].endOffset], [0, 4]);
});

test('chunkKnowledgeBaseText slides with overlap and prefers paragraph breaks', () => {
  const paragraph = '第一段内容。'.repeat(40); // 240 chars each
  const text = Array.from({ length: 8 }, () => paragraph).join('\n\n');
  const chunks = chunkKnowledgeBaseText(text, 300, 60);
  assert.ok(chunks.length > 2, `expected multiple chunks, got ${chunks.length}`);
  // paragraph-preferred break: most chunk texts should not start mid-word after '。'
  assert.ok(chunks[0].text.endsWith('。'));
  for (let i = 1; i < chunks.length; i += 1) {
    assert.ok(chunks[i].startOffset < chunks[i - 1].endOffset, 'chunks overlap');
    assert.ok(chunks[i].startOffset > chunks[i - 1].startOffset, 'cursor advances');
  }
  const total = chunks[chunks.length - 1].endOffset;
  assert.equal(total, text.length);
});

test('chunkKnowledgeBaseText falls back to hard windows without newlines', () => {
  const text = 'x'.repeat(1000);
  const chunks = chunkKnowledgeBaseText(text, 300, 60);
  assert.ok(chunks.length >= 4);
  assert.equal(chunks[chunks.length - 1].endOffset, 1000);
});

test('extractKnowledgeBaseText reads markdown verbatim', () => {
  const filePath = writeTmp('note.md', '# 标题\n\n正文内容');
  const result = extractKnowledgeBaseText(filePath);
  assert.ok(result.text.includes('正文内容'));
  assert.equal(result.title, undefined);
});

test('extractKnowledgeBaseText unwraps simplenote-protocol JSON to title+content', () => {
  const note = {
    title: '民法典合同编要点',
    contentType: 'text/markdown',
    content: '合同自成立时生效。',
    createTime: '2026-08-23T00:00:00.000Z',
    tags: ['法律'],
  };
  const filePath = writeTmp('note.json', JSON.stringify(note));
  const result = extractKnowledgeBaseText(filePath);
  assert.equal(result.title, '民法典合同编要点');
  assert.ok(result.text.includes('合同自成立时生效。'));
  assert.ok(!result.text.includes('contentType'), 'JSON syntax is not indexed');
});

test('extractKnowledgeBaseText keeps non-note JSON verbatim (e.g. raw MetaWeb pins)', () => {
  const pin = { id: 'abc123', path: '/protocols/simplenote', metaid: 'x' };
  const filePath = writeTmp('pin.json', JSON.stringify(pin));
  const result = extractKnowledgeBaseText(filePath);
  assert.ok(result.text.includes('abc123'));
});

test('extractKnowledgeBaseText rejects unsupported extensions', () => {
  const filePath = writeTmp('binary.exe', 'MZ');
  assert.throws(
    () => extractKnowledgeBaseText(filePath),
    (error) => error instanceof KnowledgeBaseTextError && error.code === 'unsupported_format'
  );
});

test('supported extension set matches the documented ingest scope', () => {
  for (const ext of ['.md', '.txt', '.json', '.csv', '.pdf', '.docx']) {
    assert.ok(SUPPORTED_KB_EXTENSIONS.has(ext), ext);
  }
  assert.ok(!SUPPORTED_KB_EXTENSIONS.has('.exe'));
});

test('extractKbDocTitle prefers the first heading line, falls back to basename', () => {
  assert.equal(extractKbDocTitle('/tmp/x.md', '\n\n## 民法典总则\n正文'), '民法典总则');
  assert.equal(extractKbDocTitle('/tmp/cases/合同法.md', ''), '合同法');
});

test('buildKbCitationSnippet truncates long text with an ellipsis', () => {
  const long = '一'.repeat(500);
  const snippet = buildKbCitationSnippet(long);
  assert.equal(snippet.length, 220);
  assert.ok(snippet.endsWith('…'));
  assert.equal(buildKbCitationSnippet('短文本'), '短文本');
});

test('phraseScore rewards substring hits, shared bigrams and latin coverage', () => {
  assert.equal(phraseScore('', '任何文本'), 0);
  const hit = phraseScore('民法典', '中华人民共和国民法典全文');
  assert.ok(hit >= 1, `substring hit scores >= 1, got ${hit}`);
  const partial = phraseScore('合同生效', '合同自成立时生效，当事人另有约定除外');
  assert.ok(partial > 0);
  const latin = phraseScore('react hooks', 'Using React Hooks in function components');
  assert.ok(latin >= 1, `latin coverage scores, got ${latin}`);
  assert.equal(phraseScore('完全不相关xyz', '另一个文档的内容'), 0);
});

test('sha256File hashes file bytes deterministically', () => {
  const filePath = writeTmp('hash.txt', 'hash me');
  assert.equal(sha256File(filePath), sha256File(filePath));
  assert.equal(sha256File(filePath).length, 64);
});
