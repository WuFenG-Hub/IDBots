import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  collectGuestDeliverableFiles,
} = require('../dist-electron/main/services/openTeamGuestDeliverables.js');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-openteam-deliverables-'));

const NOW = 1_800_000_000_000;

test('explicit paths inside the workspace are collected; absolute paths outside are dropped + logged', () => {
  const workspace = makeTempDir();
  const outsideDir = makeTempDir();
  const insidePath = path.join(workspace, 'report.pdf');
  const outsidePath = path.join(outsideDir, 'secret.pdf');
  fs.writeFileSync(insidePath, 'pdf-bytes');
  fs.writeFileSync(outsidePath, 'secret-bytes');
  const logs = [];

  const files = collectGuestDeliverableFiles({
    texts: [`Done.\n${insidePath}\n${outsidePath}`],
    cwd: workspace,
    emitLog: (line) => logs.push(String(line)),
  });

  assert.deepEqual(files.map((file) => file.filePath), [insidePath]);
  assert.ok(
    logs.some((line) => line.includes('outside the allowed workspace') && line.includes(outsidePath)),
    `expected a drop log for the outside path, got: ${JSON.stringify(logs)}`,
  );
});

test('a sibling directory sharing the workspace name prefix is NOT inside the root', () => {
  // /tmp/.../work vs /tmp/.../work-evil: a naive startsWith(root) check would
  // let the sibling through; the path.relative guard must not.
  const base = makeTempDir();
  const workspace = path.join(base, 'work');
  const sibling = path.join(base, 'work-evil');
  fs.mkdirSync(workspace);
  fs.mkdirSync(sibling);
  const siblingFile = path.join(sibling, 'leak.pdf');
  fs.writeFileSync(siblingFile, 'leak-bytes');
  const logs = [];

  const files = collectGuestDeliverableFiles({
    texts: [`Here: ${siblingFile}`],
    cwd: workspace,
    emitLog: (line) => logs.push(String(line)),
  });

  assert.deepEqual(files, []);
  assert.ok(logs.some((line) => line.includes('outside the allowed workspace')));
});

test('relative mentions resolve against the workspace and pass the constraint', () => {
  const workspace = makeTempDir();
  fs.mkdirSync(path.join(workspace, 'out'));
  const nested = path.join(workspace, 'out', 'chart.png');
  fs.writeFileSync(nested, 'png-bytes');

  const files = collectGuestDeliverableFiles({
    texts: ['Image saved to out/chart.png'],
    cwd: workspace,
  });

  assert.deepEqual(files.map((file) => file.filePath), [nested]);
});

test('the scan fallback only picks files inside the workspace (turn window)', () => {
  const workspace = makeTempDir();
  const outsideDir = makeTempDir();
  const insidePath = path.join(workspace, 'data.csv');
  const outsidePath = path.join(outsideDir, 'other.csv');
  fs.writeFileSync(insidePath, 'csv-bytes');
  fs.writeFileSync(outsidePath, 'other-bytes');
  const now = Date.now();
  const logs = [];

  const files = collectGuestDeliverableFiles({
    texts: ['no path mentioned here'],
    cwd: workspace,
    emitLog: (line) => logs.push(String(line)),
    turnStartedAt: now - 1_000,
    turnCompletedAt: now + 1_000,
  });

  assert.deepEqual(files.map((file) => file.filePath), [insidePath]);
  assert.equal(
    logs.filter((line) => line.includes('outside the allowed workspace')).length,
    0,
    'scan results inside the root are not dropped',
  );
});

test('an explicit allowedRoot different from cwd is honored for explicit paths', () => {
  const workspace = makeTempDir();
  const elsewhere = makeTempDir();
  const fileInCwd = path.join(workspace, 'a.pdf');
  const fileElsewhere = path.join(elsewhere, 'b.pdf');
  fs.writeFileSync(fileInCwd, 'a');
  fs.writeFileSync(fileElsewhere, 'b');
  const logs = [];

  // allowedRoot narrower than cwd: even files inside cwd but outside the root drop.
  const narrowRoot = path.join(workspace, 'deliverables');
  fs.mkdirSync(narrowRoot);
  const files = collectGuestDeliverableFiles({
    texts: [`${fileInCwd}\n${fileElsewhere}`],
    cwd: workspace,
    allowedRoot: narrowRoot,
    emitLog: (line) => logs.push(String(line)),
  });

  assert.deepEqual(files, []);
  assert.equal(
    logs.filter((line) => line.includes('outside the allowed workspace')).length,
    2,
  );
});

test('on-chain metafile mentions are still ignored as local paths', () => {
  const workspace = makeTempDir();
  const files = collectGuestDeliverableFiles({
    texts: [`already delivered: metafile://${'ab'.repeat(32)}i0.pdf`],
    cwd: workspace,
    turnStartedAt: NOW,
    turnCompletedAt: NOW,
  });
  assert.deepEqual(files, []);
});
