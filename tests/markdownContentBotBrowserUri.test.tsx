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
  assert.match(output, /`code metaapp:\/\/aaa`/);
  assert.doesNotMatch(output, /\[https:\/\/example\.com\]/);
});

test('linkify trims trailing punctuation and covers all agent internet schemes', () => {
  const output = linkifyAgentInternetUris('open metaid://idq1abc, then pin://deadbeef.');
  assert.match(output, /\[metaid:\/\/idq1abc\]\(metaid:\/\/idq1abc\),/);
  assert.match(output, /\[pin:\/\/deadbeef\]\(pin:\/\/deadbeef\)\./);
});
