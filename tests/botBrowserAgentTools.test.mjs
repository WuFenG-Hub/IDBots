import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { buildBotBrowserAgentTools, formatBotBrowserTabs } = require('../dist-electron/main/libs/botBrowserAgentTools.js');

function makeHarness(overrides = {}) {
  const calls = { execute: [], openUri: [] };
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
    ...overrides.control,
  };
  const tools = buildBotBrowserAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    controlBotBrowser: control,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, tools, byName };
}

test('builds bot_browser_tabs and bot_browser_open_uri tools', () => {
  const { byName } = makeHarness();
  assert.ok(byName.bot_browser_tabs);
  assert.ok(byName.bot_browser_open_uri);
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
