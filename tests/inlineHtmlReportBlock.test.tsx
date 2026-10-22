// InlineHtmlReportBlock — assistant-mode HTML report rendered in place.
//
// Covers the block's testable surface without a DOM (this repo's renderer
// tests are server-rendered, no jsdom):
//   (a) the SSR-loading shell renders the header + placeholder and never an
//       empty iframe;
//   (b) buildInlineHtmlSrcDoc keeps the original document, injects the
//       file-directory <base href>, and installs the ResizeObserver
//       height-reporter before </body> (or at the end when there is no body);
//   (c) parseInlineHtmlHeightMessage enforces the per-instance contract —
//       marked payload, finite numeric height, source must be exactly this
//       block's iframe contentWindow — and clamps the result;
//   (d) source wiring pins: the export action goes through the new
//       cowork:htmlReport:exportImage IPC (preload + allowlist + main-process
//       hidden-window capture), the source view uses the prism 'markup'
//       grammar, and the right-click menu carries the file actions.
//
// The live postMessage -> setHeight round-trip needs a DOM MessageEvent and
// is intentionally covered by (c)'s parser contract plus the wiring pin in
// tests/markdownContentHtmlReportCard.test.tsx.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import InlineHtmlReportBlock, {
  INLINE_HTML_HEIGHT_MESSAGE_KEY,
  buildInlineHtmlReporterScript,
  buildInlineHtmlSrcDoc,
  clampInlineHtmlHeight,
  parseInlineHtmlHeightMessage,
} from '../src/renderer/components/cowork/InlineHtmlReportBlock';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const blockSource = fs.readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'cowork', 'InlineHtmlReportBlock.tsx'),
  'utf8',
);
const preloadSource = fs.readFileSync(
  path.join(projectRoot, 'src', 'main', 'preload.ts'),
  'utf8',
);
const allowlistSource = fs.readFileSync(
  path.join(projectRoot, 'src', 'main', 'gateway', 'allowlist.ts'),
  'utf8',
);
const mainSource = fs.readFileSync(
  path.join(projectRoot, 'src', 'main', 'main.ts'),
  'utf8',
);

const REPORT_PATH = '/tmp/out/report.html';

const withWindowStub = (fn: () => void): void => {
  globalThis.window = { electron: { platform: 'darwin' } } as never;
  try {
    fn();
  } finally {
    delete (globalThis as Record<string, unknown>).window;
  }
};

test('the loading shell renders the title and placeholder without an iframe', () => {
  withWindowStub(() => {
    const markup = renderToStaticMarkup(
      <InlineHtmlReportBlock
        filePath={REPORT_PATH}
        displayName="Quarterly Research Report"
        onOpenInSidePanel={() => undefined}
      />,
    );
    assert.match(markup, /Quarterly Research Report/);
    assert.match(markup, /HTML report/);
    assert.match(markup, /Loading report/);
    assert.doesNotMatch(markup, /<iframe/);
  });
});

test('srcdoc keeps the document and injects base href plus the reporter script before </body>', () => {
  const html = '<!doctype html><html><head><title>t</title></head><body><h1>Report</h1></body></html>';
  const srcDoc = buildInlineHtmlSrcDoc(html, REPORT_PATH);
  assert.ok(srcDoc.includes('<h1>Report</h1>'));
  assert.match(srcDoc, /<base href="file:\/\/\/tmp\/out\/">/);
  const reporterAt = srcDoc.indexOf('parent.postMessage');
  const bodyCloseAt = srcDoc.indexOf('</body>');
  assert.ok(reporterAt !== -1, 'reporter script must be present');
  assert.ok(bodyCloseAt !== -1 && reporterAt < bodyCloseAt, 'reporter must be injected before </body>');
  assert.match(srcDoc, new RegExp(INLINE_HTML_HEIGHT_MESSAGE_KEY));
});

test('srcdoc appends the reporter at the end when the document has no body close tag', () => {
  const html = '<html><body><p>fragment';
  const srcDoc = buildInlineHtmlSrcDoc(html, REPORT_PATH);
  assert.ok(srcDoc.startsWith('<base href="file:///tmp/out/">'));
  assert.ok(srcDoc.includes('<p>fragment'));
  const reporterAt = srcDoc.indexOf('parent.postMessage');
  assert.ok(reporterAt > srcDoc.indexOf('<p>fragment'), 'reporter appended after the content');
});

