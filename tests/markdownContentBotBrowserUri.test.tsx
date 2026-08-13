import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MarkdownContent, { isBotBrowserUri, linkifyAgentInternetUris } from '../src/renderer/components/MarkdownContent';

test('isBotBrowserUri recognizes agent internet schemes', () => {
  assert.equal(isBotBrowserUri('metaapp://abc123i0'), true);
  assert.equal(isBotBrowserUri('metaid://idq1xyz'), true);
  assert.equal(isBotBrowserUri('map://alias'), true);
  assert.equal(isBotBrowserUri('metafile://pin.png'), true);
  assert.equal(isBotBrowserUri('preview-metaapp://localhost/tmp/app'), true);
  assert.equal(isBotBrowserUri('https://example.com'), false);
  assert.equal(isBotBrowserUri('file:///tmp/a'), false);
  assert.equal(isBotBrowserUri('javascript:alert(1)'), false);
});

test('agent internet links keep their href and become clickable with an opener', () => {
  const markup = renderToStaticMarkup(
    React.createElement(MarkdownContent, {
      content: '[Buzz Client](metaapp://84b78cchi0) and [Bob](metaid://idq1xyz)',
      onOpenBotBrowserUri: () => {},
    }),
  );
  assert.match(markup, /href="metaapp:\/\/84b78cchi0"/);
  assert.match(markup, /href="metaid:\/\/idq1xyz"/);
});

test('agent internet links keep their href even without an opener', () => {
  const markup = renderToStaticMarkup(
    React.createElement(MarkdownContent, {
      content: '[Buzz Client](metaapp://84b78cchi0)',
    }),
  );
  assert.match(markup, /href="metaapp:\/\/84b78cchi0"/);
});

test('dangerous schemes are stripped by the url transform', () => {
  const markup = renderToStaticMarkup(
    React.createElement(MarkdownContent, {
      content: '[x](javascript:alert(1))',
    }),
  );
  assert.doesNotMatch(markup, /javascript:/);
});

test('bare agent internet uris are linkified; existing links and code are untouched', () => {
  const input = [
    'play metaapp://6185c9f340c0be92c0466503c53c8c1b54e91dbd472c70c852aa127c35c72ecbi0 now',
    'already [linked](metaid://idq1xyz)',
    '`code metaapp://aaa`',
    'see https://example.com',
  ].join('\n');
  const output = linkifyAgentInternetUris(input);
  assert.match(output, /\[metaapp:\/\/6185c9f340c0be92c0466503c53c8c1b54e91dbd472c70c852aa127c35c72ecbi0\]\(metaapp:\/\/6185c9f340c0be92c0466503c53c8c1b54e91dbd472c70c852aa127c35c72ecbi0\)/);
  // No double-wrapping of existing markdown links
  assert.equal((output.match(/\[linked\]\(metaid:\/\/idq1xyz\)/g) || []).length, 1);
  // R3: a metaweb URI wrapped in INLINE backticks is now linkified too (bots
  // habitually wrap URIs in backticks); only code BLOCKS stay verbatim.
  assert.match(output, /\[metaapp:\/\/aaa\]\(metaapp:\/\/aaa\)/);
  assert.doesNotMatch(output, /\[https:\/\/example\.com\]/);
});

test('linkify trims trailing punctuation and covers all agent internet schemes', () => {
  const output = linkifyAgentInternetUris('open metaid://idq1abc, then pin://deadbeef.');
  assert.match(output, /\[metaid:\/\/idq1abc\]\(metaid:\/\/idq1abc\),/);
  assert.match(output, /\[pin:\/\/deadbeef\]\(pin:\/\/deadbeef\)\./);
});

test('R3: a bare pin id (64 hex + i0) becomes a clickable pin:// link', () => {
  const pin = '9d51fea7b26fc0ded56d436d85425c960593ac216b8ca46096f43b73255875f6i0';
  const output = linkifyAgentInternetUris(`see deliverable ${pin} for details`);
  assert.match(output, new RegExp(`\\[${pin}\\]\\(pin://${pin}\\)`));
});

test('R3: a bare pin id that is the tail of a scheme URI is NOT double-linkified', () => {
  const pin = '9d51fea7b26fc0ded56d436d85425c960593ac216b8ca46096f43b73255875f6i0';
  const output = linkifyAgentInternetUris(`metaapp://${pin}`);
  // The whole URI becomes one link; the pin tail is not separately wrapped.
  assert.match(output, new RegExp(`\\[metaapp://${pin}\\]\\(metaapp://${pin}\\)`));
  assert.doesNotMatch(output, new RegExp(`\\[${pin}\\]\\(pin://${pin}\\)`));
});

test('R3: a metaweb URI wrapped in inline backticks is still linkified', () => {
  const output = linkifyAgentInternetUris('deliverable at `metaapp://abc123i0`');
  assert.match(output, /\[metaapp:\/\/abc123i0\]\(metaapp:\/\/abc123i0\)/);
});

test('R3: a code BLOCK (triple backtick) is left untouched', () => {
  const output = linkifyAgentInternetUris('```\nmetaapp://abc123i0\n```');
  assert.doesNotMatch(output, /\[metaapp:\/\/abc123i0\]/);
  assert.match(output, /metaapp:\/\/abc123i0/);
});

test('R3: inline backticks without a URI are preserved as code', () => {
  const output = linkifyAgentInternetUris('plain `code snippet` here');
  assert.equal(output, 'plain `code snippet` here');
});
