import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { buildMetaIdSearchAgentTools, formatMetaIdCandidates } = require('../dist-electron/main/libs/metaIdSearchAgentTools.js');

const SEARCH_CANDIDATE = {
  globalMetaId: 'idq1alice123456',
  metaId: 'legacyMetaId1',
  address: 'addr1',
  chainName: 'mvc',
  name: 'Alice',
  avatarId: '',
  bio: '链上生活记录者',
  chatSkills: ['translate', 'draw'],
  hasChatPubkey: true,
  hasHomepage: false,
  createdAt: 1768284841,
  updatedAt: 1768284841,
  isOwn: true,
};

const SAMPLE_PROFILE = {
  ...SEARCH_CANDIDATE,
  isOwn: false,
  avatarId: 'avatarPin1i0',
  avatarContentType: 'image/png',
  role: 'translator bot',
  soul: '热情开朗',
  goal: '帮助用户跨语言交流',
  persona: { traits: ['cheerful'] },
  llm: { provider: 'anthropic', model: 'claude-sonnet', name: 'Alice Brain' },
  homepage: { type: 'metaidapp', uri: 'metaidapp://home' },
  background: '/content/bgpini0',
  chatPubkey: 'pubkey123',
  fieldPins: { name: 'namepini0' },
};

function makeHarness(overrides = {}) {
  const calls = { search: [], detail: [] };
  const metaIdSearch = {
    search: async (input) => {
      calls.search.push(input);
      return overrides.searchResult ?? { items: [], hasMore: false };
    },
    detail: async (identity) => {
      calls.detail.push(identity);
      if (overrides.detailError) throw overrides.detailError;
      return overrides.detailResult ?? SAMPLE_PROFILE;
    },
  };
  const tools = buildMetaIdSearchAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    metaIdSearch,
    openBestMatchInBrowser: overrides.openBestMatchInBrowser ?? false,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

test('builds search_metaids and metaid_profile tools', () => {
  const { byName } = makeHarness();
  assert.ok(byName.search_metaids);
  assert.ok(byName.metaid_profile);
});

test('search_metaids returns linked candidates with isOwn marking and chat-view guidance', async () => {
  const { calls, byName } = makeHarness({
    searchResult: { items: [SEARCH_CANDIDATE], hasMore: false },
  });
  const result = await byName.search_metaids.handler({ query: 'alice', limit: 5 });
  assert.equal(calls.search.length, 1);
  assert.equal(calls.search[0].keyword, 'alice');
  assert.equal(calls.search[0].limit, 5);
  const text = result.content[0].text;
  // Name renders as a full-length metaid link — never shortened, never plain text.
  assert.match(text, /\[Alice\]\(metaid:\/\/idq1alice123456\)/);
  assert.match(text, /your MetaBot/);
  assert.match(text, /链上生活记录者/);
  assert.match(text, /skills: translate, draw/);
  assert.match(text, /chain: mvc/);
  assert.match(text, /open to private chat/);
  // Chat-surface guidance: present links, never auto-open the Bot Browser.
  assert.match(text, /REUSING the bullet lines above verbatim/);
  assert.match(text, /Do NOT open anything in the Bot Browser/);
  assert.doesNotMatch(text, /bot_browser_open_uri/);
});

test('search_metaids tells browser sessions to open the best match with bot_browser_open_uri', async () => {
  const { byName } = makeHarness({
    openBestMatchInBrowser: true,
    searchResult: { items: [SEARCH_CANDIDATE], hasMore: false },
  });
  const result = await byName.search_metaids.handler({ query: 'alice' });
  const text = result.content[0].text;
  assert.match(text, /bot_browser_open_uri/);
  assert.match(text, /metaid:\/\/<globalMetaId>/);
  assert.match(text, /2–3 alternatives/);
});

test('search_metaids maps filters and surfaces nextCursor when hasMore', async () => {
  const { calls, byName } = makeHarness({
    searchResult: { items: [SEARCH_CANDIDATE], hasMore: true, nextCursor: 'next1' },
  });
  const result = await byName.search_metaids.handler({
    skill: 'draw',
    chainName: 'btc',
    chatOnly: true,
    hasHomepage: true,
    sinceDays: 7,
    cursor: 'prev-cursor',
  });
  assert.equal(calls.search.length, 1);
  assert.equal(calls.search[0].skill, 'draw');
  assert.equal(calls.search[0].chainName, 'btc');
  assert.equal(calls.search[0].hasChatPubkey, true);
  assert.equal(calls.search[0].hasHomepage, true);
  assert.equal(typeof calls.search[0].since, 'number');
  assert.equal(calls.search[0].cursor, 'prev-cursor');
  assert.match(result.content[0].text, /cursor="next1"/);
});

test('search_metaids degrades an empty multi-token query once then reports honestly', async () => {
  const { calls, byName } = makeHarness({ searchResult: { items: [], hasMore: false } });
  const result = await byName.search_metaids.handler({ query: '开朗 爱笑 聊天' });
  // First attempt with the full query, retry with the last token dropped.
  assert.deepEqual(calls.search.map((input) => input.keyword), ['开朗 爱笑 聊天', '开朗 爱笑']);
  assert.match(result.content[0].text, /No on-chain MetaID identities matched/);
  assert.match(result.content[0].text, /do NOT invent/);
});

test('search_metaids does not degrade cursor pagination requests', async () => {
  const { calls, byName } = makeHarness({ searchResult: { items: [], hasMore: false } });
  await byName.search_metaids.handler({ query: '开朗 爱笑', cursor: 'page2' });
  assert.equal(calls.search.length, 1);
});

test('metaid_profile strips the metaid:// prefix and formats the full profile', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.metaid_profile.handler({ identity: 'metaid://idq1alice123456' });
  assert.deepEqual(calls.detail, ['idq1alice123456']);
  const text = result.content[0].text;
  assert.match(text, /Profile of \[Alice\]\(metaid:\/\/idq1alice123456\)/);
  assert.match(text, /- bio: 链上生活记录者/);
  assert.match(text, /- role: translator bot/);
  assert.match(text, /- soul: 热情开朗/);
  assert.match(text, /- chatSkills: translate, draw/);
  assert.match(text, /- llm: anthropic\/claude-sonnet \(Alice Brain\)/);
  assert.match(text, /- persona: \{"traits":\["cheerful"\]\}/);
  assert.match(text, /- private chat: available \(chatpubkey set\)/);
  assert.match(text, /- avatar: https:\/\/file\.metaid\.io\/metafile-indexer\/api\/v1\/files\/accelerate\/content\/avatarPin1i0/);
  assert.match(text, /registered: 2026-01-13 \| last updated: 2026-01-13/);
  // Chat-surface guidance: keep links clickable, do not auto-open.
  assert.match(text, /Do NOT open the Bot Browser/);
});

