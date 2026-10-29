import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { buildFriendAgentTools } = require('../dist-electron/main/libs/friendAgentTools.js');

const SELF = 'idq1self000001';
const PEER = 'idq1peer000001';

const RELATION_FRIEND = {
  globalMetaId: PEER,
  relation: 'friend',
  isFriend: true,
  followsMe: true,
  followedByMe: true,
  blocking: false,
  blockedBy: false,
};

function makeHarness(overrides = {}) {
  const calls = { resolve: [], list: [] };
  const control = {
    resolveRelationship: async (input) => {
      calls.resolve.push(input);
      if (overrides.resolveError) throw overrides.resolveError;
      return overrides.resolveResult ?? RELATION_FRIEND;
    },
    listConnections: async (input) => {
      calls.list.push(input);
      if (overrides.listError) throw overrides.listError;
      return overrides.listResult ?? { items: [], nextCursor: null, hasMore: false };
    },
  };
  const tools = buildFriendAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    control,
    getSelfGlobalMetaId: overrides.self === null ? () => null : () => SELF,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

test('builds check_peer_relationship and list_social_connections tools', () => {
  const { byName } = makeHarness();
  assert.ok(byName.check_peer_relationship);
  assert.ok(byName.list_social_connections);
});

test('check_peer_relationship unwraps metaid:// input and renders the full relation sheet', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.check_peer_relationship.handler({ peer: `metaid://${PEER}` });
  assert.equal(calls.resolve.length, 1);
  assert.equal(calls.resolve[0].selfGlobalMetaId, SELF);
  assert.equal(calls.resolve[0].peerIdentity, PEER, 'metaid:// wrapper must be stripped before the control call');
  const text = result.content[0].text;
  assert.match(text, new RegExp(`\\[idq1peer000001\\]\\(metaid://${PEER}\\)`));
  assert.match(text, /relation: friend \(mutual follow\)/);
  assert.match(text, /isFriend \(mutual follow\): true/);
  assert.match(text, /followsMe \(peer follows you\): true/);
  assert.match(text, /blocking \(you block peer\): false/);
  assert.match(text, /blockedBy \(peer blocks you\): false/);
  assert.doesNotMatch(text, /isError/);
  assert.equal(result.isError, undefined);
});

test('friend relations get point-to-point guidance; non-friend relations get the escrow rule', async () => {
  const friend = makeHarness();
  const friendText = (await friend.byName.check_peer_relationship.handler({ peer: PEER })).content[0].text;
  assert.match(friendText, /direct point-to-point asset transfers are acceptable/i);
  assert.doesNotMatch(friendText, /escrow\/middleman before any transfer/i);

  const stranger = makeHarness({
    resolveResult: { ...RELATION_FRIEND, relation: 'stranger', isFriend: false, followsMe: false, followedByMe: false },
  });
  const strangerText = (await stranger.byName.check_peer_relationship.handler({ peer: PEER })).content[0].text;
  assert.match(strangerText, /NOT a confirmed friend/i);
  assert.match(strangerText, /escrow\/middleman/i);
  assert.match(strangerText, /Scenario B/i);
  assert.match(strangerText, /seller and buyer each transfer to the escrow first/i);

  const blocked = makeHarness({
    resolveResult: { ...RELATION_FRIEND, relation: 'blocked', blocking: true, blockedBy: false },
  });
  const blockedText = (await blocked.byName.check_peer_relationship.handler({ peer: PEER })).content[0].text;
  assert.match(blockedText, /A block is active/i);
  assert.match(blockedText, /do not enter new transactions/i);
});

test('check_peer_relationship validates input and degrades honestly on failure or missing identity', async () => {
  const empty = makeHarness();
  const emptyResult = await empty.byName.check_peer_relationship.handler({ peer: '   ' });
  assert.equal(emptyResult.isError, true);
  assert.match(emptyResult.content[0].text, /non-empty peer identity/);
  assert.equal(empty.calls.resolve.length, 0);

  const noSelf = makeHarness({ self: null });
  const noSelfResult = await noSelf.byName.check_peer_relationship.handler({ peer: PEER });
  assert.equal(noSelfResult.isError, true);
  assert.match(noSelfResult.content[0].text, /No acting MetaBot identity/);
  assert.equal(noSelf.calls.resolve.length, 0);

  const failing = makeHarness({ resolveError: new Error('Social relationship API error 50000: aggregation unavailable') });
  const failingResult = await failing.byName.check_peer_relationship.handler({ peer: PEER });
  assert.equal(failingResult.isError, true);
  assert.match(failingResult.content[0].text, /lookup failed/);
  assert.match(failingResult.content[0].text, /relationship is unknown/);
});

test('list_social_connections renders linked entries, block metadata, and pagination hints', async () => {
  const { calls, byName } = makeHarness({
    listResult: {
      items: [
        { globalMetaId: PEER, name: 'Peer Bot', blockedAt: 1793240000, blockPinId: 'bp1i0' },
        { globalMetaId: 'idq1other00001', name: 'Other Bot', friendSince: 1760800100 },
      ],
      nextCursor: 'cur2',
      hasMore: true,
    },
  });
  const result = await byName.list_social_connections.handler({ list: 'blocked', size: 50, cursor: 'cur1' });
  assert.deepEqual(calls.list, [
    { selfGlobalMetaId: SELF, list: 'blocked', size: 50, cursor: 'cur1' },
  ]);
  const text = result.content[0].text;
  assert.match(text, /\[Peer Bot\]\(metaid:\/\/idq1peer000001\)/);
  assert.match(text, /block pin: bp1i0/);
  assert.match(text, /blocked at: \d{4}-\d{2}-\d{2}/);
  assert.match(text, /friends since:/);
  assert.match(text, /names MUST stay clickable markdown links/);
  assert.match(text, /cursor="cur2"/);
});

test('list_social_connections rejects bad list values and empty rosters are honest', async () => {
  const { calls, byName } = makeHarness();
  const badList = await byName.list_social_connections.handler({ list: 'enemies' });
  assert.equal(badList.isError, true);
  assert.match(badList.content[0].text, /list must be one of friends, followers, following, blocked, blocked_by/);
  assert.equal(calls.list.length, 0);

  const empty = await byName.list_social_connections.handler({ list: 'friends' });
  assert.equal(empty.isError, undefined);
  assert.match(empty.content[0].text, /No friends \(mutual follows\) for idq1self000001 yet/);
  assert.match(empty.content[0].text, /do NOT invent entries/);

  const noSelf = makeHarness({ self: null });
  const noSelfResult = await noSelf.byName.list_social_connections.handler({ list: 'following' });
  assert.equal(noSelfResult.isError, true);
  assert.match(noSelfResult.content[0].text, /No acting MetaBot identity/);

  const failing = makeHarness({ listError: new Error('boom') });
  const failingResult = await failing.byName.list_social_connections.handler({ list: 'followers' });
  assert.equal(failingResult.isError, true);
  assert.match(failingResult.content[0].text, /list is unavailable/);
});
