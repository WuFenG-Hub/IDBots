import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoworkStore,
  createSqliteStore,
  getColumns,
} from './memoryTestUtils.mjs';

test('browser session type: schema columns, create/update/get/list round-trip', async () => {
  const sqlite = await createSqliteStore();
  try {
    // Migration adds browser context columns idempotently
    assert.equal(getColumns(sqlite.db, 'cowork_sessions').includes('browser_uri'), true);
    assert.equal(getColumns(sqlite.db, 'cowork_sessions').includes('browser_title'), true);

    const store = createCoworkStore(sqlite.db);
    const session = store.createSession(
      'Browser chat',
      process.cwd(),
      '',
      'local',
      [],
      null,
      'browser',
    );
    assert.equal(session.sessionType, 'browser');

    // Fresh session has no browser context yet
    const fetched = store.getSession(session.id);
    assert.equal(fetched?.sessionType, 'browser');
    assert.equal(fetched?.browserUri ?? null, null);
    assert.equal(fetched?.browserTitle ?? null, null);

    // Per-turn context refresh persists URI + title
    store.updateSession(session.id, {
      browserUri: 'metaapp://abc123',
      browserTitle: 'Cool Game',
    });
    const updated = store.getSession(session.id);
    assert.equal(updated?.browserUri, 'metaapp://abc123');
    assert.equal(updated?.browserTitle, 'Cool Game');

    // listSessions carries the summary fields
    const summary = store.listSessions().find((item) => item.id === session.id);
    assert.equal(summary?.sessionType, 'browser');
    assert.equal(summary?.browserUri, 'metaapp://abc123');
    assert.equal(summary?.browserTitle, 'Cool Game');

    // Standard sessions are unaffected
    const standard = store.createSession('Normal', process.cwd(), '', 'local', [], null);
    const standardSummary = store.listSessions().find((item) => item.id === standard.id);
    assert.equal(standardSummary?.sessionType, 'standard');
    assert.equal(standardSummary?.browserUri ?? null, null);
  } finally {
    sqlite.cleanup();
  }
});

test('browser session migration is idempotent on an already-migrated db', async () => {
  const sqlite = await createSqliteStore();
  try {
    // First store runs the migration; second store on the same db must not throw
    // or duplicate columns.
    createCoworkStore(sqlite.db);
    createCoworkStore(sqlite.db);
    const columns = getColumns(sqlite.db, 'cowork_sessions').filter((name) => name === 'browser_uri');
    assert.equal(columns.length, 1);
  } finally {
    sqlite.cleanup();
  }
});
