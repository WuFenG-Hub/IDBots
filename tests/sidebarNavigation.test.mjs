import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getSidebarInternetNavModel,
  getSidebarPrimaryNavModel,
  isBotBrowserPaneVisible,
} from '../src/renderer/components/sidebar/sidebarNavigation.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const t = (key) => key;

test('Bot Home primary nav keeps tasks and bots, without Bot Hub or Meta Apps', () => {
  const ids = getSidebarPrimaryNavModel({ t, hasRunningScheduledTask: false })
    .filter((item) => !item.hidden)
    .map((item) => item.id);

  assert.deepEqual(ids, ['scheduledTasks', 'groupTasks', 'metabots']);
});

test('Bot Internet nav is Bot Browser, then Bot Hub and Meta Apps', () => {
  const items = getSidebarInternetNavModel({ t });

  assert.deepEqual(items.map((item) => item.id), ['browser', 'gigSquare', 'metaapps']);
  assert.equal(items[0].icon, 'globe');
  assert.equal(items[1].icon, 'shoppingBag');
  assert.equal(items[1].badge, 'gigSquareAlphaBadge');
  assert.equal(items[2].icon, 'squares2x2');
});

test('Bot Browser pane stays the visible internet destination only when selected', () => {
  assert.equal(isBotBrowserPaneVisible('browser', 'browser'), true);
  assert.equal(isBotBrowserPaneVisible('browser', 'gigSquare'), false);
  assert.equal(isBotBrowserPaneVisible('browser', 'metaapps'), false);
  assert.equal(isBotBrowserPaneVisible('home', 'browser'), false);
});

test('App keeps the Bot Browser surface mounted and only toggles visibility', () => {
  const src = fs.readFileSync(path.join(root, 'src/renderer/App.tsx'), 'utf8');
  assert.match(src, /hasMountedBrowser \? \(/);
  assert.match(src, /isBrowserPaneVisible \? 'relative flex flex-1 min-w-0 flex-col' : 'hidden'/);
  assert.match(src, /visible=\{botBrowserShell\.isBrowserPaneVisible\}/);
});

test('opening a Bot Browser URI selects the browser pane inside Bot Internet', () => {
  const src = fs.readFileSync(path.join(root, 'src/renderer/features/botBrowser/useBotBrowserShell.ts'), 'utf8');
  assert.match(src, /const showBrowser[\s\S]*setInternetPane\('browser'\)/);
  assert.match(src, /const openBrowserHome[\s\S]*setInternetPane\('browser'\)/);
  assert.match(src, /const controlTabs[\s\S]*setInternetPane\('browser'\)/);
});

test('Bot Internet keeps the Co-Work panel visible for Hub and Meta Apps', () => {
  const src = fs.readFileSync(path.join(root, 'src/renderer/components/Sidebar.tsx'), 'utf8');
  const internetBranch = src.slice(src.indexOf("mode === 'home'"));
  assert.match(internetBranch, /<BotBrowserCoworkPanel\s+onShowSkills=\{onShowSkills\}/);
  assert.doesNotMatch(internetBranch, /internetPane === 'browser'/);
  assert.doesNotMatch(internetBranch, /internetPane !== 'browser'/);
});
