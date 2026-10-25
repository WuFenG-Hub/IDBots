import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module from 'node:module';
const require = Module.createRequire(import.meta.url);
function loadCompiled(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') return { app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() } };
    return originalLoad.call(this, request, ...rest);
  };
  try { return require(modulePath); } finally { Module._load = originalLoad; }
}
const { renderBotDirectivesBlock } = loadCompiled('../dist-electron/main/botDirectives.js');

test('built-in directives: render on external turns only, bounded, classic set', () => {
  const owner = renderBotDirectivesBlock({ channelIsExternal: false });
  assert.equal(owner, '', 'owner cowork chats gain zero chars');
  const external = renderBotDirectivesBlock({ channelIsExternal: true });
  assert.ok(external.includes('<bot_directives>'));
  assert.ok(external.includes('MUST follow'));
  assert.ok(external.includes('wallet details, mnemonics, private keys'));
  assert.ok(external.includes('spending money'));
  assert.ok(external.includes('legal or contractual'));
  assert.ok(external.length < 800, 'bounded block');
  assert.ok(renderBotDirectivesBlock().length > 0, 'external is the default context');
});

test('wiring anchors: all three external-facing sites render the built-ins; no management surface remains', () => {
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  for (const site of ['../src/main/libs/coworkRunner.ts', '../src/main/services/privateChatDaemon.ts', '../src/main/services/groupTaskDaemon.ts']) {
    const source = read(site);
    assert.match(source, /renderBotDirectivesBlock\(/, `${site} renders directives`);
    assert.doesNotMatch(source, /getBotDirectivesStore/, 'no store coupling');
  }
  assert.match(read('../src/main/libs/coworkRunner.ts'), /channelIsExternal: normalizeScopeChannel\(sourceChannel\) !== 'cowork_ui'/);
  assert.equal(read('../src/main/main.ts').includes('botDirectives'), false, 'main has no directives wiring left');
  const tabs = read('../src/renderer/components/metabots/MetaBotEditTabs.tsx');
  assert.equal(tabs.includes('directives'), false, 'the persona-page tab is gone');
});
