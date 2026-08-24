import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

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
  sha256FileAsync,
} = await import('../dist-electron/main/libs/knowledgeBaseText.js')
  .catch(() => import('../dist-electron/libs/knowledgeBaseText.js'));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-text-test-'));

const writeTmp = (name, content) => {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
};

const writeTmpBuffer = (name, content) => {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, content);
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
  assert.deepEqual([...parts].sort(), ['"contract"', '"民法"'].sort());
  // isolated single CJK char keeps its unigram; longer runs only emit bigrams
  assert.equal(buildKbFtsQuery('法'), '"法"');
  assert.equal(buildKbFtsQuery('民法典'), '"民法" OR "法典"');
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

test('extractKnowledgeBaseText reads markdown verbatim', async () => {
  const filePath = writeTmp('note.md', '# 标题\n\n正文内容');
  const result = await extractKnowledgeBaseText(filePath);
  assert.ok(result.text.includes('正文内容'));
  assert.equal(result.title, undefined);
});

test('extractKnowledgeBaseText unwraps simplenote-protocol JSON to title+content', async () => {
  const note = {
    title: '民法典合同编要点',
    contentType: 'text/markdown',
    content: '合同自成立时生效。',
    createTime: '2026-08-23T00:00:00.000Z',
    tags: ['法律'],
  };
  const filePath = writeTmp('note.json', JSON.stringify(note));
  const result = await extractKnowledgeBaseText(filePath);
  assert.equal(result.title, '民法典合同编要点');
  assert.ok(result.text.includes('合同自成立时生效。'));
  assert.ok(!result.text.includes('contentType'), 'JSON syntax is not indexed');
});

test('extractKnowledgeBaseText keeps non-note JSON verbatim (e.g. raw MetaWeb pins)', async () => {
  const pin = { id: 'abc123', path: '/protocols/simplenote', metaid: 'x' };
  const filePath = writeTmp('pin.json', JSON.stringify(pin));
  const result = await extractKnowledgeBaseText(filePath);
  assert.ok(result.text.includes('abc123'));
});

test('extractKnowledgeBaseText reads the extra plain-text extensions verbatim', async () => {
  for (const ext of ['markdown', 'tsv', 'yaml', 'yml', 'xml', 'log', 'rst']) {
    const filePath = writeTmp(`plain.${ext}`, `内容 for ${ext}`);
    const result = await extractKnowledgeBaseText(filePath);
    assert.ok(result.text.includes(`内容 for ${ext}`), ext);
  }
});

test('extractKnowledgeBaseText rejects unsupported extensions', async () => {
  const filePath = writeTmp('binary.exe', 'MZ');
  await assert.rejects(
    () => extractKnowledgeBaseText(filePath),
    (error) => error instanceof KnowledgeBaseTextError && error.code === 'unsupported_format'
  );
});

test('supported extension set matches the documented ingest scope', () => {
  for (const ext of [
    '.md', '.markdown', '.txt', '.json', '.csv', '.tsv', '.yaml', '.yml', '.xml', '.log', '.rst',
    '.pdf', '.docx', '.pptx', '.xlsx', '.xls', '.html', '.htm', '.epub',
  ]) {
    assert.ok(SUPPORTED_KB_EXTENSIONS.has(ext), ext);
  }
  assert.ok(!SUPPORTED_KB_EXTENSIONS.has('.exe'));
  assert.ok(!SUPPORTED_KB_EXTENSIONS.has('.doc'), 'legacy OLE .doc stays unsupported');
  assert.ok(!SUPPORTED_KB_EXTENSIONS.has('.ppt'), 'legacy OLE .ppt stays unsupported');
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

test('sha256File hashes file bytes deterministically', async () => {
  const filePath = writeTmp('hash.txt', 'hash me');
  assert.equal(sha256File(filePath), sha256File(filePath));
  assert.equal(sha256File(filePath).length, 64);
  assert.equal(await sha256FileAsync(filePath), sha256File(filePath));
});

/* ------------------------------------------------------------------ */
/* Converter fixtures (all generated inline; no binary blobs in repo)  */
/* ------------------------------------------------------------------ */

/** Minimal single-page PDF with one Helvetica text object (latin-only text). */
const makePdf = (text) => {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  objects.push(`5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
};

const PPTX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>
</Types>`;

const pptxSlide = (paragraphs) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    ${paragraphs.map((runs) => `<a:p>${runs.map((run) => `<a:r><a:t>${run}</a:t></a:r>`).join('')}</a:p>`).join('\n    ')}
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`;

test('extractKnowledgeBaseText extracts PDF text without external binaries', async () => {
  const filePath = writeTmpBuffer('sample.pdf', makePdf('Hello PDF Knowledge Base'));
  const result = await extractKnowledgeBaseText(filePath);
  assert.ok(result.text.includes('Hello PDF Knowledge Base'), result.text);
});

test('extractKnowledgeBaseText converts DOCX to text', async () => {
  const zip = new AdmZip();
  zip.addFile(
    '[Content_Types].xml',
    Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`, 'utf8')
  );
  zip.addFile(
    '_rels/.rels',
    Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`, 'utf8')
  );
  zip.addFile(
    'word/document.xml',
    Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
  <w:p><w:r><w:t>知识库 DOCX 要点</w:t></w:r></w:p>
  <w:p><w:r><w:t>Docx body paragraph here.</w:t></w:r></w:p>
</w:body></w:document>`, 'utf8')
  );
  const filePath = writeTmpBuffer('sample.docx', zip.toBuffer());
  const result = await extractKnowledgeBaseText(filePath);
  assert.ok(result.text.includes('知识库 DOCX 要点'), result.text);
  assert.ok(result.text.includes('Docx body paragraph here.'), result.text);
});

