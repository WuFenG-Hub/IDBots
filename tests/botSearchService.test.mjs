import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const {
  searchBots,
  BotSearchError,
  BOT_SEARCH_CODE_PRESENCE_UNAVAILABLE,
  DEFAULT_BOT_SEARCH_BASE_URL,
  BOT_SEARCH_PATH,
} = require('../dist-electron/main/services/botSearchService.js');

const SAMPLE = {
  globalMetaId: 'idq1alice123',
  metaId: 'legacy1',
  name: 'Counsel-bot',
  avatarId: 'avati0',
  bio: '商业合同与合规审查',
  role: '法律顾问',
  goal: '帮客户审查合同',
  chatSkills: ['legal-review'],
  publishedSkills: ['legal-review-service'],
  chainName: 'mvc',
  hasChatPubkey: true,
  hasHomepage: true,
  homepage: 'metaapp://home-a:i0',
  isOnline: true,
  lastSeenAgoSeconds: 42,
  groupTaskCount: 2,
  recentGroupTasks: [{
    groupId: 'g1:i0',
    title: '合同审查协作',
    goal: '审查合同条款',
    joinedAs: 'chair',
    joinedAt: 1779000000,
    joinPinId: 'create-g1:i0',
    stillMember: true,
    messageCount: 0,
    kind: 'group',
  }],
  score: 18.5,
  matchReasons: [{ field: 'bio', token: '合同', weight: 2 }],
};

function stubFetch(body, capture = {}) {
  return async (url, init) => {
    capture.url = url;
    capture.init = init;
    return {
      status: 200,
      json: async () => body,
    };
  };
}

test('searchBots POSTs the staffing query to so.metaid.io and normalizes the page', async () => {
  const capture = {};
  const page = await searchBots(
    {
      query: '法律 合同',
      roleHint: 'domain',
      skills: ['legal'],
      language: 'zh',
      excludeGlobalMetaIds: ['IDQ1LOCAL'],
      limit: 8,
    },
    {
      fetchImpl: stubFetch({
        code: 0,
        message: '',
        data: { candidates: [SAMPLE], nextCursor: null, queriedAt: 1780000000000 },
      }, capture),
    },
  );

  assert.equal(capture.url, `${DEFAULT_BOT_SEARCH_BASE_URL}${BOT_SEARCH_PATH}`);
  assert.equal(capture.init.method, 'POST');
  const body = JSON.parse(capture.init.body);
  assert.equal(body.query, '法律 合同');
  assert.equal(body.roleHint, 'domain');
  assert.deepEqual(body.skills, ['legal']);
  assert.equal(body.language, 'zh');
  assert.deepEqual(body.excludeGlobalMetaIds, ['IDQ1LOCAL']);
  assert.equal(body.limit, 8);
  assert.equal(body.onlineOnly, undefined);

  assert.equal(page.candidates.length, 1);
  assert.equal(page.candidates[0].globalMetaId, 'idq1alice123');
  assert.equal(page.candidates[0].role, '法律顾问');
  assert.equal(page.candidates[0].lastSeenAgoSeconds, 42);
  assert.equal(page.candidates[0].recentGroupTasks[0].joinedAs, 'chair');
  assert.equal(page.queriedAt, 1780000000000);
});

test('searchBots strips control characters and caps untrusted remote résumé fields', async () => {
  const page = await searchBots(
    { query: '合同' },
    {
      fetchImpl: stubFetch({
        code: 0,
        message: '',
        data: {
          candidates: [{
            ...SAMPLE,
            name: `Counsel\u0007-bot${'x'.repeat(200)}`,
            bio: `line1\n\nline2${'b'.repeat(600)}`,
            role: `法律顾问${'r'.repeat(300)}`,
            goal: `帮客户审查合同${'g'.repeat(300)}`,
            matchReasons: [{ field: 'bio', token: '合\u0001同', weight: 2 }],
          }],
          nextCursor: null,
          queriedAt: 1780000000000,
        },
      }),
    },
  );
  assert.equal(page.candidates[0].name.length, 80);
  assert.equal(page.candidates[0].name.includes('\u0007'), false);
  assert.equal(page.candidates[0].bio.length, 500);
  assert.equal(page.candidates[0].bio.includes('\n'), false);
  assert.equal(page.candidates[0].role.length, 200);
  assert.equal(page.candidates[0].goal.length, 200);
  assert.equal(page.candidates[0].matchReasons[0].token, '合同');
});

test('searchBots throws BotSearchError on presence_unavailable', async () => {
  await assert.rejects(
    () => searchBots(
      { query: '合同' },
      {
        fetchImpl: stubFetch({
          code: BOT_SEARCH_CODE_PRESENCE_UNAVAILABLE,
          message: 'presence_unavailable',
          data: { candidates: [], nextCursor: null, queriedAt: 1 },
        }),
      },
    ),
    (error) => error instanceof BotSearchError && error.code === BOT_SEARCH_CODE_PRESENCE_UNAVAILABLE,
  );
});
