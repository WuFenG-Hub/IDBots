// getStrict: the strict kv read that keeps "row corrupt" distinguishable
// from "row absent". get() collapses a corrupt row to undefined, which the
// renderer cannot tell apart from a fresh install — the hole a reviewer
// flagged in the config-wipe guards (a corrupt app_config row must make
// configService refuse writes, not treat the install as fresh and persist
// defaults over it). getStrict throws on the corrupt row instead.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSqliteStore } from './memoryTestUtils.mjs';

test('getStrict throws on a corrupt row while get stays tolerant', async () => {
  const sqlite = await createSqliteStore();
  try {
    const { store, db } = sqlite;
    db.run("INSERT INTO kv (key, value, updated_at) VALUES ('app_config', '{corrupt json', 1)");

    assert.equal(store.get('app_config'), undefined, 'get keeps its tolerant legacy semantics');
    assert.throws(() => store.getStrict('app_config'), /failed to parse/, 'getStrict surfaces the corruption');
  } finally {
    sqlite.cleanup();
  }
});

test('getStrict resolves undefined only for a verified absent key', async () => {
  const sqlite = await createSqliteStore();
  try {
    const { store } = sqlite;
    assert.equal(store.getStrict('app_config'), undefined, 'absent key is a fresh install, not a failure');
    store.set('app_config', { providers: {} });
    assert.deepEqual(store.getStrict('app_config'), { providers: {} }, 'healthy rows read normally');
  } finally {
    sqlite.cleanup();
  }
});
