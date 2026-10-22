// Assistant mode renders a link to a local .html/.htm file as an inline
// HTML report block (full message-column width, sandboxed srcdoc iframe with
// content-height tracking) instead of the previous report card. The block
// itself falls back to the report card when the file cannot be read, so the
// message never shows a broken frame. Professional mode must keep the plain
// inline link, and the block's side-panel action flows through the same
// onOpenLocalFile path as any local file link.
//
// Harness note: this repo's renderer tests are server-rendered (no DOM/jsdom),
// so the success-path iframe and the postMessage height flow are covered in
// tests/inlineHtmlReportBlock.test.tsx through the block's exported pure
// helpers plus source wiring assertions; these tests pin the MarkdownContent
// branch and the SSR-loading shell.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MarkdownContent from '../src/renderer/components/MarkdownContent';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sessionDetailSource = fs.readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'cowork', 'CoworkSessionDetail.tsx'),
  'utf8',
);
const markdownSource = fs.readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'MarkdownContent.tsx'),
  'utf8',
);
const blockSource = fs.readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'cowork', 'InlineHtmlReportBlock.tsx'),
  'utf8',
);

const REPORT_LINK = '[季度调研报告](file:///tmp/out/report.html)';

// InlineHtmlReportBlock reads window.electron.platform while rendering, so
// SSR needs the same global stub the professional-mode tests set.
const withWindowStub = (fn: () => void): void => {
  globalThis.window = { electron: { platform: 'darwin' } } as never;
  try {
    fn();
  } finally {
    delete (globalThis as Record<string, unknown>).window;
  }
};

test('assistant mode renders a local .html link as the inline report block', () => {
  withWindowStub(() => {
    const markup = renderToStaticMarkup(
      <MarkdownContent
        content={REPORT_LINK}
        chatExperienceMode="assistant"
        onOpenLocalFile={() => true}
      />,
    );
    // Block shell with the localized badge and the file path, no old card.
    assert.match(markup, /data-inline-html-report="\/tmp\/out\/report\.html"/);
    assert.match(markup, /HTML report/);
    assert.match(markup, /季度调研报告/);
    assert.doesNotMatch(markup, /flex w-full items-center gap-3 rounded-xl/);
  });
});

test('assistant mode covers the .htm extension too', () => {
  withWindowStub(() => {
    const markup = renderToStaticMarkup(
      <MarkdownContent
        content={'[r](file:///tmp/out/report.htm)'}
        chatExperienceMode="assistant"
        onOpenLocalFile={() => true}
      />,
    );
    assert.match(markup, /data-inline-html-report="\/tmp\/out\/report\.htm"/);
  });
});

test('the loading block renders no iframe and no broken frame', () => {
  withWindowStub(() => {
    const markup = renderToStaticMarkup(
      <MarkdownContent
        content={REPORT_LINK}
        chatExperienceMode="assistant"
        onOpenLocalFile={() => true}
      />,
    );
    assert.doesNotMatch(markup, /<iframe/);
    assert.match(markup, /Loading report/);
  });
});

test('MarkdownContent wires the assistant branch to InlineHtmlReportBlock with the side-panel chain', () => {
  // The assistant branch must render the inline block (not a bare anchor and
  // not the old card), and the block's "open in side panel" action reuses the
  // onOpenLocalFile chain that CoworkSessionDetail routes to
  // setMarkdownViewerPath.
  assert.match(
    markdownSource,
    /chatExperienceMode === 'assistant' && HTML_FILE_RE\.test\(filePath\)\) \{\s*return \(\s*<InlineHtmlReportBlock/,
  );
  assert.match(markdownSource, /onOpenInSidePanel=\{onOpenLocalFile\}/);
});

test('the block degrades to the previous report card when the file cannot be read', () => {
  // Read failure (missing / not a file / too large / binary) must fall back
  // to the card the assistant mode rendered before, through LocalFileLink so
  // the card keeps its right-click menu, and never render an empty iframe.
  assert.match(blockSource, /window\.electron\.fs\.readTextFile\(filePath\)/);
  assert.match(blockSource, /setStatus\('fallback'\)/);
  assert.match(
    blockSource,
    /status === 'fallback'[\s\S]*<LocalFileLink[\s\S]*wrapperClassName="block w-full"[\s\S]*showTypeIcon=\{false\}/,
  );
  assert.match(blockSource, /i18nService\.t\('htmlReportHint'\)/);
});

test('the block frame is sandboxed, non-scrolling and content-height sized', () => {
  assert.match(blockSource, /sandbox="allow-scripts"/);
  assert.match(blockSource, /scrolling="no"/);
  assert.match(blockSource, /const iframeWindow = iframeRef\.current\?\.contentWindow \?\? null;/);
  assert.match(blockSource, /parseInlineHtmlHeightMessage\(event\.data, event\.source, iframeWindow\)/);
});

test('professional mode keeps the plain inline link (no block, no card)', () => {
  globalThis.window = { electron: { platform: 'darwin' } } as never;
  try {
    const markup = renderToStaticMarkup(
      <MarkdownContent content={REPORT_LINK} chatExperienceMode="professional" />,
    );
    assert.doesNotMatch(markup, /data-inline-html-report/);
    assert.doesNotMatch(markup, /HTML report/);
    assert.doesNotMatch(markup, /rounded-xl/);
    assert.match(markup, /季度调研报告/);
  } finally {
    delete (globalThis as Record<string, unknown>).window;
  }
});

test('professional mode is the default when no mode is passed', () => {
  globalThis.window = { electron: { platform: 'darwin' } } as never;
  try {
    const markup = renderToStaticMarkup(
      <MarkdownContent content={REPORT_LINK} />,
    );
    assert.doesNotMatch(markup, /data-inline-html-report/);
    assert.doesNotMatch(markup, /HTML report/);
  } finally {
    delete (globalThis as Record<string, unknown>).window;
  }
});

test('assistant mode leaves non-HTML file links inline', () => {
  globalThis.window = { electron: { platform: 'darwin' } } as never;
  try {
    const markup = renderToStaticMarkup(
      <MarkdownContent
        content={'[notes](file:///tmp/notes.md)'}
        chatExperienceMode="assistant"
      />,
    );
    assert.doesNotMatch(markup, /data-inline-html-report/);
    assert.match(markup, /notes\.md/);
  } finally {
    delete (globalThis as Record<string, unknown>).window;
  }
});

test('CoworkSessionDetail threads the chat experience mode into assistant message markdown', () => {
  assert.match(
    sessionDetailSource,
    /chatExperienceMode=\{isAssistantMode \? 'assistant' : 'professional'\}/,
  );
});
