import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  summarizeSessionActivity,
  hasSubstantiveActivity,
  formatWorkerEmptyHandoffError,
  collectWorkspaceCommits,
  WORKER_EMPTY_HANDOFF,
  WORKER_EMPTY_HANDOFF_WITH_ACTIVITY,
} = require('../dist-electron/main/libs/coworkSessionActivity.js');

const toolUse = (name, input, id = `tu-${Math.random().toString(36).slice(2)}`) => ({
  type: 'tool_use',
  content: `Using tool: ${name}`,
  metadata: { toolName: name, toolInput: input, toolUseId: id },
});

const toolResult = (content, { error = false, id = `tu-${Math.random().toString(36).slice(2)}` } = {}) => ({
  type: 'tool_result',
  content,
  metadata: { toolUseId: id, isError: error, ...(error ? { error: content } : {}), toolResult: content },
});

const assistant = (content, extra = {}) => ({ type: 'assistant', content, ...(Object.keys(extra).length ? { metadata: extra } : {}) });

// ---------------------------------------------------------------------------
// summarizeSessionActivity
// ---------------------------------------------------------------------------

test('summarize: counts tool calls, files, tests, tail texts, errors, lastError and commits', () => {
  const messages = [
    assistant('Plan: read the repo first.'),
    toolUse('Read', { file_path: 'src/a.ts' }),
    toolResult('src/a.ts: 42 lines'),
    toolUse('Edit', { file_path: 'src/a.ts' }),
    toolResult('Edited src/a.ts'),
    toolUse('Edit', { file_path: 'src/b.ts' }),
    toolResult('Edited src/b.ts'),
    toolUse('Bash', { command: 'npm test' }),
    toolResult('315/315 tests passed'),
    assistant('Progress: fix done, tests green.'),
    toolUse('Edit', { file_path: 'src/a.ts' }),
    toolResult('File has not been read yet', { error: true }),
  ];

  const summary = summarizeSessionActivity(messages);
  assert.equal(summary.toolCalls, 5);
  assert.equal(summary.errors, 1);
  assert.deepEqual(summary.files, ['src/a.ts', 'src/b.ts'], 'unique file targets, deduped');
  assert.ok(summary.tests.some((line) => line.includes('315/315')), 'test pass line captured');
  assert.ok(summary.tests.some((line) => line.includes('npm test')), 'test-run command captured');
  assert.ok(summary.tailText.some((text) => text.includes('Progress: fix done')), 'tail narration captured');
  assert.match(summary.lastError, /File has not been read yet/);
});

test('summarize: extracts commit evidence from tool results (git log lines + commit keyword + full sha)', () => {
  const messages = [
    toolUse('Bash', { command: 'git log --oneline -3' }),
    toolResult('516da92 fix: openteam invite chain\n9db05e1d feat: guest invites'),
    toolUse('Bash', { command: 'git status' }),
    toolResult('nothing to commit, working tree clean'),
  ];
  const summary = summarizeSessionActivity(messages);
  assert.ok(summary.commits.includes('516da92'), 'short hash from git log line');
  assert.ok(summary.commits.includes('9db05e1d'), 'second short hash');

  const commitKeyword = summarizeSessionActivity([
    toolResult('HEAD is now at commit abc1234 fix: something'),
  ]);
  assert.deepEqual(commitKeyword.commits, ['abc1234']);

  const fullSha = summarizeSessionActivity([
    toolResult('commit 0123456789abcdef0123456789abcdef01234567\nAuthor: Worker'),
  ]);
  assert.deepEqual(fullSha.commits, ['0123456789abcdef0123456789abcdef01234567']);
});

test('summarize: ignores thinking blocks and reasoning placeholders in tail text', () => {
  const summary = summarizeSessionActivity([
    assistant('[reasoning unavailable]', { isThinking: true }),
    assistant('', {}),
    toolUse('Read', { file_path: 'a' }),
    toolResult('a ok'),
  ]);
  assert.equal(summary.tailText.length, 0, 'no usable assistant text');
});

