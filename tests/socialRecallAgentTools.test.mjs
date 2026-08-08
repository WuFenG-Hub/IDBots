import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { buildSocialRecallAgentTools, formatSocialPostBullets, formatSocialPostDetail, formatSocialComments } = require('../dist-electron/main/libs/socialRecallAgentTools.js');

const SAMPLE_POST = {
  pinId: 'b6b9449bi0',
  sourcePinId: 'b6b9449bi0',
  currentPinId: 'b6b9449bi0',
  chainName: 'mvc',
  protocolPath: '/protocols/simplebuzz',
  author: {
    globalMetaId: 'idq1alice123',
    metaId: 'legacyMetaId1',
    address: 'addr1',
  },
  contentType: 'application/json;utf-8',
  payload: {
    content: 'AI 生态观察：今天链上的新进展，值得关注',
    contentType: 'text/plain;utf-8',
    attachments: ['metafile://a275356ai0'],
  },
  createdAt: 1786122527,
  updatedAt: 1786122527,
  likeCount: 2,
  commentCount: 1,
  donateCount: 0,
  quoteCount: 1,
  isOwn: false,
};

const SAMPLE_COMMENT = {
  pinId: 'c1abcdei0',
  chainName: 'mvc',
  targetPinId: 'b6b9449bi0',
  authorGlobalMetaId: 'idq1bob456',
  authorMetaId: 'legacyMetaId2',
  authorAddress: 'addr2',
  content: '很有意思，支持！',
  contentType: 'text/plain',
  timestamp: 1772292925,
};

