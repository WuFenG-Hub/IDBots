import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...segments) => fs.readFileSync(path.join(projectRoot, ...segments), 'utf8');

const AVATAR_ONE = 'data:image/png;base64,QQQQ';
const AVATAR_TWO = 'data:image/png;base64,BBBB';

const insertMetabot = (db, { id, avatar, updatedAt }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key,
      chat_public_key, name, avatar, metaid, metabot_type, created_by,
      role, soul, created_at, updated_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'worker', 'test', 'role', 'soul', 1, ?)`,
    [
      id,
      `mvc-${id}`,
      `btc-${id}`,
      `doge-${id}`,
      `pk-${id}`,
      `chatpk-${id}`,
      `bot-${id}`,
      avatar,
      `metaid-${id}`,
      updatedAt,
    ],
  );
};

test('listSessions reports the owning bot revision instead of inlining its avatar', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    insertMetabot(db, { id: 7, avatar: AVATAR_ONE, updatedAt: 4242 });
    const session = store.createSession('avatared session', '/tmp/bot-7', '', 'local', [], 7);

    const [summary] = store.listSessions();
    assert.equal(summary.id, session.id);
    assert.equal(summary.metabotId, 7);
    assert.equal(summary.metabotAvatar, undefined, 'the list no longer carries the avatar image');
    assert.equal(summary.metabotAvatarVersion, 4242);

    assert.deepEqual(store.listMetabotAvatars([7]), [{ metabotId: 7, avatar: AVATAR_ONE }]);
  } finally {
    cleanup();
  }
});

test('listMetabotAvatars reads only the requested bots, deduped and normalized', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    insertMetabot(db, { id: 1, avatar: AVATAR_ONE, updatedAt: 10 });
    insertMetabot(db, { id: 2, avatar: new Uint8Array([1, 2, 3]), updatedAt: 20 });
    insertMetabot(db, { id: 3, avatar: AVATAR_TWO, updatedAt: 30 });

    assert.deepEqual(store.listMetabotAvatars([1, 1, 2]), [
      { metabotId: 1, avatar: AVATAR_ONE },
      { metabotId: 2, avatar: 'data:image/png;base64,AQID' },
    ]);
    assert.deepEqual(store.listMetabotAvatars([3]), [{ metabotId: 3, avatar: AVATAR_TWO }]);

    // Unknown, dangling, and non-positive ids resolve to nothing (never a throw).
    assert.deepEqual(store.listMetabotAvatars([999]), []);
    assert.deepEqual(store.listMetabotAvatars([0, -3, 1.5]), []);
    assert.deepEqual(store.listMetabotAvatars([]), []);
    assert.deepEqual(store.listMetabotAvatars(undefined), []);
  } finally {
    cleanup();
  }
});

test('the avatar channel is wired once across main, preload, and the renderer service', () => {
  const mainSource = readSource('src', 'main', 'main.ts');
  const preloadSource = readSource('src', 'main', 'preload.ts');
  const storeSource = readSource('src', 'main', 'coworkStore.ts');
  const serviceSource = readSource('src', 'renderer', 'services', 'cowork.ts');
  const electronTypes = readSource('src', 'renderer', 'types', 'electron.d.ts');

  assert.equal(
    mainSource.match(/ipcMain\.handle\('cowork:session:listMetabotAvatars'/g)?.length ?? 0,
    1,
  );
  assert.match(mainSource, /cowork:session:listMetabotAvatars'[\s\S]*?getCoworkStore\(\)\.listMetabotAvatars\(metabotIds\)/);
  assert.match(preloadSource, /listMetabotAvatars: \(metabotIds: number\[\]\) =>\s*ipcRenderer\.invoke\('cowork:session:listMetabotAvatars', metabotIds\)/);
  assert.match(electronTypes, /listMetabotAvatars: \(metabotIds: number\[\]\) => Promise<\{/);
  assert.match(serviceSource, /metabotAvatarCache\.attachAvatars\(result\.sessions\)/);

  // The list query must not read the avatar column; the version column is the
  // only bot identity it carries.
  const listQuery = storeSource.slice(
    storeSource.indexOf('listSessions(options'),
    storeSource.indexOf('listMetabotAvatars('),
  );
  assert.doesNotMatch(listQuery, /mb\.avatar/);
  assert.match(listQuery, /mb\.updated_at AS metabot_updated_at/);
});

const bundleRendererModules = async (t, entrySource, outName) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-avatar-channel-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const outputFile = path.join(tempDir, outName);

  await build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: entrySource,
      resolveDir: projectRoot,
      sourcefile: 'cowork-avatar-test-entry.ts',
      loader: 'ts',
    },
    outfile: outputFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    plugins: [{
      name: 'observable-cowork-store',
      setup(esbuild) {
        esbuild.onResolve({ filter: /^\.\.\/store$/ }, (args) => {
          if (!args.importer.endsWith('/src/renderer/services/cowork.ts')) return null;
          return { path: 'cowork-avatar-store', namespace: 'cowork-avatar-test' };
        });
        esbuild.onLoad(
          { filter: /^cowork-avatar-store$/, namespace: 'cowork-avatar-test' },
          () => ({
            loader: 'js',
            contents: `
              export const store = {
                dispatch(action) {
                  globalThis.__coworkAvatarDispatches.push(action);
                  return action;
                },
                getState() {
                  return { cowork: { sessions: [], currentSessionId: null, currentSession: null } };
                },
              };
            `,
          }),
        );
      },
    }],
  });

  return outputFile;
};

test('loadSessions resolves avatars once per bot revision and survives a failed read', async (t) => {
  const outputFile = await bundleRendererModules(
    t,
    `export { coworkService } from './src/renderer/services/cowork.ts';`,
    'cowork-service.mjs',
  );

  const sessions = [
    { id: 's1', title: 'one', status: 'idle', pinned: false, createdAt: 1, updatedAt: 1, metabotId: 7, metabotAvatarVersion: 100 },
    { id: 's2', title: 'two', status: 'idle', pinned: false, createdAt: 2, updatedAt: 2, metabotId: 7, metabotAvatarVersion: 100 },
    { id: 's3', title: 'three', status: 'idle', pinned: false, createdAt: 3, updatedAt: 3, metabotId: 8, metabotAvatarVersion: 200 },
    { id: 's4', title: 'legacy', status: 'idle', pinned: false, createdAt: 4, updatedAt: 4 },
  ];
  globalThis.__coworkAvatarDispatches = [];
  let listCalls = 0;
  let avatarCalls = [];
  let avatarFailure = false;
  globalThis.window = {
    electron: {
      cowork: {
        listSessions: async () => {
          listCalls += 1;
          return { success: true, sessions };
        },
        listMetabotAvatars: async (ids) => {
          avatarCalls.push(ids);
          if (avatarFailure) throw new Error('avatar transport down');
          return { success: true, avatars: ids.map((id) => ({ metabotId: id, avatar: `avatar-${id}` })) };
        },
      },
    },
  };
  t.after(() => {
    delete globalThis.window;
    delete globalThis.__coworkAvatarDispatches;
  });

  const { coworkService } = await import(`${pathToFileURL(outputFile).href}?test=${Date.now()}`);

  await coworkService.loadSessions();
  assert.equal(listCalls, 1);
  assert.deepEqual(avatarCalls, [[7, 8]]);
  const first = globalThis.__coworkAvatarDispatches.at(-1);
  assert.equal(first.type, 'cowork/setSessions');
  assert.deepEqual(first.payload.map((session) => session.metabotAvatar), [
    'avatar-7',
    'avatar-7',
    'avatar-8',
    undefined,
  ]);

  // Unchanged revisions: the avatar channel is not touched again.
  await coworkService.loadSessions();
  assert.equal(listCalls, 2);
  assert.deepEqual(avatarCalls, [[7, 8]]);

  // One bot moved: only that bot is read again.
  sessions[2] = { ...sessions[2], metabotAvatarVersion: 201 };
  await coworkService.loadSessions();
  assert.deepEqual(avatarCalls, [[7, 8], [8]]);
  assert.equal(globalThis.__coworkAvatarDispatches.at(-1).payload[2].metabotAvatar, 'avatar-8');

  // A failed avatar read keeps the list refresh intact (and the stale image).
  avatarFailure = true;
  sessions[2] = { ...sessions[2], metabotAvatarVersion: 202 };
  await coworkService.loadSessions();
  const afterFailure = globalThis.__coworkAvatarDispatches.at(-1);
  assert.deepEqual(afterFailure.payload.map((session) => session.metabotAvatar), [
    'avatar-7',
    'avatar-7',
    'avatar-8',
    undefined,
  ]);
});
