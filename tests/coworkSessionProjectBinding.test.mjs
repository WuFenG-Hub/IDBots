import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoworkStore,
  createSqliteStore,
  getColumns,
} from './memoryTestUtils.mjs';

let getGitBranch;
try {
  ({ getGitBranch } = await import('../dist-electron/main/libs/gitWorkspace.js'));
} catch {
  ({ getGitBranch } = await import('../dist-electron/libs/gitWorkspace.js'));
}

test('cowork_sessions carries a project_id column via the first-run migration', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    assert.ok(getColumns(db, 'cowork_sessions').includes('project_id'));
  } finally {
    cleanup();
  }
});

test('createSession persists and reads back the project binding', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const session = store.createSession(
      'bound session',
      '/tmp/project-source',
      '',
      'local',
      [],
      null,
      'standard',
      null,
      null,
      null,
      'default',
      null,
      null,
      null,
      'proj-123',
    );
    assert.equal(session.projectId, 'proj-123');
    assert.equal(store.getSession(session.id)?.projectId, 'proj-123');
    assert.equal(store.getSession(session.id)?.cwd, '/tmp/project-source');

    const summaries = store.listSessions();
    assert.equal(summaries.find((s) => s.id === session.id)?.projectId, 'proj-123');
  } finally {
    cleanup();
  }
});

test('updateSession can rebind a session to a project and clear it back', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const session = store.createSession('unbound', '/tmp/x');
    assert.equal(session.projectId ?? null, null);

    store.updateSession(session.id, { projectId: 'proj-456' });
    assert.equal(store.getSession(session.id)?.projectId, 'proj-456');

    store.updateSession(session.id, { projectId: null });
    assert.equal(store.getSession(session.id)?.projectId ?? null, null);
  } finally {
    cleanup();
  }
});

test('legacy sessions without project binding read back as null', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const session = store.createSession('legacy', '/tmp/y');
    assert.equal(store.getSession(session.id)?.projectId ?? null, null);
  } finally {
    cleanup();
  }
});

test('getGitBranch returns the branch inside a git repo and null outside', async () => {
  // The repo checkout itself is a git worktree on a branch, so this resolves.
  const branch = await getGitBranch(process.cwd());
  assert.ok(typeof branch === 'string' && branch.length > 0);

  const outside = await getGitBranch('/tmp');
  assert.equal(outside, null);

  assert.equal(await getGitBranch(''), null);
  assert.equal(await getGitBranch(null), null);
  assert.equal(await getGitBranch(undefined), null);
});

test('lastWorkspaceSelection persists and round-trips through cowork config', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);

    // New store with no record: falls back to null (renderer maps null -> bot workspace).
    assert.equal(store.getConfig().lastWorkspaceSelection, null);

    store.setConfig({
      lastWorkspaceSelection: { kind: 'project', projectId: 'p1', name: 'IDBots', cwd: process.cwd() },
    });
    const projectSel = store.getConfig().lastWorkspaceSelection;
    assert.equal(projectSel?.kind, 'project');
    assert.equal(projectSel?.projectId, 'p1');
    assert.equal(projectSel?.cwd, process.cwd());

    store.setConfig({ lastWorkspaceSelection: { kind: 'botWorkspace' } });
    assert.deepEqual(store.getConfig().lastWorkspaceSelection, { kind: 'botWorkspace' });

    store.setConfig({ lastWorkspaceSelection: { kind: 'folder', cwd: process.cwd() } });
    assert.deepEqual(store.getConfig().lastWorkspaceSelection, { kind: 'folder', cwd: process.cwd() });

    store.setConfig({ lastWorkspaceSelection: null });
    assert.equal(store.getConfig().lastWorkspaceSelection, null);
  } finally {
    cleanup();
  }
});

test('lastWorkspaceSelection falls back to null when the cwd no longer exists', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);

    store.setConfig({
      lastWorkspaceSelection: { kind: 'folder', cwd: '/definitely/not/a/real/dir-xyz' },
    });
    assert.equal(store.getConfig().lastWorkspaceSelection, null);

    store.setConfig({
      lastWorkspaceSelection: { kind: 'project', projectId: 'p2', name: 'Ghost', cwd: '/also/not/real' },
    });
    assert.equal(store.getConfig().lastWorkspaceSelection, null);
  } finally {
    cleanup();
  }
});
