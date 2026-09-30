import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Regression guard for "a conversation restored from Settings → Archived Chats
// never reappears in the left sidebar": the store layer (coworkStore
// .unarchiveSession) always worked, but the Settings handlers only updated
// their own panel state — the sidebar renders the shared redux session list,
// which is populated solely by coworkService.loadSessions() at init and on
// stream events, so a restored chat stayed invisible until the next app
// launch. These assertions pin the refresh calls that fix it, for all three
// restore paths in the panel (local chats, a2a chats, group tasks).

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function handlerBody(source, declaration, nextDeclaration) {
  const start = source.indexOf(declaration);
  assert.ok(start > 0, `${declaration} should exist`);
  const end = source.indexOf(nextDeclaration, start);
  assert.ok(end > start, `${declaration} should end before ${nextDeclaration}`);
  return source.slice(start, end);
}

test('restoring a local chat refreshes the sidebar session list', () => {
  const source = read('src/renderer/components/Settings.tsx');
  const handler = handlerBody(
    source,
    'const handleUnarchiveChat = async',
    'const loadArchivedGroupTasks',
  );
  assert.match(
    handler,
    /await coworkService\.loadSessions\(\);/,
    'handleUnarchiveChat must reload the shared session list after a successful restore',
  );
});

test('restoring an a2a chat refreshes the sidebar session list', () => {
  const source = read('src/renderer/components/Settings.tsx');
  const handler = handlerBody(
    source,
    'const handleUnarchiveA2AChat = async',
    'const handleOpenCoworkSession',
  );
  assert.match(
    handler,
    /await coworkService\.loadSessions\(\);/,
    'handleUnarchiveA2AChat must reload the shared session list after a successful restore',
  );
});

test('restoring a group task refreshes the sidebar group-task list', () => {
  const source = read('src/renderer/components/Settings.tsx');
  const handler = handlerBody(
    source,
    'const handleUnarchiveGroupTask = async',
    'const loadArchivedA2AChats',
  );
  assert.match(
    handler,
    /await groupTaskService\.loadTasks\(\);/,
    'handleUnarchiveGroupTask must reload the redux group-task list after a successful restore',
  );
});
