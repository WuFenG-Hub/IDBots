// Bot output habitually uses `~` as a range separator ("一周 1~3 次，单次
// 100~300 元"). GFM treats a single-tilde pair as strikethrough, which paired
// those ranges into a false deletion line. MarkdownContent passes
// `singleTilde: false` to remark-gfm so only ~~double~~ tildes strike;
// every other GFM feature must keep working.

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MarkdownContent from '../src/renderer/components/MarkdownContent';

const RANGE_SENTENCE = '固定学员是周级高频（一周 1~3 次），单次 100~300 元';

test('single-tilde ranges render as literal text, not strikethrough', () => {
  globalThis.window = { electron: { platform: 'darwin' } } as never;
  try {
    const markup = renderToStaticMarkup(<MarkdownContent content={RANGE_SENTENCE} />);
    assert.doesNotMatch(markup, /<del/);
    assert.match(markup, /1~3 次/);
    assert.match(markup, /100~300 元/);
  } finally {
    delete (globalThis as Record<string, unknown>).window;
  }
});

test('double-tilde strikethrough keeps working', () => {
  globalThis.window = { electron: { platform: 'darwin' } } as never;
  try {
    const markup = renderToStaticMarkup(
      <MarkdownContent content="~~已废弃的方案~~" />,
    );
    assert.match(markup, /<del>已废弃的方案<\/del>/);
  } finally {
    delete (globalThis as Record<string, unknown>).window;
  }
});

test('other GFM features survive: tables with tilde ranges stay tables, not deletes', () => {
  globalThis.window = { electron: { platform: 'darwin' } } as never;
  try {
    const markup = renderToStaticMarkup(
      <MarkdownContent
        content={'| 频次 | 客单 |\n| --- | --- |\n| 一周 1~3 次 | 100~300 元 |'}
      />,
    );
    assert.match(markup, /<table[\s>]/);
    assert.match(markup, /一周 1~3 次/);
    assert.doesNotMatch(markup, /<del/);
  } finally {
    delete (globalThis as Record<string, unknown>).window;
  }
});
