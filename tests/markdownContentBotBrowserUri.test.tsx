import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MarkdownContent, { isBotBrowserUri } from '../src/renderer/components/MarkdownContent';

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