test('hasSubstantiveActivity: files/commits/tests/toolCalls>=4/tailText>=2 count; bare sessions do not', () => {
  assert.equal(hasSubstantiveActivity(summarizeSessionActivity([toolUse('Edit', { file_path: 'x.ts' }), toolResult('ok')])), true, 'file edit');
  assert.equal(hasSubstantiveActivity(summarizeSessionActivity([toolResult('commit ab12cd3 fix')])), true, 'commit');
  assert.equal(hasSubstantiveActivity(summarizeSessionActivity([toolResult('10/10 tests passed')])), true, 'test evidence');
  assert.equal(
    hasSubstantiveActivity(summarizeSessionActivity(Array.from({ length: 4 }, (_, i) => toolUse('Bash', { command: `cmd ${i}` })))),
    true,
    '4 tool calls',
  );
  assert.equal(
    hasSubstantiveActivity(summarizeSessionActivity([assistant('step one'), assistant('step two')])),
    true,
    'narrated progress',
  );
  assert.equal(
    hasSubstantiveActivity(summarizeSessionActivity([toolUse('Read', { file_path: 'a' }), toolResult('a'), assistant('one note')])),
    false,
    'bare observational session stays below the bar',
  );
  assert.equal(hasSubstantiveActivity(summarizeSessionActivity([])), false, 'empty session');
});

// ---------------------------------------------------------------------------
// formatWorkerEmptyHandoffError
// ---------------------------------------------------------------------------

test('format: carries the WORKER_EMPTY_HANDOFF_WITH_ACTIVITY prefix and all summary fields', () => {
  const summary = summarizeSessionActivity([
    toolUse('Edit', { file_path: 'src/a.ts' }),
    toolResult('Edited src/a.ts'),
    toolUse('Bash', { command: 'npm test' }),
    toolResult('315/315 tests passed'),
    toolResult('File has not been read yet', { error: true }),
  ]);
  const error = formatWorkerEmptyHandoffError(summary, ['516da92']);
  assert.ok(error.startsWith(WORKER_EMPTY_HANDOFF_WITH_ACTIVITY + ':'));
  assert.match(error, /commit=\[516da92\]/);
  assert.match(error, /files=\[src\/a\.ts\]/);
  assert.match(error, /toolCalls=2/);
  assert.match(error, /errors=1/);
  assert.match(error, /tests=\[.*315\/315/);
  assert.match(error, /lastError=File has not been read yet/);
});

test('format: plain WORKER_EMPTY_HANDOFF constant is distinct and stays stable', () => {
  assert.equal(WORKER_EMPTY_HANDOFF, 'WORKER_EMPTY_HANDOFF');
  assert.notEqual(WORKER_EMPTY_HANDOFF, WORKER_EMPTY_HANDOFF_WITH_ACTIVITY);
});

// ---------------------------------------------------------------------------
// collectWorkspaceCommits (real git)
// ---------------------------------------------------------------------------

async function makeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-git-'));
  const run = (args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  run(['init', '-q']);
  run(['config', 'user.email', 'worker@test']);
  run(['config', 'user.name', 'Worker']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v1');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'feat: first']);
  const short = run(['rev-parse', '--short=7', 'HEAD']).toString().trim();
  return { dir, short };
}

test('collectWorkspaceCommits: returns short hashes from a real git repo', async () => {
  const { dir, short } = await makeGitRepo();
  try {
    const commits = await collectWorkspaceCommits(dir);
    assert.ok(commits.includes(short), `expected ${short} in ${commits.join(',')}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collectWorkspaceCommits: best-effort — no dir, non-git dir, or bad since yields []', async () => {
  assert.deepEqual(await collectWorkspaceCommits(null), []);
  assert.deepEqual(await collectWorkspaceCommits(''), []);

  const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-notgit-'));
  try {
    assert.deepEqual(await collectWorkspaceCommits(plainDir), [], 'non-git dir');
    assert.deepEqual(await collectWorkspaceCommits(plainDir, 'not-a-date'), [], 'unparsable since');
  } finally {
    fs.rmSync(plainDir, { recursive: true, force: true });
  }
});
