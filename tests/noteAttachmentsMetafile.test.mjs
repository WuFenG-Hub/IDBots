import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const sources = [
  'SKILLs/metabot-create-metaapp/idframework/utils/note-attachments.js',
  'SKILLs/metabot-create-metaapp/templates/utils/note-attachments.js',
];

async function loadNoteAttachmentsModule(relativePath) {
  const filePath = path.join(repoRoot, relativePath);
  const source = await readFile(filePath, 'utf8');
  const transformed = `${source.replaceAll('export function ', 'function ')}
module.exports = {
  normalizeNoteAttachments,
  mergeNoteAttachments,
  resolveAttachmentUrl,
  resolveNoteCoverUrl,
  extractMetafileId,
  isMetafileUri,
};
`;
  const sandbox = {
    module: { exports: {} },
    exports: {},
    encodeURIComponent,
    Set,
    String,
    window: undefined,
  };
  vm.runInNewContext(transformed, sandbox, { filename: filePath });
  return sandbox.module.exports;
}

for (const source of sources) {
  test(`${source} appends extensions when normalizing pinId attachments`, async () => {
    const { normalizeNoteAttachments, mergeNoteAttachments } = await loadNoteAttachmentsModule(source);

    assert.deepEqual(
      Array.from(normalizeNoteAttachments([
        { pinId: 'image-pin-i0', fileName: 'cover.JPG' },
        { pinId: 'video-pin-i0', contentType: 'video/mp4' },
        { pinId: 'unknown-pin-i0' },
      ])),
      [
        'metafile://image-pin-i0.jpg',
        'metafile://video-pin-i0.mp4',
        'metafile://unknown-pin-i0',
      ],
    );

    assert.deepEqual(
      Array.from(mergeNoteAttachments(['metafile://image-pin-i0'], [{ pinId: 'image-pin-i0', fileName: 'cover.jpg' }])),
      ['metafile://image-pin-i0'],
    );
  });
}
