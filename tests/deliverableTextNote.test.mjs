import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const {
  isTextDocumentDeliverable,
  readTextNoteDocument,
  buildTextNotePayload,
  publishTextFileAsNote,
  MAX_TEXT_NOTE_BYTES,
} = require('../dist-electron/main/services/deliverableTextNote.js');

const PIN = `${'ab'.repeat(32)}i0`;

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deliverable-text-note-'));
}

test('isTextDocumentDeliverable: markdown/plain-text docs qualify, binaries do not', () => {
  assert.equal(isTextDocumentDeliverable('/tmp/report.md'), true);
  assert.equal(isTextDocumentDeliverable('/tmp/report.markdown'), true);
  assert.equal(isTextDocumentDeliverable('/tmp/notes.txt'), true);
  assert.equal(isTextDocumentDeliverable('/tmp/REPORT.MD'), true, 'extension match is case-insensitive');
  // Extension-less names fall back to the content-type signal.
  assert.equal(isTextDocumentDeliverable('/tmp/README', 'text/markdown'), true);
  assert.equal(isTextDocumentDeliverable('/tmp/README', 'text/plain'), true);
  assert.equal(isTextDocumentDeliverable('/tmp/README'), false);
  // Binary payloads stay on the metafile path.
  assert.equal(isTextDocumentDeliverable('/tmp/pic.png'), false);
  assert.equal(isTextDocumentDeliverable('/tmp/doc.pdf'), false);
  assert.equal(isTextDocumentDeliverable('/tmp/bundle.zip'), false);
  assert.equal(isTextDocumentDeliverable('/tmp/page.html'), false, 'HTML artifacts stay metafile');
});

test('readTextNoteDocument: title from filename, markdown content type, empty/oversize rejected', () => {
  const dir = makeTempDir();
  try {
    const mdPath = path.join(dir, 'launch-report.md');
    fs.writeFileSync(mdPath, '# Launch report\n\nAll green.\n');
    const doc = readTextNoteDocument(mdPath);
    assert.deepEqual(doc, {
      title: 'launch-report',
      content: '# Launch report\n\nAll green.\n',
      contentType: 'text/markdown',
    });

    const txtPath = path.join(dir, 'notes.txt');
    fs.writeFileSync(txtPath, 'plain notes');
    assert.equal(readTextNoteDocument(txtPath)?.contentType, 'text/plain');

    const emptyPath = path.join(dir, 'empty.md');
    fs.writeFileSync(emptyPath, '   \n');
    assert.equal(readTextNoteDocument(emptyPath), null, 'blank documents are not note-worthy');

    const bigPath = path.join(dir, 'big.md');
    fs.writeFileSync(bigPath, 'x'.repeat(MAX_TEXT_NOTE_BYTES + 1));
    assert.equal(readTextNoteDocument(bigPath), null, 'oversized documents fall back to metafile');

    assert.equal(readTextNoteDocument(path.join(dir, 'missing.md')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildTextNotePayload: simplenote payload shape mirrors post_simplenote', () => {
  const payload = JSON.parse(buildTextNotePayload({
    title: 'Report',
    content: '# body',
    contentType: 'text/markdown',
  }));
  assert.equal(payload.title, 'Report');
  assert.equal(payload.content, '# body');
  assert.equal(payload.contentType, 'text/markdown');
  assert.equal(payload.encryption, '0');
  assert.equal(typeof payload.createTime, 'number');
  assert.deepEqual(payload.tags, []);
  assert.deepEqual(payload.attachments, []);
  assert.equal(payload.coverImg, '');
  assert.equal(payload.subtitle, '');
});

test('publishTextFileAsNote: writes a /protocols/simplenote pin and returns its pinId', async () => {
  const dir = makeTempDir();
  try {
    const mdPath = path.join(dir, 'spec.md');
    fs.writeFileSync(mdPath, '# Spec\n\nBody.');
    const calls = [];
    const result = await publishTextFileAsNote({
      metabotId: 7,
      filePath: mdPath,
      createPin: async (metabotId, data, options) => {
        calls.push({ metabotId, data, options });
        return { pinId: PIN, txids: ['tx-1'] };
      },
    });
    assert.deepEqual(result, { pinId: PIN });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].metabotId, 7);
    assert.equal(calls[0].data.operation, 'create');
    assert.equal(calls[0].data.path, '/protocols/simplenote');
    assert.equal(calls[0].data.contentType, 'application/json');
    assert.equal(JSON.parse(calls[0].data.payload).title, 'spec');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('publishTextFileAsNote: non-qualifying files return null without a chain write', async () => {
  const dir = makeTempDir();
  try {
    const emptyPath = path.join(dir, 'empty.md');
    fs.writeFileSync(emptyPath, '');
    let called = 0;
    const result = await publishTextFileAsNote({
      metabotId: 7,
      filePath: emptyPath,
      createPin: async () => {
        called += 1;
        return { pinId: PIN };
      },
    });
    assert.equal(result, null);
    assert.equal(called, 0, 'no chain write for an empty/unreadable document');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('publishTextFileAsNote: a missing pinId in the chain result degrades to null', async () => {
  const dir = makeTempDir();
  try {
    const mdPath = path.join(dir, 'spec.md');
    fs.writeFileSync(mdPath, '# Spec');
    const result = await publishTextFileAsNote({
      metabotId: 7,
      filePath: mdPath,
      createPin: async () => ({ txids: ['tx-1'] }),
    });
    assert.equal(result, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