test('metaid_profile tells browser sessions they may open the bot page', async () => {
  const { byName } = makeHarness({ openBestMatchInBrowser: true });
  const result = await byName.metaid_profile.handler({ identity: 'idq1alice123456' });
  assert.match(result.content[0].text, /bot_browser_open_uri/);
});

test('metaid_profile reports an unknown identity honestly without an error flag', async () => {
  const notFound = new Error('identity not found');
  notFound.name = 'MetaIdSearchNotFoundError';
  const { byName } = makeHarness({ detailError: notFound });
  const result = await byName.metaid_profile.handler({ identity: 'idq1ghost' });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /No on-chain MetaID identity matches "idq1ghost"/);
  assert.match(result.content[0].text, /do NOT invent/);
});

test('metaid_profile rejects an empty identity and flags generic failures', async () => {
  const { byName } = makeHarness({ detailError: new Error('network down') });
  const empty = await byName.metaid_profile.handler({ identity: 'metaid://  ' });
  // parseIdentityInput strips the scheme; an empty remainder is rejected before the host call.
  assert.equal(empty.isError, true);
  const failed = await byName.metaid_profile.handler({ identity: 'idq1alice123456' });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /network down/);
});

test('formatMetaIdCandidates sanitizes markdown brackets in names', () => {
  const text = formatMetaIdCandidates([{ ...SEARCH_CANDIDATE, name: 'A[li]ce', isOwn: false }]);
  assert.match(text, /\[Alice\]\(metaid:\/\/idq1alice123456\)/);
  assert.doesNotMatch(text, /A\[li\]ce/);
});
