import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
test('directives management chain is wired end to end on the persona page', () => {
  const tabs = read('../src/renderer/components/metabots/MetaBotEditTabs.tsx');
  assert.match(tabs, /'persona' \| 'directives'/, 'tab key sits right after persona');
  assert.match(tabs, /metabot-edit-panel-directives/, 'panel renders');
  assert.match(tabs, /listBotDirectives\(metabotId\)/, 'loads via the service');
  const main = read('../src/main/main.ts');
  for (const op of ['list', 'create', 'update', 'archive', 'restore']) {
    assert.match(main, new RegExp(`registerIpcHandler\\('botDirectives:${op}'`), `${op} handler`);
  }
  assert.match(read('../src/main/preload.ts'), /ipcRenderer\.invoke\('botDirectives:list'/, 'preload bridge');
  assert.match(read('../src/renderer/services/cowork.ts'), /listBotDirectives/, 'service method');
  const i18n = read('../src/renderer/services/i18n.ts');
  assert.match(i18n, /metabotTabDirectives: '硬约束'/);
  assert.match(i18n, /metabotTabDirectives: 'Directives'/);
});
