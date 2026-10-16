// The composer used to render every attachment as the same filename pill, so a
// pasted screenshot showed up as "image-1730000000000.png" instead of as the
// picture the user just attached. Image paths now render as a rounded 64px
// thumbnail fed by the same readLocalImage IPC the transcript preview uses.
//
// Three properties are load-bearing here and each gets a test:
//   (a) an image path renders <img src=dataUrl> and never the file name as
//       visible text;
//   (b) a non-image path keeps the paperclip + file-name pill, untouched;
//   (c) a failed read neither throws nor leaves a blank chip — it degrades to
//       the non-empty pill, and a pending read shows a placeholder tile.

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import CoworkAttachmentPreview from '../src/renderer/components/cowork/CoworkAttachmentPreview';
import { i18nService } from '../src/renderer/services/i18n';
import { loadLocalImagePreview } from '../src/renderer/utils/localImage';

type ReadLocalImageOptions = { path: string; maxBytes?: number };
type ReadLocalImageResult = { success: boolean; dataUrl?: string; error?: string };
type ReadLocalImage = (options: ReadLocalImageOptions) => Promise<ReadLocalImageResult>;

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// Escaped for RegExp: the pill's truncation class carries a Tailwind bracket.
const PILL_CLASS_MARKER = 'truncate max-w-\\[180px\\]';
const THUMBNAIL_CLASS_MARKER = 'h-16 w-16';

/** Every read the component / helper performs, so tests can assert call counts. */
const readCalls: ReadLocalImageOptions[] = [];

const installReadLocalImage = (impl: ReadLocalImage): void => {
  readCalls.length = 0;
  (globalThis as { window?: unknown }).window = {
    electron: {
      cowork: {
        readLocalImage: (options: ReadLocalImageOptions) => {
          readCalls.push(options);
          return impl(options);
        },
      },
    },
  };
};

/** Visible text only: tags (and therefore their attributes) are dropped. */
const visibleText = (markup: string): string => markup
  .replace(/<[^>]*>/g, ' ')
  .replace(/&quot;/g, '"')
  .replace(/&#x27;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

const renderAttachment = (
  attachment: { path: string; name: string },
  removeDisabled = false,
): string => renderToStaticMarkup(
  <CoworkAttachmentPreview
    attachment={attachment}
    removeDisabled={removeDisabled}
    onRemove={() => {}}
  />,
);

const imgSrcOf = (markup: string): string | null => {
  const match = /<img[^>]*\ssrc="([^"]*)"/.exec(markup);
  return match ? match[1] : null;
};

test('an image attachment renders a thumbnail fed by the readLocalImage dataUrl', async () => {
  const path = '/tmp/cowork-composer-thumbnails/pasted-screenshot.png';
  let impl: ReadLocalImageResult = { success: false };
  installReadLocalImage(async () => impl);
  impl = { success: true, dataUrl: PNG_DATA_URL };

  const entry = await loadLocalImagePreview(path);
  assert.equal(entry.status, 'ready');
  assert.equal(readCalls.length, 1);
  assert.equal(readCalls[0].path, path);
  assert.equal(readCalls[0].maxBytes, 10 * 1024 * 1024);

  const markup = renderAttachment({ path, name: 'pasted-screenshot.png' });

  assert.match(markup, /<img/);
  assert.equal(imgSrcOf(markup), PNG_DATA_URL);
  assert.match(markup, /object-cover/);
  assert.match(markup, new RegExp(THUMBNAIL_CLASS_MARKER));
  // The file name is not visible text anymore; the pill shape is gone with it.
  // (The path still rides in the title attribute, which is a tooltip, not text.)
  assert.equal(visibleText(markup).includes('pasted-screenshot.png'), false);
  assert.doesNotMatch(markup, new RegExp(PILL_CLASS_MARKER));
});

test('a non-image attachment keeps the paperclip + filename pill and is never read as an image', () => {
  const path = '/tmp/cowork-composer-thumbnails/meeting-notes.txt';
  installReadLocalImage(async () => ({ success: true, dataUrl: PNG_DATA_URL }));

  const markup = renderAttachment({ path, name: 'meeting-notes.txt' });

  assert.doesNotMatch(markup, /<img/);
  assert.match(markup, new RegExp(PILL_CLASS_MARKER));
  assert.ok(visibleText(markup).includes('meeting-notes.txt'));
  assert.equal(readCalls.length, 0);
});

test('a failed read does not throw and degrades to the non-empty pill', async () => {
  const path = '/tmp/cowork-composer-thumbnails/unreadable.png';
  installReadLocalImage(async () => ({ success: false, error: 'Image file not found' }));

  const entry = await loadLocalImagePreview(path);
  assert.equal(entry.status, 'error');

  const markup = renderAttachment({ path, name: 'unreadable.png' });

  assert.doesNotMatch(markup, /<img/);
  assert.match(markup, new RegExp(PILL_CLASS_MARKER));
  assert.ok(visibleText(markup).includes('unreadable.png'));
});

test('a rejected read is swallowed the same way as a failed one', async () => {
  const path = '/tmp/cowork-composer-thumbnails/rejected.png';
  installReadLocalImage(async () => {
    throw new Error('IPC channel unavailable');
  });

  const entry = await loadLocalImagePreview(path);
  assert.equal(entry.status, 'error');

  const markup = renderAttachment({ path, name: 'rejected.png' });
  assert.equal(visibleText(markup).includes('rejected.png'), true);
});

test('a pending read shows a labelled placeholder tile, not an empty chip', () => {
  const path = '/tmp/cowork-composer-thumbnails/still-loading.png';
  installReadLocalImage(async () => ({ success: true, dataUrl: PNG_DATA_URL }));

  const markup = renderAttachment({ path, name: 'still-loading.png' });

  assert.doesNotMatch(markup, /<img/);
  assert.match(markup, new RegExp(THUMBNAIL_CLASS_MARKER));
  assert.doesNotMatch(markup, new RegExp(PILL_CLASS_MARKER));
  assert.match(markup, new RegExp(`aria-label="${i18nService.t('coworkAttachmentImageLoading')}"`));
  assert.equal(visibleText(markup).includes('still-loading.png'), false);
  assert.equal(readCalls.length, 0);
});
