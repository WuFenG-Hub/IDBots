import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * Source-anchor wiring test for the standing-pages settings tab: the IPC
 * chain (main handler -> preload bridge -> service method -> component tab)
 * has four links in three files; any dropped link leaves the tab silently
 * empty, which no unit test below the renderer would catch.
 */
const settings = readFileSync(new URL('../src/renderer/components/settings/MemorySettings.tsx', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../src/main/preload.ts', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../src/renderer/services/i18n.ts', import.meta.url), 'utf8');
const service = readFileSync(new URL('../src/renderer/services/cowork.ts', import.meta.url), 'utf8');

test('the standing pages tab is a first-class section with a render branch', () => {
  assert.match(settings, /'culture' \| 'standingPages';/, 'section type includes standingPages');
  assert.match(settings, /sectionTab\('standingPages', i18nService\.t\('memorySectionStandingPages'\)/, 'tab entry');
  assert.match(settings, /activeSection === 'standingPages' && renderStandingPages\(\)/, 'render branch');
  assert.match(settings, /standingPagesStale/, 'freshness badge text key used');
});

test('the IPC chain is wired end to end', () => {
  assert.match(main, /registerIpcHandler\('standingPages:list'/, 'main handler');
  assert.match(main, /sampleStandingPageScope/, 'list computes staleness by re-sampling the scope');
  assert.match(preload, /ipcRenderer\.invoke\('standingPages:list'/, 'preload bridge');
  assert.match(service, /listStandingPages\(metabotId/, 'renderer service method');
});

test('i18n carries the tab keys in both locales', () => {
  assert.match(i18n, /memorySectionStandingPages: '常备知识页'/);
  assert.match(i18n, /memorySectionStandingPages: 'Standing pages'/);
  assert.match(i18n, /standingPagesRefreshError: '上次刷新失败'/);
  assert.match(i18n, /standingPagesRefreshError: 'last refresh failed'/);
});
