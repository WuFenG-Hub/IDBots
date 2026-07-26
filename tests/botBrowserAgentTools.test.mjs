import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { buildBotBrowserAgentTools, formatBotBrowserTabs } = require('../dist-electron/main/libs/botBrowserAgentTools.js');

function makeHarness(overrides = {}) {
  const calls = { execute: [], openUri: [], forkMetaApp: [] };
  const control = {
    execute: async (command) => {
      calls.execute.push(command);
      return {
        action: command.action,
        tabs: [
          { id: 1, uri: 'metaid://aaa', title: 'Agent A', isActive: true },
          { id: 2, uri: 'metaapp://bbb', title: 'Game B', isActive: false },
        ],
        activeTab: { id: 1, uri: 'metaid://aaa', title: 'Agent A', isActive: true },
        ...(overrides.executeResult ?? {}),
      };
    },
    openUri: async (input) => {
      calls.openUri.push(input);
    },
    forkMetaApp: async (input) => {
      calls.forkMetaApp.push(input);
      return {
        dir: '/workspace/metaapp-forks/game-b-bbb-20260726',
        indexFile: 'index.html',
        sourcePinId: 'bbb',
        sourceUri: 'metaapp://bbb',
        title: 'Game B',
        ...(overrides.forkResult ?? {}),
      };
    },
    ...overrides.control,
  };
  if (overrides.withoutFork) {
    delete control.forkMetaApp;
  }
  const tools = buildBotBrowserAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    controlBotBrowser: control,
    sessionId: 'session-1',
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, tools, byName };
}

test('builds bot_browser_tabs, bot_browser_open_uri and bot_browser_preview_local tools', () => {
  const { byName } = makeHarness();
  assert.ok(byName.bot_browser_tabs);
  assert.ok(byName.bot_browser_open_uri);
  assert.ok(byName.bot_browser_preview_local);
});

test('bot_browser_tabs list maps to get-tabs and formats the tab list', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.bot_browser_tabs.handler({ action: 'list' });
  assert.deepEqual(calls.execute, [{ action: 'get-tabs', uri: undefined, tabId: undefined }]);
  const text = result.content[0].text;
  assert.match(text, /Open tabs/);
  assert.match(text, /\*\s+\[1\] Agent A — metaid:\/\/aaa/);
  assert.match(text, /\[2\] Game B — metaapp:\/\/bbb/);
  assert.equal(result.isError, undefined);
});

test('bot_browser_tabs validates required args before touching the bridge', async () => {
  const { calls, byName } = makeHarness();
  const openResult = await byName.bot_browser_tabs.handler({ action: 'open' });
  assert.equal(openResult.isError, true);
  assert.match(openResult.content[0].text, /requires a uri/);

  const closeResult = await byName.bot_browser_tabs.handler({ action: 'close' });
  assert.equal(closeResult.isError, true);
  assert.match(closeResult.content[0].text, /requires a numeric tabId/);

  assert.equal(calls.execute.length, 0);
});

test('bot_browser_tabs switch/close pass tabId through to the bridge', async () => {
  const { calls, byName } = makeHarness();
  await byName.bot_browser_tabs.handler({ action: 'switch', tabId: 2 });
  await byName.bot_browser_tabs.handler({ action: 'close', tabId: 2 });
  assert.deepEqual(calls.execute[0], { action: 'switch-tab', uri: undefined, tabId: 2 });
  assert.deepEqual(calls.execute[1], { action: 'close-tab', uri: undefined, tabId: 2 });
});

test('bot_browser_open_uri navigates the active tab by default', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.bot_browser_open_uri.handler({ uri: 'metaid://abc' });
  assert.deepEqual(calls.openUri, [{ uri: 'metaid://abc' }]);
  assert.equal(calls.execute.length, 0);
  assert.match(result.content[0].text, /metaid:\/\/abc/);
});

test('bot_browser_open_uri newTab=true goes through open-tab', async () => {
  const { calls, byName } = makeHarness();
  await byName.bot_browser_open_uri.handler({ uri: 'metaapp://xyz', newTab: true });
  assert.deepEqual(calls.execute, [{ action: 'open-tab', uri: 'metaapp://xyz' }]);
  assert.equal(calls.openUri.length, 0);
});

test('bridge failures degrade to a friendly error result', async () => {
  const { byName } = makeHarness({
    control: {
      execute: async () => { throw new Error('Bot Browser tab command timed out'); },
      openUri: async () => { throw new Error('No IDBots window is available'); },
    },
  });
  const tabsResult = await byName.bot_browser_tabs.handler({ action: 'list' });
  assert.equal(tabsResult.isError, true);
  assert.match(tabsResult.content[0].text, /timed out/);
  assert.match(tabsResult.content[0].text, /switch to Bot Browser mode/);

  const openResult = await byName.bot_browser_open_uri.handler({ uri: 'metaid://abc' });
  assert.equal(openResult.isError, true);
  assert.match(openResult.content[0].text, /No IDBots window/);
});

