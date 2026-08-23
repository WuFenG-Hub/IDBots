import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSessionTranscriptMarkdown,
  transcriptExportFileName,
} from '../src/main/libs/coworkTranscriptExport.ts';

const baseTimestamp = Date.UTC(2026, 0, 15, 10, 30, 0);

test('buildSessionTranscriptMarkdown renders session header and typed message sections', () => {
  const markdown = buildSessionTranscriptMarkdown(
    { id: 'sess-1', title: 'Fix the login bug', cwd: '/tmp/project', createdAt: baseTimestamp },
    [
      { id: 'm1', type: 'user', content: 'please fix it', timestamp: baseTimestamp },
      { id: 'm2', type: 'assistant', content: 'On it.', timestamp: baseTimestamp + 1000 },
      {
        id: 'm3',
        type: 'tool_use',
        content: '',
        timestamp: baseTimestamp + 2000,
        metadata: { toolName: 'bash', toolInput: { command: 'ls' } },
      },
      {
        id: 'm4',
        type: 'tool_result',
        content: '',
        timestamp: baseTimestamp + 3000,
        metadata: { toolName: 'bash', toolResult: 'file-a\nfile-b', isError: false },
      },
      { id: 'm5', type: 'system', content: 'notice', timestamp: baseTimestamp + 4000 },
    ],
  );

  assert.match(markdown, /# Fix the login bug/);
  assert.match(markdown, /sess-1/);
  assert.match(markdown, /\/tmp\/project/);
  assert.match(markdown, /### User · 2026-01-15 10:30:00 UTC/);
  assert.match(markdown, /please fix it/);
  assert.match(markdown, /### Assistant ·/);
  assert.match(markdown, /### Tool · bash/);
  assert.match(markdown, /"command": "ls"/);
  assert.match(markdown, /### Tool result · bash/);
  assert.match(markdown, /file-a\nfile-b/);
  assert.match(markdown, /### System ·/);
  assert.match(markdown, /- \*\*Messages\*\*: 5/);
});

test('delegation-internal messages are skipped', () => {
  const markdown = buildSessionTranscriptMarkdown(
    { id: 'sess-2', title: 's' },
    [
      { id: 'm1', type: 'user', content: 'hi', timestamp: baseTimestamp },
      {
        id: 'm2',
        type: 'system',
        content: 'internal plumbing',
        timestamp: baseTimestamp + 1,
        metadata: { isDelegationInternal: true },
      },
    ],
  );
  assert.doesNotMatch(markdown, /internal plumbing/);
  assert.match(markdown, /hi/);
});

test('long tool payloads are truncated', () => {
  const longInput = 'x'.repeat(5000);
  const markdown = buildSessionTranscriptMarkdown(
    { id: 'sess-3', title: 's' },
    [
      {
        id: 'm1',
        type: 'tool_result',
        content: '',
        timestamp: baseTimestamp,
        metadata: { toolName: 'fs', toolResult: longInput },
      },
    ],
  );
  assert.match(markdown, /3000 more characters/);
  assert.ok(markdown.length < 5000);
});

test('failed tool results are labeled', () => {
  const markdown = buildSessionTranscriptMarkdown(
    { id: 'sess-4', title: 's' },
    [
      {
        id: 'm1',
        type: 'tool_result',
        content: '',
        timestamp: baseTimestamp,
        metadata: { toolName: 'bash', toolResult: 'boom', isError: true },
      },
    ],
  );
  assert.match(markdown, /### Tool result · bash \(failed\)/);
});

test('transcriptExportFileName sanitizes the title', () => {
  assert.equal(
    transcriptExportFileName({ id: 'sess-5', title: 'Fix: the/bug *now*' }),
    'idbots-session-Fix-the-bug-now.md',
  );
  assert.equal(
    transcriptExportFileName({ id: 'sess-6', title: '' }),
    'idbots-session-session.md',
  );
});
