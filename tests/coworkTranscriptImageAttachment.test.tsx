// Transcript image attachments — a user message that carries an image
// attachment must show the picture, not the path.
//
// The composer writes each attachment into the prompt as its own
// `附件路径: <path>` line, and that same text is what the model reads, so the
// line cannot simply be dropped from the body. The transcript instead splits
// the marker lines out at RENDER time: the remaining body renders as markdown
// and the image files render as a thumbnail strip.
//
// The bug this pins: the split used to hang off the plain branch only, so a
// message that ALSO opened with a sent quote (reply-quote or selection-quote)
// fell through to a branch that rendered the body verbatim — and the paths
// showed up as text. Every branch now renders its remaining body through
// UserMessageBody.
//
// Harness note: this repo's renderer tests are server-rendered (no DOM/jsdom),
// so the wiring is pinned by reading the component source, and the marker
// splitting itself is exercised by extracting the REAL regex from that source
// and running it against the REAL composed body shape.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts: string[]): string =>
  fs.readFileSync(path.join(projectRoot, ...parts), 'utf8');

const detailSource = read('src', 'renderer', 'components', 'cowork', 'CoworkSessionDetail.tsx');
const lightboxSource = read('src', 'renderer', 'components', 'cowork', 'CoworkImageLightbox.tsx');
const composerPromptSource = read('src', 'renderer', 'components', 'cowork', 'coworkQuotedSelections.ts');

// A real message as it was actually persisted: it opens with a generated reply
// block, then the instruction, then two attachment marker lines.
const REAL_MESSAGE = [
  '> #26 助手消息：',
  '> 你刚才发的是：“这是一个测试回复”重复了 11 遍。',
  '',
  'test test',
  '',
  '附件路径: /var/folders/1k/v7v7vc757rj9zz7rk4h151k40000gn/T/idbots/attachments/image-1792426935569-bhsokg.png',
  '附件路径: /var/folders/1k/v7v7vc757rj9zz7rk4h151k40000gn/T/idbots/attachments/image-1792426940669-99qxxp.png',
].join('\n');

const extractMarkerRegex = (): RegExp => {
  // The marker regex as it literally appears in the component source.
  const line = detailSource
    .split('\n')
    .find((l) => l.includes('附件路径|附件文件|输入文件'));
  assert.ok(line, 'the attachment marker regex must exist in the component source');
  const literal = line.slice(line.indexOf('/^'), line.lastIndexOf('/i') + 2);
  return new RegExp(literal.slice(1, literal.lastIndexOf('/')), 'i');
};

test('every user-message branch renders its body through the attachment-aware body', () => {
  const bodyUses = detailSource.match(/<UserMessageBody/g) ?? [];
  assert.equal(
    bodyUses.length,
    3,
    'plain, reply-quote and selection-quote bodies must all render through UserMessageBody',
  );
  assert.ok(
    !/content=\{message\.content\}[\s\S]{0,80}className="max-w-none whitespace-pre-wrap/.test(detailSource),
    'the plain branch must not render the raw message body any more',
  );
  assert.ok(
    /resolveLocalFilePath=\{resolveLocalFilePath\}/.test(detailSource),
    'the resolver must be handed down so attachment paths can be read',
  );
  assert.ok(
    /imagePaths\.length > 0 && <ImagePreviewStrip imagePaths=\{imagePaths\} inline \/>/.test(detailSource),
    'the split images must render as an inline strip inside the bubble',
  );
});

test('the attachment marker lines split out, and the instruction and quote stay', () => {
  const regex = extractMarkerRegex();
  const lines = REAL_MESSAGE.split('\n');
  const kept: string[] = [];
  const imagePaths: string[] = [];
  for (const line of lines) {
    const marker = regex.exec(line);
    if (!marker) {
      kept.push(line);
      continue;
    }
    imagePaths.push(marker[1].trim());
  }

  assert.deepEqual(imagePaths, [
    '/var/folders/1k/v7v7vc757rj9zz7rk4h151k40000gn/T/idbots/attachments/image-1792426935569-bhsokg.png',
    '/var/folders/1k/v7v7vc757rj9zz7rk4h151k40000gn/T/idbots/attachments/image-1792426940669-99qxxp.png',
  ]);
  const body = kept.join('\n');
  assert.ok(body.includes('test test'), 'the instruction survives');
  assert.ok(body.includes('> #26 助手消息：'), 'the quote block survives');
  assert.ok(!body.includes('附件路径'), 'no marker line leaks into the rendered body');
});

test('a marker whose path is not an image stays in the body as text', () => {
  const regex = extractMarkerRegex();
  const marker = regex.exec('附件路径: /tmp/notes/report.pdf');
  assert.ok(marker, 'the marker still matches a non-image attachment');
  assert.equal(marker[1].trim(), '/tmp/notes/report.pdf');
  // The component gates on the image extension before moving the line out, so a
  // non-image marker is kept; the extension check is what decides.
  assert.ok(
    /hasSupportedImageExtension\(/.test(detailSource),
    'the split must be gated on a supported image extension',
  );
});

test('a transcript thumbnail opens in-app, and the payload path is untouched', () => {
  assert.ok(
    /import CoworkImageLightbox from '\.\/CoworkImageLightbox';/.test(detailSource),
    'the transcript must import the in-app lightbox',
  );
  assert.ok(
    /setLightboxSrc\(previewData\[imagePath\]\)/.test(detailSource),
    'clicking a thumbnail must open the lightbox',
  );
  assert.ok(
    !/handleOpenPath/.test(detailSource),
    'the image strip must not hand the picture to the OS viewer any more',
  );
  assert.ok(
    /role="dialog"/.test(lightboxSource) && /event\.key === 'Escape'/.test(lightboxSource),
    'the lightbox must be an accessible dialog that closes on Escape',
  );
  // Display-only boundary: the splitter is never wired into prompt composition.
  assert.ok(
    !composerPromptSource.includes('splitUserAttachmentLines'),
    'the submitted prompt body must never go through the display-side splitter',
  );
  const splitUses = detailSource.match(/splitUserAttachmentLines/g) ?? [];
  assert.equal(
    splitUses.length,
    2,
    'the splitter is defined once and used once (inside UserMessageBody) — nowhere near the submit path',
  );
});
