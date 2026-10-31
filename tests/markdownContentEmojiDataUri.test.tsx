// SSR regression — "src survival" for bundled Twemoji inside MarkdownContent.
//
// Why this test exists: MarkdownContent passes `urlTransform={safeUrlTransform}`
// to react-markdown, and safeUrlTransform scrubs any URL whose scheme is not in
// SAFE_URL_PROTOCOLS to '' (broken-image icon + alt-text fallback). The Twemoji
// pipeline (remarkTwemoji -> inline `image` mdast nodes) emits `data:image/
// svg+xml` URIs (twemoji.ts holds the 85 SVGs as inline data URIs so the asset
// is bundler-independent). Those URIs were washed to src='' because the
// whitelist had no `data` entry.
//
// The dev/packaged fork this pins: in dev, the old `new URL(…, import.meta.url)`
// asset form resolved to relative paths (`/src/.../1f642.svg`) which have NO
// scheme, so they took the `!match` pass-through branch of safeUrlTransform and
// rendered fine; in the packaged build vite inlined the small SVGs as
// `data:image/svg+xml` URIs which took the protocol branch and were scrubbed.
// The earlier emoji SSR tests only asserted <img> presence + alt (never that
// src survived the transform), so 200+ green tests coexisted with a broken
// packaged build. This file asserts src SURVIVAL.
//
// Safety boundary: only `data:image/*` may pass. Bare `data:` of any other
// type (data:text/html, data:text/javascript, …) and `javascript:` must stay
// blocked — the whitelist stays closed for hrefs.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MarkdownContent from '../src/renderer/components/MarkdownContent';
import { twemojiUrlFor } from '../src/renderer/components/chat/twemoji';

const withWindowMock = (fn: () => void): void => {
  (globalThis as Record<string, unknown>).window = { electron: { platform: 'darwin' } };
  try {
    fn();
  } finally {
    delete (globalThis as Record<string, unknown>).window;
  }
};

/** Pull the single rendered <img …> tag out of the markup. */
const firstImg = (markup: string): string => {
  const match = markup.match(/<img\b[^>]*>/);
  assert.ok(match, `expected an <img> in the rendered markup, got: ${markup.slice(0, 200)}`);
  return match[0];
};

const srcOf = (imgTag: string): string => {
  const match = imgTag.match(/src="([^"]*)"/);
  assert.ok(match, `expected a src attribute on ${imgTag.slice(0, 120)}`);
  return match[1];
};

test('emojiImages pipeline emits data:image/svg+xml urls from the bundled catalog', () => {
  withWindowMock(() => {
    const url = twemojiUrlFor('🙂');
    assert.ok(url, "twemojiUrlFor('🙂') must resolve a bundled asset");
    assert.ok(
      url.startsWith('data:image/svg+xml'),
      `bundled asset must be an inline data:image/svg+xml URI, got: ${url.slice(0, 40)}…`,
    );
  });
});

test('MarkdownContent + emojiImages renders catalog emoji with a LIVE data:image/svg+xml src', () => {
  withWindowMock(() => {
    const markup = renderToStaticMarkup(
      <MarkdownContent content="你好🙂世界" emojiImages />,
    );
    const imgTag = firstImg(markup);
    assert.match(imgTag, /alt="🙂"/, 'alt must carry the codepoint for tests and screen readers');
    const src = srcOf(imgTag);
    assert.ok(
      src.startsWith('data:image/svg+xml'),
      `img src must SURVIVE the url transform and start with data:image/svg+xml; ` +
        `got ${src.length === 0 ? 'an EMPTY src (scrubbed by safeUrlTransform)' : `src="${src.slice(0, 60)}…"`}`,
    );
  });
});

test('non-image data: payloads stay blocked (src must not become a bare data: whitelist hole)', () => {
  withWindowMock(() => {
    const markup = renderToStaticMarkup(
      <MarkdownContent content={'![payload](data:text/html;base64,PGh0bWw+)'} />,
    );
    if (markup.includes('<img')) {
      const src = srcOf(firstImg(markup));
      assert.ok(!src.startsWith('data:'), `non-image data: url must be scrubbed, got src="${src.slice(0, 60)}"`);
    }
    // Either way the payload must not leak through as a live src.
    assert.ok(!/src="data:text\/html/.test(markup), 'data:text/html must never render as a live src');
  });
});

test('non-manifest data:image URIs stay blocked (exact bundled-artwork allow)', () => {
  withWindowMock(() => {
    const markup = renderToStaticMarkup(
      <MarkdownContent content={'![x](data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%3E%3C/svg%3E)'} />,
    );
    if (markup.includes('<img')) {
      const src = srcOf(firstImg(markup));
      assert.ok(!src.startsWith('data:'), `non-bundled data:image must be scrubbed, got src="${src.slice(0, 60)}"`);
    }
    assert.ok(!/src="data:image/.test(markup), 'non-bundled data:image must never render as a live src');
  });
});

test('javascript: urls stay blocked', () => {
  withWindowMock(() => {
    const markup = renderToStaticMarkup(
      <MarkdownContent content='[click](javascript:alert(1))' />,
    );
    assert.ok(!/href="javascript:/i.test(markup), 'javascript: href must be scrubbed');
  });
});
