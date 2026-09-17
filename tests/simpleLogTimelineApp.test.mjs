// SimpleLog timeline MetaApp: pure-core behaviour + package/static discipline.
//
// The core module is the SAME file the Bot Browser iframe loads
// (METAAPPs/simplelog-timeline/simplelog-core.js), so these assertions cover
// the shipped logic rather than a copy of it. The static half pins the two
// readback rules the task fixed: bodies come from the pin content endpoint with
// a 30–60 s retry window, and the indexer's rolling summary fields are never
// used as evidence.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(repoRoot, 'METAAPPs', 'simplelog-timeline');
const core = require(path.join(appDir, 'simplelog-core.js'));

const read = (relativePath) => fs.readFileSync(path.join(appDir, relativePath), 'utf8');

const PIN_A = `${'ab'.repeat(32)}i0`;
const PIN_B = `${'cd'.repeat(32)}i0`;
const TASK_PIN = `${'1f'.repeat(32)}i0`;

// ---------------------------------------------------------------------------
// Core: URI discipline (the same shape the ledger and the write tool enforce)
// ---------------------------------------------------------------------------

test('unwrapChainUri takes the link TARGET and rejects what dressing cannot rescue', () => {
  assert.equal(core.unwrapChainUri(`pin://${PIN_A}`), `pin://${PIN_A}`);
  assert.equal(core.unwrapChainUri(`[查看](metaapp://${PIN_B})`), `metaapp://${PIN_B}`);
  assert.equal(core.unwrapChainUri(`[pin://${PIN_A}](pin://${PIN_A})`), `pin://${PIN_A}`);
  assert.equal(core.unwrapChainUri(`\`metafile://${PIN_A}.zip\``), `metafile://${PIN_A}.zip`);
  assert.equal(core.unwrapChainUri(`<pin://${PIN_A.toUpperCase()}>`), `pin://${PIN_A}`);
  // A clean label over a broken target is still broken.
  assert.equal(core.unwrapChainUri(`[pin://${PIN_A}](pin://${PIN_A.slice(0, 24)}…)`), null);
  assert.equal(core.unwrapChainUri(`pin://${PIN_A.slice(0, 40)}`), null);
  assert.equal(core.unwrapChainUri('https://openagentinternet.org/browser/metaapp/x'), null);
  assert.equal(core.unwrapChainUri('pin://<placeholder>'), null);
  assert.equal(core.unwrapChainUri(42), null);
});

test('record admission follows the reader contract, not the indexer summary', () => {
  assert.equal(core.isSimpleLogRecord({ v: 1, kind: 'weird', summary: 's', taskkey: 'local:1' }), true);
  assert.equal(core.isSimpleLogRecord({ v: 1, kind: 'status', summary: 's' }), false);
  assert.equal(core.isSimpleLogRecord({ v: 2, kind: 'status', summary: 's', taskkey: 'local:1' }), false);
  assert.equal(core.parseRecordBody('not json'), null);
  assert.equal(core.parseRecordBody('{"v":1,"kind":"status","summary":"s"}'), null);
  assert.deepEqual(
    core.parseRecordBody(JSON.stringify({ v: 1, kind: 'note', summary: 's', taskid: TASK_PIN })),
    { v: 1, kind: 'note', summary: 's', taskid: TASK_PIN },
  );
});

// ---------------------------------------------------------------------------
// Core: grouping, ordering, union, corrections
// ---------------------------------------------------------------------------

const entry = (pinId, timestamp, record, extra = {}) => ({
  pinId: `${pinId.repeat(32).slice(0, 64)}i0`,
  timestamp,
  author: '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx',
  globalMetaId: 'idq1d5m392ahkhp79wsy9ur79e3vhak7tg729dwdr5',
  record,
  readState: 'read',
  ...extra,
});

