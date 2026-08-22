import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const {
  buildNetworkServicesAgentTools,
  filterAndRankOnlineServices,
  formatOnlineServicesDetails,
  formatOnlineServicesTable,
} = require('../dist-electron/main/libs/networkServicesAgentTools.js');

const WEATHER = {
  servicePinId: 'weatherpini0',
  displayName: 'Weather Service',
  serviceName: 'weather-service',
  description: 'Returns one weather forecast',
  price: '0.0001',
  currency: 'SPACE',
  providerGlobalMetaId: 'idq1alice123456',
  providerName: 'Alice',
  providerSkill: 'weather',
  ratingAvg: 4.8,
  ratingCount: 12,
  lastSeenAgoSeconds: 5,
  updatedAt: 100,
  isOwn: true,
};

const TRANSLATE = {
  servicePinId: 'translatepini0',
  displayName: 'Translate',
  serviceName: 'translate-service',
  description: 'Chinese to English translation',
  price: '0.0002',
  currency: 'SPACE',
  providerGlobalMetaId: 'idq1bob789',
  providerName: 'Bob | Lang',
  providerSkill: 'translate',
  ratingAvg: 4.2,
  ratingCount: 3,
  lastSeenAgoSeconds: 20,
  updatedAt: 90,
};

const TAROT = {
  servicePinId: 'tarotpini0',
  displayName: 'Tarot reading',
  serviceName: 'tarot-service',
  description: 'fortune for tomorrow',
  price: '',
  currency: '',
  providerGlobalMetaId: 'idq1carol',
  providerName: '',
  providerSkill: 'tarot',
  ratingAvg: null,
  ratingCount: 0,
  lastSeenAgoSeconds: null,
  updatedAt: 80,
};

function makeHarness(overrides = {}) {
  const calls = { list: 0 };
  const networkServices = {
    listOnlineServices: async () => {
      calls.list += 1;
      if (overrides.listError) throw overrides.listError;
      return overrides.page ?? { services: [WEATHER, TRANSLATE, TAROT] };
    },
  };
  const tools = buildNetworkServicesAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    networkServices,
    openBestMatchInBrowser: overrides.openBestMatchInBrowser ?? false,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

test('filterAndRankOnlineServices ranks query hits and drops misses', () => {
  const ranked = filterAndRankOnlineServices([WEATHER, TRANSLATE, TAROT], 'translate chinese');
  assert.deepEqual(ranked.map((row) => row.servicePinId), ['translatepini0']);
});

test('filterAndRankOnlineServices without query prefers more recently seen', () => {
  const ranked = filterAndRankOnlineServices([TRANSLATE, WEATHER, TAROT]);
  assert.deepEqual(ranked.map((row) => row.servicePinId), ['weatherpini0', 'translatepini0', 'tarotpini0']);
});

test('formatOnlineServicesTable keeps provider metaid links and marks isOwn', () => {
  const table = formatOnlineServicesTable([WEATHER, TRANSLATE, TAROT]);
  assert.match(table, /\| # \| service \| provider \| price \| Last Seen \|/);
  assert.match(table, /\[Alice\]\(metaid:\/\/idq1alice123456\) \(your MetaBot\)/);
  assert.match(table, /0\.0001SPACE/);
  assert.match(table, /5s 🟢/);
  assert.match(table, /Bob \\\| Lang/);
  assert.match(table, /\[idq1carol\]\(metaid:\/\/idq1carol\)/);
  assert.match(table, /\| - \| - \|/);
});

test('formatOnlineServicesDetails keeps pin ids for delegation', () => {
  const details = formatOnlineServicesDetails([WEATHER]);
  assert.match(details, /pin weatherpini0/);
  assert.match(details, /skill: weather/);
  assert.match(details, /rating 4\.8 \(12\)/);
});

test('builds list_online_services', () => {
  const { byName } = makeHarness();
  assert.ok(byName.list_online_services);
});

test('list_online_services returns a linked table with chat-view guidance', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.list_online_services.handler({ query: 'weather', limit: 20 });
  assert.equal(calls.list, 1);
  const text = result.content[0].text;
  assert.match(text, /Currently online MetaWeb services \(1–1 of 1, query "weather"\)/);
  assert.match(text, /Weather Service/);
  assert.match(text, /pin weatherpini0/);
  assert.match(text, /REUSING it verbatim/);
  assert.match(text, /Do NOT open anything in the Bot Browser/);
  assert.doesNotMatch(text, /bot_browser_open_uri/);
  assert.doesNotMatch(text, /Translate/);
});

test('list_online_services tells browser sessions they may open a provider page', async () => {
  const { byName } = makeHarness({ openBestMatchInBrowser: true });
  const result = await byName.list_online_services.handler({});
  assert.match(result.content[0].text, /bot_browser_open_uri/);
});

test('list_online_services clamps limit and surfaces a next cursor', async () => {
  const { byName } = makeHarness();
  const result = await byName.list_online_services.handler({ limit: 1 });
  const text = result.content[0].text;
  assert.match(text, /1–1 of 3/);
  assert.match(text, /cursor=1/);
  assert.doesNotMatch(text, /Translate/);
});

test('list_online_services reports empty matches honestly', async () => {
  const { byName } = makeHarness({ page: { services: [WEATHER] } });
  const result = await byName.list_online_services.handler({ query: 'not-a-real-skill' });
  assert.match(result.content[0].text, /No currently-online MetaWeb services matched/);
  assert.equal(result.isError, undefined);
});

test('list_online_services surfaces directory failures as tool errors', async () => {
  const { byName } = makeHarness({ listError: new Error('snapshot unavailable') });
  const result = await byName.list_online_services.handler({});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /snapshot unavailable/);
});
