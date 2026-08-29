import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const {
  buildOnlineBotsAgentTools,
  formatOnlineBotsTable,
  summarizeBio,
} = require('../dist-electron/main/libs/onlineBotsAgentTools.js');

const TWIN = {
  globalMetaId: 'idq1g35d5yftpq3jv0ukejte7z76qdqp7sve8l2etm',
  name: 'Twin Bot',
  bio: '{"background":"","boss_id":"6","createdBy":"0000","goal":"","llm":"deepseek","role":"我是你的数字主分身 (I am your primary digital twin)","soul":"没什么性格，没什么价值观，没什么喜好。","skills":[],"tools":[]}',
  lastSeenAgoSeconds: 0,
  deviceCount: 1,
  isOwn: true,
};

const JIANGYICHEN = {
  globalMetaId: 'idq1resnev5x2dlugfazpnw5qwefala0ygmskgmf6e',
  name: 'AI_江亦辰',
  bio: '',
  lastSeenAgoSeconds: 3,
  deviceCount: 2,
};

const ANON = {
  globalMetaId: 'idq1q28s8l7ennwzwr6eejwghhu4eekee68k9dev45',
  name: '',
  bio: 'plain text bio',
  lastSeenAgoSeconds: 45,
  deviceCount: 1,
};

function makeHarness(overrides = {}) {
  const calls = { args: [] };
  const onlineBots = {
    listOnlineBots: async (input) => {
      calls.args.push(input);
      if (overrides.listError) throw overrides.listError;
      return overrides.page ?? { total: 3, onlineWindowSeconds: 1200, list: [TWIN, JIANGYICHEN, ANON] };
    },
  };
  const tools = buildOnlineBotsAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    onlineBots,
    openBestMatchInBrowser: overrides.openBestMatchInBrowser ?? false,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

test('summarizeBio flattens persona JSON blobs to readable prose', () => {
  assert.equal(
    summarizeBio(TWIN.bio),
    '我是你的数字主分身 (I am your primary digital twin) · 没什么性格，没什么价值观，没什么喜好。',
  );
});

test('summarizeBio passes through non-JSON and non-persona bios', () => {
  assert.equal(summarizeBio(''), '');
  assert.equal(summarizeBio('  plain bio  '), 'plain bio');
  assert.equal(summarizeBio('{not json'), '{not json');
  assert.equal(summarizeBio('{"foo":"bar"}'), '{"foo":"bar"}');
});

test('formatOnlineBotsTable keeps metaid links, isOwn marks and last-seen', () => {
  const table = formatOnlineBotsTable([TWIN, JIANGYICHEN, ANON]);
  assert.match(table, /\| # \| name \| globalMetaId \| bio \| Last Seen \|/);
  assert.match(table, /\[Twin Bot\]\(metaid:\/\/idq1g35d5yftpq3jv0ukejte7z76qdqp7sve8l2etm\) \(your MetaBot\)/);
  assert.match(table, /\[idq1g35d5yftpq3jv0ukejte7z76qdqp7sve8l2etm\]\(metaid:\/\/idq1g35d5yftpq3jv0ukejte7z76qdqp7sve8l2etm\)/);
  assert.match(table, /我是你的数字主分身/);
  assert.match(table, /3s 🟢/);
  assert.match(table, /\[idq1q28s8l7ennwzwr6eejwghhu4eekee68k9dev45\]\(metaid:\/\/idq1q28s8l7ennwzwr6eejwghhu4eekee68k9dev45\)/);
  assert.match(table, /plain text bio/);
});

test('formatOnlineBotsTable truncates long bios and escapes pipes', () => {
  const table = formatOnlineBotsTable([{
    ...ANON,
    bio: `head|pipe${'x'.repeat(80)}`,
  }]);
  assert.doesNotMatch(table, /head\|pipe/);
  assert.match(table, /head\\\|pipe/);
  assert.doesNotMatch(table, /x{61,}/);
});

test('builds list_online_bots', () => {
  const { byName } = makeHarness();
  assert.ok(byName.list_online_bots);
  assert.match(byName.list_online_bots.description, /who is online RIGHT NOW/i);
});

test('list_online_bots returns a linked table with chat-view guidance', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.list_online_bots.handler({ limit: 20 });
  assert.equal(calls.args.length, 1);
  const text = result.content[0].text;
  assert.match(text, /Currently online identities \(1–3 of 3; presence window ≈ 20 min\)/);
  assert.match(text, /Twin Bot/);
  assert.match(text, /REUSING it verbatim/);
  assert.match(text, /Do NOT open anything in the Bot Browser/);
  assert.doesNotMatch(text, /bot_browser_open_uri/);
  assert.doesNotMatch(text, /cursor=/);
});

test('list_online_bots tells browser sessions they may open a Bot page', async () => {
  const { byName } = makeHarness({ openBestMatchInBrowser: true });
  const result = await byName.list_online_bots.handler({});
  assert.match(result.content[0].text, /bot_browser_open_uri/);
});

test('list_online_bots clamps limit/cursor and surfaces a next cursor', async () => {
  const { calls, byName } = makeHarness({
    page: { total: 10, onlineWindowSeconds: 1200, list: [TWIN, JIANGYICHEN] },
  });
  const result = await byName.list_online_bots.handler({ limit: 500, cursor: -4 });
  assert.deepEqual(calls.args[0], { cursor: 0, limit: 100 });
  const text = result.content[0].text;
  assert.match(text, /1–2 of 10/);
  assert.match(text, /cursor=2/);
});

test('list_online_bots omits the pagination note on the last page', async () => {
  const { byName } = makeHarness({
    page: { total: 4, onlineWindowSeconds: 1200, list: [ANON] },
  });
  const result = await byName.list_online_bots.handler({ cursor: 3, limit: 5 });
  assert.doesNotMatch(result.content[0].text, /cursor=/);
});

test('list_online_bots is honest when nobody is online', async () => {
  const { byName } = makeHarness({ page: { total: 0, onlineWindowSeconds: 1200, list: [] } });
  const result = await byName.list_online_bots.handler({});
  assert.match(result.content[0].text, /No identities are currently online/);
  assert.match(result.content[0].text, /do NOT invent people/);
});

test('list_online_bots reports control failures as tool errors', async () => {
  const { byName } = makeHarness({ listError: new Error('HTTP 503') });
  const result = await byName.list_online_bots.handler({});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Online presence lookup failed: HTTP 503/);
});
