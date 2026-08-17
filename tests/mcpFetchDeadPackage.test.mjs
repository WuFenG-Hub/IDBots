import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const {
  disableDeadFetchMcpServers,
  DEAD_MCP_FETCH_PACKAGE,
} = require('../dist-electron/main/mcpStore.js');

const insertServer = (db, { id, name, enabled = 1, argsJson }) => {
  db.run(
    `INSERT INTO mcp_servers (id, name, description, enabled, transport_type, config_json, created_at, updated_at)
     VALUES (?, ?, '', ?, 'stdio', ?, 1, 1)`,
    [id, name, enabled, argsJson],
  );
};

test('migration disables enabled rows referencing the dead fetch package, keeps others', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-dead-fetch-'));
  const store = await SqliteStore.create(tempDir);
  try {
    const db = store.getDatabase();
    insertServer(db, {
      id: 'dead-1',
      name: 'Fetch',
      argsJson: JSON.stringify({ command: 'npx', args: ['-y', DEAD_MCP_FETCH_PACKAGE] }),
    });
    insertServer(db, {
      id: 'healthy-1',
      name: 'Tavily',
      argsJson: JSON.stringify({ command: 'npx', args: ['-y', 'tavily-mcp@latest'] }),
    });
    insertServer(db, {
      id: 'dead-disabled-1',
      name: 'Fetch (already off)',
      enabled: 0,
      argsJson: JSON.stringify({ command: 'npx', args: ['-y', DEAD_MCP_FETCH_PACKAGE] }),
    });

    const disabled = disableDeadFetchMcpServers(db, 1_700_000_000_000);
    assert.equal(disabled, 1, 'exactly the enabled dead row is disabled');

    const rows = db.exec('SELECT id, enabled, description, updated_at FROM mcp_servers ORDER BY id');
    // columns: [id, enabled, description, updated_at]
    const byId = Object.fromEntries(rows[0].values.map((row) => [row[0], { enabled: row[1], description: row[2], updatedAt: row[3] }]));
    assert.equal(byId['dead-1'].enabled, 0, 'dead enabled row disabled');
    assert.match(byId['dead-1'].description, /auto-disabled/);
    assert.equal(byId['dead-1'].updatedAt, 1_700_000_000_000);
    assert.equal(byId['healthy-1'].enabled, 1, 'healthy row untouched');
    assert.equal(byId['dead-disabled-1'].enabled, 0, 'already-disabled row stays off');
    assert.doesNotMatch(byId['dead-disabled-1'].description, /auto-disabled/);

    // Idempotent: nothing left to match on a second pass.
    assert.equal(disableDeadFetchMcpServers(db), 0);
  } finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('built-in registry no longer advertises the dead package', () => {
  const registry = fs.readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'data', 'mcpRegistry.ts'),
    'utf8',
  );
  // The explanatory NOTE comment may mention the dead name — only actual
  // entry/defaultArgs usage must be gone.
  assert.doesNotMatch(registry, /defaultArgs:[^\n]*server-fetch/);
  assert.doesNotMatch(registry, /id: 'fetch'/);

  const i18n = fs.readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'services', 'i18n.ts'),
    'utf8',
  );
  assert.doesNotMatch(i18n, /mcpDesc_fetch/);
});
