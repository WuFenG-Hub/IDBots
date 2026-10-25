import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MarkdownContent, { linkifyAgentInternetUris } from '../src/renderer/components/MarkdownContent';

const PIN = 'bc6f74edc9d009f7863edd6bc4ee5c992c8c63d6bfec632a8a8b309e2268fb3di0';

test('a markdown link whose visible text is itself a scheme URI is not double-wrapped', () => {
  const input = `① 记录规范 v0.2 已读 [pin://${PIN}](pin://${PIN}) : 冻结 taskid`;
  const output = linkifyAgentInternetUris(input);
  // The original markdown link survives verbatim (exactly once).
  assert.equal((output.match(new RegExp(`\\[pin://${PIN}\\]\\(pin://${PIN}\\)`, 'g')) || []).length, 1);
  // No nested second wrap of the link text.
  assert.ok(!output.includes(`[[pin://${PIN}]`));
});

test('rendering a URI-text markdown link yields exactly one anchor and no literal ]( tail', () => {
  const markup = renderToStaticMarkup(
    React.createElement(MarkdownContent, {
      content: `已读 [pin://${PIN}](pin://${PIN}) ： 冻结 taskid`,
    }),
  );
  const anchors = (markup.match(/<a /g) || []).length;
  assert.equal(anchors, 1);
  assert.match(markup, new RegExp(`href="pin://${PIN}"`));
  // The broken-nesting artifact (literal destination tail) must be gone.
  assert.ok(!markup.includes(`](${`pin://${PIN}`})`));
});

test('a markdown link whose text merely contains a scheme URI mid-text is also untouched', () => {
  const input = `see [the doc pin://${PIN} here](pin://${PIN}) ok`;
  const output = linkifyAgentInternetUris(input);
  assert.equal(output, input);
});

test('bare URIs around markdown links are still linkified', () => {
  const input = `plain pin://${PIN} and [linked](metaid://idq1xyz) trailing metaapp://aaa`;
  const output = linkifyAgentInternetUris(input);
  assert.match(output, /\[pin:\/\/bc6f74ed[^\]]*\]\(pin:\/\//);
  assert.match(output, /\[metaapp:\/\/aaa\]\(metaapp:\/\/aaa\)/);
  assert.equal((output.match(/\[linked\]\(metaid:\/\/idq1xyz\)/g) || []).length, 1);
});

test('image links with scheme destinations are not corrupted', () => {
  const input = `![cover](metafile://${PIN})`;
  const output = linkifyAgentInternetUris(input);
  assert.equal(output, input);
});

test('bracket text that is not a link still linkifies the bare URI inside it', () => {
  const input = `[see pin://${PIN}] not a link`;
  const output = linkifyAgentInternetUris(input);
  // The URI inside non-link brackets is still wrapped as its own markdown
  // link (pre-existing behaviour, unchanged by the link-span protection).
  assert.match(output, /\[pin:\/\/bc6f74ed[^\]]*\]\(pin:\/\//);
  // …and exactly once — no double wrap of the URI itself.
  assert.equal((output.match(new RegExp(`pin://${PIN}`, 'g')) || []).length, 2);
});