test('buildTimeline groups by taskid then taskkey, orders records forward and groups by activity', () => {
  const entries = [
    entry('aa', 300, { v: 1, kind: 'close', summary: '收口', taskid: TASK_PIN, deliverables: [`pin://${PIN_A}`] }),
    entry('bb', 100, { v: 1, kind: 'status', summary: '开工', taskid: TASK_PIN }),
    entry('cc', 200, { v: 1, kind: 'status', summary: '本机任务', taskkey: 'local:184' }),
    { pinId: `${'ee'.repeat(32)}i0`, timestamp: 400, record: null, readState: 'unread', readNote: 'HTTP 404' },
  ];
  const timeline = core.buildTimeline(entries);
  assert.equal(timeline.groups.length, 2);
  // The on-chain anchor group wins the ordering call (last activity 300 > 200).
  assert.equal(timeline.groups[0].label, TASK_PIN);
  assert.equal(timeline.groups[1].label, 'local:184');
  assert.deepEqual(timeline.groups[0].records.map((item) => item.record.summary), ['开工', '收口']);
  // Unread entries are preserved, never silently dropped into a group.
  assert.equal(timeline.unread.length, 1);
  assert.equal(timeline.unread[0].readNote, 'HTTP 404');
});

test('summarizeGroup unions deliverables by pinid and lists corrections without hiding anything', () => {
  const group = {
    records: [
      entry('aa', 100, {
        v: 1, kind: 'status', summary: '第一棒', taskid: TASK_PIN,
        deliverables: [`pin://${PIN_A}`, `[${PIN_B}](metaapp://${PIN_B})`.replace(`[${PIN_B}]`, '[查看]')],
        refs: [`pin://${PIN_B}`],
      }),
      entry('bb', 200, {
        v: 1, kind: 'status', summary: `更正：上条 URI 抄错`, taskid: TASK_PIN,
        deliverables: [`pin://${PIN_A}`], refs: [`pin://${PIN_B}`],
      }),
    ],
  };
  const summary = core.summarizeGroup(group);
  assert.equal(summary.recordCount, 2);
  assert.equal(summary.authorCount, 1);
  assert.equal(summary.deliverables.length, 2, 'the same pinid delivered twice unions to one entry');
  assert.deepEqual(summary.deliverables.map((item) => item.kind), ['pinid', 'metaapp']);
  assert.equal(summary.corrections.length, 1);
  assert.match(summary.corrections[0].summary, /^更正：/);
  assert.equal(summary.byKind.status, 2);
  assert.equal(summary.firstTimestamp, 100);
  assert.equal(summary.lastTimestamp, 200);
});

// ---------------------------------------------------------------------------
// Package / static discipline
// ---------------------------------------------------------------------------

test('the package ships APP.md beside the entry and only relative asset paths', () => {
  for (const file of ['APP.md', 'index.html', 'app.js', 'app.css', 'simplelog-core.js']) {
    assert.ok(fs.existsSync(path.join(appDir, file)), `${file} exists`);
  }
  const html = read('index.html');
  assert.match(html, /href="\.\/app\.css"/);
  assert.match(html, /src="\.\/simplelog-core\.js"/);
  assert.match(html, /src="\.\/app\.js"/);
  assert.doesNotMatch(html, /(?:src|href)="\//, 'no site-root absolute asset paths');
  assert.match(read('APP.md'), /## 二次开发注意/);
});

test('the app fetches bodies from the pin content endpoint with a 30–60 s retry window', () => {
  const js = read('app.js');
  assert.match(js, /\/pin\/path\/list\?path=/);
  assert.match(js, /\/content\//);
  const retry = Number(/(?:var )?READBACK_RETRY_MS = (\d+)/.exec(js)[1]);
  const window = Number(/(?:var )?READBACK_WINDOW_MS = (\d+)/.exec(js)[1]);
  assert.ok(retry >= 1000 && retry <= 15000, `retry interval in seconds-range: ${retry}`);
  assert.ok(window >= 30000 && window <= 60000, `retry window 30–60 s: ${window}`);
  assert.match(js, /nextCursor/);
  // The indexer's rolling fields are evidence for nobody; they must not appear
  // at all, and `total` may only be named in prose (the discipline comment).
  assert.doesNotMatch(js, /contentSummary|contentBody/);
  assert.doesNotMatch(js, /\.total\b|\[['"]total['"]\]/);
});

test('the app is read-only and escapes every interpolated chain string', () => {
  const js = read('app.js');
  assert.ok((js.match(/escapeHtml\(/g) || []).length >= 15, 'escapeHtml is the only interpolation path');
  assert.doesNotMatch(js, /metaid\.pin\.write|metafile\.upload|paylike|post_simple|privateChat|wallet/i);
});
