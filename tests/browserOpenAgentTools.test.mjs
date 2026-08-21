import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { buildBrowserOpenAgentTools, normalizeBrowserOpenTarget } = require('../dist-electron/main/libs/browserOpenAgentTools.js');

const SESSION_ID = 'sess-browser-open-1';
const PIN_ID = 'a'.repeat(64) + 'i0';
const GLOBAL_META_ID = 'idq1abcdefghijklmnopqrstuvwx';

const SAMPLE_TABS_RESULT = {
  action: 'get-tabs',
  tabs: [
    { id: 1, uri: 'metaid://idq1alice', title: 'Alice', isActive: true },
    { id: 2, uri: 'metaapp://' + PIN_ID, title: '', isActive: false },
  ],
  activeTab: { id: 1, uri: 'metaid://idq1alice', title: 'Alice', isActive: true },
};

function makeHarness(overrides = {}) {
  const calls = { openUri: [], execute: [] };
  const controlBotBrowser = {
    openUri: async (input) => {
      calls.openUri.push(input);
      if (overrides.openUriError) throw overrides.openUriError;
    },
    execute: async (command) => {
      calls.execute.push(command);
      if (overrides.executeError) throw overrides.executeError;
      return overrides.executeResult ?? SAMPLE_TABS_RESULT;
    },
  };
  const tools = buildBrowserOpenAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    controlBotBrowser,
    sessionId: SESSION_ID,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

test('normalizeBrowserOpenTarget passes supported URIs through, lowercased except map://', () => {
  assert.deepEqual(normalizeBrowserOpenTarget(`check METAAPP://${PIN_ID.toUpperCase()} now`), {
    uri: `metaapp://${PIN_ID}`,
  });
  assert.deepEqual(normalizeBrowserOpenTarget('open map://Some/Path/Here'), { uri: 'map://Some/Path/Here' });
  assert.deepEqual(normalizeBrowserOpenTarget('metafile://' + PIN_ID), { uri: 'metafile://' + PIN_ID });
});

test('normalizeBrowserOpenTarget rejects unsupported URI schemes', () => {
  const result = normalizeBrowserOpenTarget('open https://example.com please');
  assert.equal(result.uri, undefined);
  assert.equal(result.error, 'Unsupported Browser URI scheme: https.');
});

test('normalizeBrowserOpenTarget maps bare pinIds to pin:// or metaapp://', () => {
  assert.deepEqual(normalizeBrowserOpenTarget(`open ${PIN_ID}`), { uri: `pin://${PIN_ID}` });
  assert.deepEqual(normalizeBrowserOpenTarget(`open the metaapp ${PIN_ID}`), { uri: `metaapp://${PIN_ID}` });
  assert.deepEqual(normalizeBrowserOpenTarget(`打开应用 ${PIN_ID}`), { uri: `metaapp://${PIN_ID}` });
});

test('normalizeBrowserOpenTarget maps globalMetaIds and web3 domains to metaid://', () => {
  assert.deepEqual(normalizeBrowserOpenTarget(`visit ${GLOBAL_META_ID}`), { uri: `metaid://${GLOBAL_META_ID}` });
  assert.deepEqual(normalizeBrowserOpenTarget('open vitalik.eth'), { uri: 'metaid://vitalik.eth' });
  assert.deepEqual(normalizeBrowserOpenTarget('open alice.btc'), { uri: 'metaid://alice.btc' });
});

test('normalizeBrowserOpenTarget errors on empty and unrecognizable input', () => {
  assert.equal(normalizeBrowserOpenTarget('   ').error, 'Missing Browser target.');
  assert.equal(normalizeBrowserOpenTarget('hello world').error, 'No supported Browser target found.');
});

test('builds a single browser_open tool', () => {
  const { byName } = makeHarness();
  assert.ok(byName.browser_open);
  assert.equal(Object.keys(byName).length, 1);
});

test('open (default action) normalizes the target and calls openUri with actorId', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.browser_open.handler({ target: PIN_ID, actor_id: ' bot-1 ' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.openUri, [{ uri: `pin://${PIN_ID}`, actorId: 'bot-1' }]);
  assert.equal(calls.execute.length, 0);
  assert.match(result.content[0].text, new RegExp(`Opened pin://${PIN_ID} in the Bot Browser\\.`));
});

test('open without actor_id forwards undefined actorId', async () => {
  const { calls, byName } = makeHarness();
  await byName.browser_open.handler({ target: 'vitalik.eth' });
  assert.deepEqual(calls.openUri, [{ uri: 'metaid://vitalik.eth', actorId: undefined }]);
});

test('open without a target returns an error and never touches the browser', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.browser_open.handler({ action: 'open' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /requires a target/);
  assert.equal(calls.openUri.length, 0);
  assert.equal(calls.execute.length, 0);
});

test('open with an unrecognizable target surfaces the normalization error', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.browser_open.handler({ target: 'ftp://example.com' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unsupported Browser URI scheme: ftp\./);
  assert.equal(calls.openUri.length, 0);
});

test('open_tab normalizes the target and executes open-tab, listing tabs after', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.browser_open.handler({ action: 'open_tab', target: `metaapp ${PIN_ID}` });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.execute, [{ action: 'open-tab', uri: `metaapp://${PIN_ID}` }]);
  assert.match(result.content[0].text, /in a new tab/);
  assert.match(result.content[0].text, /\* \[1\] Alice — metaid:\/\/idq1alice/);
});