test('formatBotBrowserTabs handles an empty tab set', () => {
  assert.equal(formatBotBrowserTabs({ tabs: [], activeTab: null }), 'No open tabs.');
});

test('bot_browser_preview_local opens preview-metaapp URI in a new tab by default', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.bot_browser_preview_local.handler({ path: process.cwd() });
  assert.deepEqual(calls.execute, [{ action: 'open-tab', uri: `preview-metaapp://localhost${process.cwd()}` }]);
  assert.equal(calls.openUri.length, 0);
  assert.match(result.content[0].text, /preview-metaapp|preview/i);
});

test('bot_browser_preview_local newTab=false navigates the active tab', async () => {
  const { calls, byName } = makeHarness();
  await byName.bot_browser_preview_local.handler({ path: process.cwd(), newTab: false });
  assert.deepEqual(calls.openUri, [{ uri: `preview-metaapp://localhost${process.cwd()}` }]);
  assert.equal(calls.execute.length, 0);
});

test('bot_browser_preview_local rejects relative and missing paths before touching the bridge', async () => {
  const { calls, byName } = makeHarness();
  const relative = await byName.bot_browser_preview_local.handler({ path: 'some/relative/dir' });
  assert.equal(relative.isError, true);
  assert.match(relative.content[0].text, /absolute path/);

  const missing = await byName.bot_browser_preview_local.handler({ path: '/definitely/not/here-12345' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /not found/);

  assert.equal(calls.execute.length, 0);
  assert.equal(calls.openUri.length, 0);
});

test('bot_browser_fork_current_app forks an explicit metaapp URI', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.bot_browser_fork_current_app.handler({ uri: 'metaapp://bbb' });
  assert.deepEqual(calls.forkMetaApp, [{ sessionId: 'session-1', uri: 'metaapp://bbb' }]);
  assert.match(result.content[0].text, /Forked "Game B"/);
  assert.match(result.content[0].text, /metaapp-forks/);
});

test('bot_browser_fork_current_app falls back to the active tab URI', async () => {
  const { calls, byName } = makeHarness({
    executeResult: {
      activeTab: { id: 3, uri: 'metaapp://ccc', title: 'C', isActive: true },
    },
  });
  await byName.bot_browser_fork_current_app.handler({});
  assert.deepEqual(calls.execute, [{ action: 'get-active-tab' }]);
  assert.deepEqual(calls.forkMetaApp, [{ sessionId: 'session-1', uri: 'metaapp://ccc' }]);
});

test('bot_browser_fork_current_app rejects non-metaapp pages', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.bot_browser_fork_current_app.handler({ uri: 'metaid://aaa' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not a MetaApp/);
  assert.equal(calls.forkMetaApp.length, 0);
});

test('bot_browser_fork_current_app is not registered when the host has no fork support', () => {
  const { byName } = makeHarness({ withoutFork: true });
  assert.equal(byName.bot_browser_fork_current_app, undefined);
});

test('bot_browser_read_page returns visible text for first-party pages', async () => {
  const { byName } = makeHarness({
    executeResult: {
      content: {
        tabId: 1,
        uri: 'metaid://aaa',
        title: 'Agent A',
        contentType: 'text/html',
        text: 'Hello from the homepage',
        html: '<p>Hello</p>',
        truncated: false,
        extractedAt: 1,
      },
    },
  });
  const result = await byName.bot_browser_read_page.handler({});
  assert.match(result.content[0].text, /Agent A/);
  assert.match(result.content[0].text, /Hello from the homepage/);
  assert.equal(result.isError, undefined);
});

test('bot_browser_read_page points MetaApp tabs at their local source directory', async () => {
  const { byName } = makeHarness({
    executeResult: {
      content: {
        tabId: 2,
        uri: 'metaapp://' + 'b'.repeat(64) + 'i0',
        title: 'Game B',
        contentType: 'text/html',
        text: '',
        html: '',
        truncated: false,
        extractedAt: 1,
      },
    },
    control: {
      locateMetaAppSource: async () => ({
        dir: '/cache/artifacts/game-b',
        indexFile: 'index.html',
        title: 'Game B',
      }),
    },
  });
  const result = await byName.bot_browser_read_page.handler({});
  assert.match(result.content[0].text, /sandboxed frame/);
  assert.match(result.content[0].text, /\/cache\/artifacts\/game-b/);
});

test('bot_browser_read_page reports when a page has no readable text', async () => {
  const { byName } = makeHarness({
    executeResult: {
      content: { tabId: 1, uri: 'metaid://empty', title: null, contentType: 'text/html', text: '', html: '', truncated: false, extractedAt: 1 },
    },
  });
  const result = await byName.bot_browser_read_page.handler({});
  assert.match(result.content[0].text, /No readable text/);
});