test('the reporter script observes resize, load and delayed settle reports', () => {
  const script = buildInlineHtmlReporterScript();
  assert.match(script, /ResizeObserver/);
  assert.match(script, /observe\(document\.documentElement\)/);
  assert.match(script, /window\.addEventListener\("load", reportHeight\)/);
  assert.match(script, /setTimeout\(reportHeight, 300\)/);
  assert.match(script, /setTimeout\(reportHeight, 1000\)/);
  assert.match(script, /parent\.postMessage\(\{ \[KEY\]: true, h: h \}, "\*"\)/);
  assert.ok(!script.includes('</script>'), 'the inline script must not break the srcdoc script tag');
});

test('height messages are accepted only from this block iframe and clamped', () => {
  const iframeWindow = { name: 'frame-a' };
  const otherWindow = { name: 'frame-b' };

  assert.equal(
    parseInlineHtmlHeightMessage({ [INLINE_HTML_HEIGHT_MESSAGE_KEY]: true, h: 520 }, iframeWindow, iframeWindow),
    520,
  );
  // Another block's frame (or any window) must not drive this height.
  assert.equal(
    parseInlineHtmlHeightMessage({ [INLINE_HTML_HEIGHT_MESSAGE_KEY]: true, h: 520 }, otherWindow, iframeWindow),
    null,
  );
  // Missing marker, wrong marker value, non-number height: all ignored.
  assert.equal(parseInlineHtmlHeightMessage({ h: 520 }, iframeWindow, iframeWindow), null);
  assert.equal(
    parseInlineHtmlHeightMessage({ [INLINE_HTML_HEIGHT_MESSAGE_KEY]: false, h: 520 }, iframeWindow, iframeWindow),
    null,
  );
  assert.equal(
    parseInlineHtmlHeightMessage({ [INLINE_HTML_HEIGHT_MESSAGE_KEY]: true, h: '520' }, iframeWindow, iframeWindow),
    null,
  );
  // Bounds: never below 40, never above 10000.
  assert.equal(clampInlineHtmlHeight(5), 40);
  assert.equal(clampInlineHtmlHeight(999999), 10000);
  assert.equal(
    parseInlineHtmlHeightMessage({ [INLINE_HTML_HEIGHT_MESSAGE_KEY]: true, h: 5 }, iframeWindow, iframeWindow),
    40,
  );
});

test('the export action goes through the hidden-window capture IPC end to end', () => {
  // Renderer bridge.
  assert.match(
    preloadSource,
    /exportHtmlReportImage: \(options: \{ filePath: string; width\?: number; suggestedName\?: string \}\) =>\s*ipcRenderer\.invoke\('cowork:htmlReport:exportImage', options\)/,
  );
  // Gateway allowlist (invoke channels are default-deny).
  assert.match(
    allowlistSource,
    /'cowork:htmlReport:exportImage': \{ tier: 'N', note: '[^']*' \}/,
  );
  // Main process: hidden sandboxed window, content-height sizing, PNG capture,
  // save dialog, and the window is always destroyed.
  assert.match(mainSource, /registerIpcHandler\('cowork:htmlReport:exportImage'/);
  assert.match(mainSource, /new BrowserWindow\(\{\s*show: false,[\s\S]*webPreferences: \{ sandbox: true, disableDialogs: true \}[\s\S]*\}\)/);
  assert.match(mainSource, /hiddenWindow\.setContentSize\(width, contentHeight\)/);
  assert.match(mainSource, /hiddenWindow\.webContents\.capturePage\(\)/);
  assert.match(mainSource, /dialog\.showSaveDialog/);
  assert.match(mainSource, /hiddenWindow\.destroy\(\)/);
  // Width is sanitized into the capture-safe range.
  assert.match(mainSource, /Math\.min\(2000, Math\.max\(320, Math\.round\(requestedWidth\)\)\)/);
});

test('the source view highlights as markup and the menu carries the file actions', () => {
  assert.match(blockSource, /SyntaxHighlighter/);
  assert.match(blockSource, /language="markup"/);
  assert.match(blockSource, /window\.electron\.shell\.showItemInFolder\(filePath\)/);
  assert.match(blockSource, /window\.electron\.shell\.openPath\(filePath\)/);
  assert.match(blockSource, /navigator\.clipboard\.writeText\(filePath\)/);
  assert.match(blockSource, /i18nService\.t\('htmlReportViewSource'\)/);
  assert.match(blockSource, /i18nService\.t\('htmlReportViewRendered'\)/);
  assert.match(blockSource, /i18nService\.t\('htmlReportDownloadImage'\)/);
  assert.match(blockSource, /i18nService\.t\('htmlReportOpenWithDefault'\)/);
  assert.match(blockSource, /i18nService\.t\('htmlReportOpenInPanel'\)/);
});