test('close_tab and switch_tab require tab_id and map to bridge actions', async () => {
  const { calls, byName } = makeHarness();

  const missing = await byName.browser_open.handler({ action: 'close_tab' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /requires tab_id/);

  const closed = await byName.browser_open.handler({ action: 'close_tab', tab_id: 2 });
  assert.equal(closed.isError, undefined);
  assert.deepEqual(calls.execute[0], { action: 'close-tab', tabId: 2 });

  const switched = await byName.browser_open.handler({ action: 'switch_tab', tab_id: 1 });
  assert.equal(switched.isError, undefined);
  assert.deepEqual(calls.execute[1], { action: 'switch-tab', tabId: 1 });
});

test('list_tabs formats the tab list via the bridge', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.browser_open.handler({ action: 'list_tabs' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.execute, [{ action: 'get-tabs' }]);
  const text = result.content[0].text;
  assert.match(text, /Open tabs \(\* = active\):/);
  assert.match(text, /\* \[1\] Alice — metaid:\/\/idq1alice/);
  assert.match(text, /\[2\] \(untitled\) — metaapp:\/\//);
});

test('get_active_tab reports the active tab, or the lack of one', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.browser_open.handler({ action: 'get_active_tab' });
  assert.deepEqual(calls.execute, [{ action: 'get-active-tab' }]);
  assert.match(result.content[0].text, /Active tab: \[1\] Alice — metaid:\/\/idq1alice/);

  const empty = makeHarness({ executeResult: { ...SAMPLE_TABS_RESULT, activeTab: null } });
  const noActive = await empty.byName.browser_open.handler({ action: 'get_active_tab' });
  assert.match(noActive.content[0].text, /No active Bot Browser tab\./);
});

test('bridge and openUri failures become error results without throwing', async () => {
  const openFail = makeHarness({ openUriError: new Error('broadcast failed') });
  const r1 = await openFail.byName.browser_open.handler({ target: PIN_ID });
  assert.equal(r1.isError, true);
  assert.match(r1.content[0].text, /Failed to control Bot Browser: broadcast failed\./);
  assert.match(r1.content[0].text, /Bot Browser surface may not be open/);

  const execFail = makeHarness({ executeError: new Error('bridge disposed') });
  const r2 = await execFail.byName.browser_open.handler({ action: 'list_tabs' });
  assert.equal(r2.isError, true);
  assert.match(r2.content[0].text, /Failed to control Bot Browser: bridge disposed\./);
});