function makeHarness(overrides = {}) {
  const calls = { feed: [], post: [], comments: [] };
  const socialRecall = {
    feed: async (input) => {
      calls.feed.push(input);
      return overrides.feedResult ?? { items: [], hasMore: false };
    },
    post: async (pinId) => {
      calls.post.push(pinId);
      if (overrides.postError) throw overrides.postError;
      return overrides.postResult ?? SAMPLE_POST;
    },
    comments: async (input) => {
      calls.comments.push(input);
      return overrides.commentsResult ?? { items: [], hasMore: false };
    },
  };
  const tools = buildSocialRecallAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    socialRecall,
    openBestMatchInBrowser: overrides.openBestMatchInBrowser ?? false,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

test('registers the three social recall tools', () => {
  const { byName } = makeHarness();
  assert.deepEqual(Object.keys(byName).sort(), ['search_social_posts', 'social_post_comments', 'social_post_detail']);
});

test('search_social_posts splits query into OR keywords and passes filters through', async () => {
  const { calls, byName } = makeHarness({ feedResult: { items: [SAMPLE_POST], hasMore: true, nextCursor: 'k:next' } });
  const result = await byName.search_social_posts.handler({
    query: 'AI, MVC 早报',
    sinceDays: 1,
    chainName: 'mvc',
    size: 50,
  });
  const request = calls.feed[0];
  assert.deepEqual(request.keywords, ['AI', 'MVC', '早报']);
  assert.equal(request.chainName, 'mvc');
  assert.equal(request.size, 50);
  // sinceDays=1 → since is roughly now-1d (tolerance for test runtime).
  const now = Math.floor(Date.now() / 1000);
  assert.ok(request.since <= now - 86400 + 60);
  assert.ok(request.since >= now - 86400 - 60);
  assert.equal(request.scope, undefined);
  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  assert.match(text, /1 on-chain post\(s\) \(matching "AI", "MVC", "早报"; within the last 1 day\(s\); on mvc\), newest first/);
  assert.match(text, /metaid:\/\/idq1alice123/);
  assert.match(text, /pin: b6b9449bi0/);
  assert.match(text, /cursor="k:next"/);
});

test('search_social_posts maps following=true to scope=following', async () => {
  const { calls, byName } = makeHarness();
  await byName.search_social_posts.handler({ following: true, query: '新帖', size: 20 });
  assert.equal(calls.feed[0].scope, 'following');
  assert.deepEqual(calls.feed[0].keywords, ['新帖']);
});

test('search_social_posts maps sort=hot and labels hot ordering', async () => {
  const { calls, byName } = makeHarness({
    feedResult: { items: [{ ...SAMPLE_POST, hotScore: 9, likeCount: 9 }], hasMore: false },
  });
  const result = await byName.search_social_posts.handler({ sort: 'hot' });
  assert.equal(calls.feed[0].sort, 'hot');
  const text = result.content[0].text;
  assert.match(text, /hot-ranked first/);
  assert.match(text, /hot 9/);
  assert.doesNotMatch(text, /cursor=/);
});

test('search_social_posts degrades empty results by dropping the last keyword once', async () => {
  let emptyFirst = true;
  const calls = { feed: [] };
  const tools = buildSocialRecallAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    socialRecall: {
      feed: async (input) => {
        calls.feed.push(input);
        if (emptyFirst) {
          emptyFirst = false;
          return { items: [], hasMore: false };
        }
        return { items: [SAMPLE_POST], hasMore: false };
      },
      post: async () => SAMPLE_POST,
      comments: async () => ({ items: [], hasMore: false }),
    },
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  const result = await byName.search_social_posts.handler({ query: 'AI 大模型' });
  assert.equal(calls.feed.length, 2);
  assert.deepEqual(calls.feed[0].keywords, ['AI', '大模型']);
  assert.deepEqual(calls.feed[1].keywords, ['AI']);
  assert.match(result.content[0].text, /1 on-chain post\(s\)/);
});

test('search_social_posts reports an honest empty message', async () => {
  const { byName } = makeHarness();
  const result = await byName.search_social_posts.handler({ query: 'AI' });
  assert.match(result.content[0].text, /No on-chain social posts matched \(matching "AI"\). Tell the user honestly; do NOT invent posts\./);
});

test('social_post_detail passes pinId through and formats the engagement sheet', async () => {
  const { calls, byName } = makeHarness({ postResult: { ...SAMPLE_POST, isOwn: true } });
  const result = await byName.social_post_detail.handler({ pinId: 'b6b9449bi0' });
  assert.equal(calls.post[0], 'b6b9449bi0');
  const text = result.content[0].text;
  assert.match(text, /Post b6b9449bi0:/);
  assert.match(text, /metaid:\/\/idq1alice123/);
  assert.match(text, /your post/);
  assert.match(text, /likes 2 \| comments 1 \| quotes 1 \| donates 0/);
  assert.match(text, /2026-08-07/);
});

test('social_post_detail reports 40400 honestly', async () => {
  const notFound = new Error('post not found');
  notFound.name = 'SocialRecallNotFoundError';
  const { byName } = makeHarness({ postError: notFound });
  const result = await byName.social_post_detail.handler({ pinId: 'missing' });
  assert.match(result.content[0].text, /No on-chain post matches pinId "missing" \(missing or hidden\)/);
});

test('social_post_comments lists comments with pagination hint', async () => {
  const { calls, byName } = makeHarness({
    commentsResult: { items: [SAMPLE_COMMENT], hasMore: true, nextCursor: 'k:c2' },
  });
  const result = await byName.social_post_comments.handler({ pinId: 'b6b9449bi0', size: 30 });
  assert.deepEqual(calls.comments[0], { pinId: 'b6b9449bi0', size: 30, cursor: undefined });
  const text = result.content[0].text;
  assert.match(text, /1 comment\(s\) on post "b6b9449bi0":/);
  assert.match(text, /很有意思，支持！/);
  assert.match(text, /metaid:\/\/idq1bob456/);
  assert.match(text, /cursor="k:c2"/);
});

test('formatters keep author links clickable and skip empty payloads gracefully', () => {
  const bullet = formatSocialPostBullets([{ ...SAMPLE_POST, payload: null, isOwn: false }]);
  assert.match(bullet, /\(no text content\)/);
  assert.match(bullet, /\[idq1alice123\]\(metaid:\/\/idq1alice123\)/);

  const detail = formatSocialPostDetail({ ...SAMPLE_POST, isOwn: false });
  assert.match(detail, /- content: AI 生态观察/);
  assert.match(detail, /- attachments: metafile:\/\/a275356ai0/);

  const comments = formatSocialComments([SAMPLE_COMMENT]);
  assert.match(comments, /\[idq1bob456\]\(metaid:\/\/idq1bob456\)/);
});
