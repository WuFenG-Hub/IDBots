// Assistant mode renders a link to a local .html/.htm file as a distinctive
// full-width report card (icon + title + localized hint + open affordance),
// so the turn's deliverable is unmistakable next to plain inline file links.
// The card renders through LocalFileLink (block-level wrapper), so it carries
// the same right-click menu as every other file link. Professional mode must
// keep the plain inline link, and clicking the card flows through the same
// onOpenLocalFile path as any local file link.

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

const REPORT_LINK = '[季度调研报告](file:///tmp/out/report.html)';

// LocalFileLink reads window.electron.platform while rendering, so SSR needs
// the same global stub the professional-mode tests set.
const withWindowStub = (fn: () => void): void => {
  globalThis.window = { electron: { platform: 'darwin' } } as never;
  try {
    fn();
  } finally {
    delete (globalThis as Record<string, unknown>).window;
  }
};

test('assistant mode renders a local .html link as a report card', () => {
  withWindowStub(() => {
    const markup = renderToStaticMarkup(
      <MarkdownContent
        content={REPORT_LINK}
        chatExperienceMode="assistant"
        onOpenLocalFile={() => true}
      />,
    );
    // Block-level card with the localized hint and the file href, wrapped in
    // LocalFileLink's block wrapper so the right-click menu applies to it.
    assert.match(markup, /href="file:\/\/\/tmp\/out\/report\.html"/);
    assert.match(markup, /HTML report/);
    assert.match(markup, /flex w-full items-center gap-3 rounded-xl/);
    assert.match(markup, /季度调研报告/);
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
    assert.match(markup, /HTML report/);
  });
});

test('the report card renders through LocalFileLink so it carries the right-click menu', () => {
  // Right-click consistency: the assistant HTML report card must go through
  // LocalFileLink (open-with / copy path / copy content / reveal in Finder),
  // not stay a bare anchor with only a click handler.
  assert.match(
    markdownSource,
    /chatExperienceMode === 'assistant' && HTML_FILE_RE\.test\(filePath\)\) \{\s*return \(\s*<LocalFileLink/,
  );
  assert.match(markdownSource, /wrapperClassName="block w-full"/);
  assert.match(markdownSource, /showTypeIcon=\{false\}/);
});

test('professional mode keeps the plain inline link (no card)', () => {
  globalThis.window = { electron: { platform: 'darwin' } } as never;
  try {
    const markup = renderToStaticMarkup(
      <MarkdownContent content={REPORT_LINK} chatExperienceMode="professional" />,
    );
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
    assert.doesNotMatch(markup, /HTML report/);
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
