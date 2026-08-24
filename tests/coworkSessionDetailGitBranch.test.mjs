import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'cowork',
  'CoworkSessionDetail.tsx'
);

test('CoworkSessionDetail refreshes the header git branch when it changes', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');

  // The branch chip must re-read the working directory on an interval so a
  // `git checkout` outside the app shows up without reopening the session.
  assert.match(source, /window\.setInterval\(\(\) => \{ void refresh\(\); \}, 3000\)/);

  // Immediate refreshes on window focus and tab re-visibility cover the
  // common "switched branch in a terminal, came back" flow.
  assert.match(source, /window\.addEventListener\('focus', onFocus\)/);
  assert.match(source, /document\.addEventListener\('visibilitychange', onVisibility\)/);

  // Hidden tabs skip the git probe entirely (no idle child-process churn).
  assert.match(source, /document\.visibilityState !== 'visible'/);

  // An unchanged branch must not re-render the header.
  assert.match(source, /setGitBranch\(\(prev\) => \(prev === branch \? prev : branch\)\)/);

  // The poll must be torn down with the effect (no leaks across sessions).
  assert.match(source, /window\.clearInterval\(timer\)/);
  assert.match(source, /window\.removeEventListener\('focus', onFocus\)/);
  assert.match(source, /document\.removeEventListener\('visibilitychange', onVisibility\)/);

  // Scope the effect to the session id + cwd: switching sessions or
  // workspaces resets and re-probes immediately.
  assert.match(source, /\}, \[currentSession\?\.id, currentSession\?\.cwd\]\)/);
});