test('extractKnowledgeBaseText converts PPTX slides and notes to markdown sections', async () => {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(PPTX_CONTENT_TYPES, 'utf8'));
  zip.addFile('ppt/slides/slide1.xml', Buffer.from(pptxSlide([['季度总结'], ['Revenue ', 'grew &amp; grew']]), 'utf8'));
  zip.addFile('ppt/slides/slide2.xml', Buffer.from(pptxSlide([['第二张幻灯片']]), 'utf8'));
  zip.addFile(
    'ppt/notesSlides/notesSlide1.xml',
    Buffer.from(pptxSlide([['speaker note here']]), 'utf8')
  );
  const filePath = writeTmpBuffer('sample.pptx', zip.toBuffer());
  const result = await extractKnowledgeBaseText(filePath);
  assert.ok(result.text.includes('## Slide 1'), result.text);
  assert.ok(result.text.includes('季度总结'), result.text);
  assert.ok(result.text.includes('Revenue grew & grew'), 'XML entities are decoded');
  assert.ok(result.text.includes('## Slide 2'), result.text);
  assert.ok(result.text.includes('第二张幻灯片'), result.text);
  assert.ok(result.text.includes('Notes: speaker note here'), result.text);
});

test('extractKnowledgeBaseText converts XLSX sheets to per-sheet CSV sections', async () => {
  const XLSX = await import('xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ['Name', 'Score'],
      ['Alice', 90],
      ['Bob', 88],
    ]),
    'Grades'
  );
  const filePath = writeTmpBuffer('sample.xlsx', XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  const result = await extractKnowledgeBaseText(filePath);
  assert.ok(result.text.includes('## Sheet: Grades'), result.text);
  assert.ok(result.text.includes('Alice'), result.text);
  assert.ok(result.text.includes('Bob'), result.text);
});

test('extractKnowledgeBaseText converts HTML to markdown', async () => {
  const filePath = writeTmp('page.html', '<h1>知识库 HTML</h1><p>Paragraph with <strong>bold text</strong>.</p>');
  const result = await extractKnowledgeBaseText(filePath);
  assert.ok(result.text.includes('# 知识库 HTML'), result.text);
  assert.ok(result.text.includes('**bold text**'), result.text);
});

test('extractKnowledgeBaseText converts EPUB spine chapters and reads dc:title', async () => {
  const zip = new AdmZip();
  zip.addFile(
    'META-INF/container.xml',
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`, 'utf8')
  );
  zip.addFile(
    'OEBPS/content.opf',
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>测试电子书</dc:title></metadata>
  <manifest><item id="chap1" href="chap1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="chap1"/></spine>
</package>`, 'utf8')
  );
  zip.addFile(
    'OEBPS/chap1.xhtml',
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第一章</h1><p>章节正文内容。</p></body></html>`, 'utf8')
  );
  const filePath = writeTmpBuffer('book.epub', zip.toBuffer());
  const result = await extractKnowledgeBaseText(filePath);
  assert.equal(result.title, '测试电子书');
  assert.ok(result.text.includes('第一章'), result.text);
  assert.ok(result.text.includes('章节正文内容。'), result.text);
});

test('extractKnowledgeBaseText reports corrupt binary files as extract_failed', async () => {
  const pdfPath = writeTmpBuffer('broken.pdf', Buffer.from('this is not a pdf at all', 'utf8'));
  await assert.rejects(
    () => extractKnowledgeBaseText(pdfPath),
    (error) => error instanceof KnowledgeBaseTextError && error.code === 'extract_failed'
  );
  const pptxPath = writeTmpBuffer('broken.pptx', Buffer.from('not a zip either', 'utf8'));
  await assert.rejects(
    () => extractKnowledgeBaseText(pptxPath),
    (error) => error instanceof KnowledgeBaseTextError && error.code === 'extract_failed'
  );
});
