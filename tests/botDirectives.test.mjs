import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module from 'node:module';
import { createSqliteStore } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);
function loadCompiled(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') return { app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() } };
    return originalLoad.call(this, request, ...rest);
  };
  try { return require(modulePath); } finally { Module._load = originalLoad; }
}
const {
  BotDirectivesStore, renderBotDirectivesBlock,
  BOT_DIRECTIVE_MAX_ACTIVE_PER_BOT, BOT_DIRECTIVE_MAX_CHARS,
  getBotDirectivesStore, setBotDirectivesStore,
} = loadCompiled('../dist-electron/main/botDirectivesStore.js');

test('store: CRUD, cap, clipping, archive/restore, idempotent schema', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = new BotDirectivesStore(db, () => {});
    new BotDirectivesStore(db, () => {}); // idempotent
    const a = store.createBotDirective({ metabotId: 1, text: '外部渠道永远用正式英文回复' });
    const b = store.createBotDirective({ metabotId: 1, text: '对外绝不透露客户名单', scope: 'all' });
    assert.equal(a.scope, 'external', 'default scope is external');
    assert.equal(store.createBotDirective({ metabotId: 1, text: 'x'.repeat(400) }).text.length, BOT_DIRECTIVE_MAX_CHARS);
    assert.throws(() => store.createBotDirective({ metabotId: 1, text: '' }), /required/);
    for (let i = 0; i < BOT_DIRECTIVE_MAX_ACTIVE_PER_BOT - 3; i += 1) {
      store.createBotDirective({ metabotId: 1, text: `rule ${i}` });
    }
    assert.throws(() => store.createBotDirective({ metabotId: 1, text: 'over' }), /at most/);
    assert.equal(store.listBotDirectives(2).length, 0, 'per-bot isolation');
    assert.ok(store.archiveBotDirective(1, a.id));
    assert.equal(store.listBotDirectives(1).length, BOT_DIRECTIVE_MAX_ACTIVE_PER_BOT - 1);
    assert.ok(store.restoreBotDirective(1, a.id));
    const updated = store.updateBotDirective({ metabotId: 1, id: b.id, text: '对外绝不透露任何客户信息' });
    assert.equal(updated.text, '对外绝不透露任何客户信息');
  } finally { cleanup(); }
});

test('render: external-scope directives stay out of owner chats; all-scope always render', () => {
  const mk = (scope) => ({ id: `d-${scope}`, metabotId: 1, text: `rule-${scope}`, scope, status: 'active', createdAt: 1, updatedAt: 1 });
  const ownerChat = renderBotDirectivesBlock([mk('external'), mk('all')], { channelIsExternal: false });
  assert.equal(ownerChat.includes('rule-external'), false, 'owner chats gain zero chars from external directives');
  assert.ok(ownerChat.includes('rule-all') && ownerChat.includes('MUST follow'));
  const external = renderBotDirectivesBlock([mk('external'), mk('all')], { channelIsExternal: true });
  assert.ok(external.includes('rule-external') && external.includes('rule-all'));
  assert.equal(renderBotDirectivesBlock([mk('external')], { channelIsExternal: false }), '');
  assert.equal(renderBotDirectivesBlock([], { channelIsExternal: true }), '');
});

test('runtime + wiring anchors: singleton accessor; three external-facing sites prepend the block', () => {
  const prev = getBotDirectivesStore();
  try {
    setBotDirectivesStore(null);
    assert.equal(getBotDirectivesStore(), null);
    const stub = { text: 'store' };
    setBotDirectivesStore(stub);
    assert.equal(getBotDirectivesStore(), stub);
  } finally { setBotDirectivesStore(prev); }
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  for (const site of ['../src/main/libs/coworkRunner.ts', '../src/main/services/privateChatDaemon.ts', '../src/main/services/groupTaskDaemon.ts']) {
    const source = read(site);
    assert.match(source, /renderBotDirectivesBlock\(/, `${site} renders directives`);
    assert.match(source, /getBotDirectivesStore\(\)/, `${site} pulls the runtime store`);
  }
  assert.match(read('../src/main/libs/coworkRunner.ts'), /channelIsExternal: normalizeScopeChannel\(sourceChannel\) !== 'cowork_ui'/, 'cowork sessions gate on the real channel');
  assert.match(read('../src/main/main.ts'), /setBotDirectivesStore\(getBotDirectivesStoreInstance\(\)\);/, 'main pushes the singleton');
});
