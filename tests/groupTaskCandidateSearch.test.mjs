import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const search = require('../dist-electron/main/services/groupTaskCandidateSearch.js');

const {
  evaluateImpressionForSeat,
  resolveSeatSearchQuery,
  scoreSeatResume,
  searchGroupTaskSeatCandidates,
  setGroupTaskCandidateSearchDepsGetter,
  LOCAL_TIE_MARGIN,
} = search;

const TWIN = 'idq1chair00000000000000000000000000000000';
const LOCAL = 'idq1localw00000000000000000000000000000';
const REMOTE = 'idq1remotea00000000000000000000000000000';

function impression(overrides = {}) {
  return {
    capabilityTags: [],
    collaborationFacts: [],
    ...overrides,
  };
}

function wire(overrides = {}) {
  const snapshots = overrides.snapshots ?? new Map();
  setGroupTaskCandidateSearchDepsGetter(() => ({
    listLocalWorkers: () => overrides.locals ?? [
      {
        metabotId: 2,
        name: 'Writer Bot',
        enabled: true,
        type: 'worker',
        globalMetaId: LOCAL,
        bio: '商业文案与产品介绍',
        role: '内容',
        goal: null,
        chatSkills: ['copy'],
      },
    ],
    getTwinObserverGlobalMetaId: () => TWIN,
    getImpressionSnapshot: (observer, subject) => snapshots.get(`${observer}:${subject}`) ?? null,
    searchRemote: overrides.searchRemote ?? (async () => [
      {
        globalMetaId: REMOTE,
        name: 'Remote Counsel',
        bio: '商业合同与合规审查',
        chatSkills: ['legal-review'],
        chainName: 'mvc',
        isOnline: true,
        lastSeenAgoSeconds: 10,
      },
    ]),
  }));
}

test('resolveSeatSearchQuery expands a coarse seat when Twin omits keywords', () => {
  assert.match(resolveSeatSearchQuery({ roleHint: 'design' }), /设计/);
  assert.match(resolveSeatSearchQuery({ query: '法律', roleHint: 'domain', domainLabel: 'legal' }), /法律/);
  assert.equal(resolveSeatSearchQuery({}), '');
});

test('scoreSeatResume weighs name > skills > bio and counts role/goal', () => {
  const tokens = ['video'];
  const named = scoreSeatResume({ name: 'video Bot', bio: '', chatSkills: [], role: '', goal: '' }, tokens);
  const skilled = scoreSeatResume({ name: 'X', bio: '', chatSkills: ['video'], role: '', goal: '' }, tokens);
  const bioed = scoreSeatResume({ name: 'X', bio: 'I do video', chatSkills: [], role: '', goal: '' }, tokens);
  const roleHit = scoreSeatResume({ name: 'X', bio: '', chatSkills: [], role: 'video', goal: '' }, tokens);
  assert.ok(named.score > skilled.score);
  assert.ok(skilled.score > bioed.score);
  assert.ok(bioed.score > roleHit.score);
  assert.ok(roleHit.score > 0);
});

test('evaluateImpressionForSeat blocks weak:<seat> and rejected facts on that seat', () => {
  const blockedTag = evaluateImpressionForSeat(impression({ capabilityTags: ['weak:design'] }), 'design');
  assert.equal(blockedTag.verdict, 'block');
  const otherSeat = evaluateImpressionForSeat(impression({ capabilityTags: ['weak:design'] }), 'content');
  assert.notEqual(otherSeat.verdict, 'block');
  const rejected = evaluateImpressionForSeat(impression({
    collaborationFacts: [{
      taskId: 1, title: '海报', seatRole: 'design', outcome: 'deliverable_rejected', pinIds: ['p'],
    }],
  }), 'design');
  assert.equal(rejected.verdict, 'block');
  const done = evaluateImpressionForSeat(impression({
    collaborationFacts: [{
      taskId: 2, title: '介绍文案', seatRole: 'content', outcome: 'done', pinIds: ['p'],
    }],
  }), 'content');
  assert.equal(done.verdict, 'boost');
  const cancelled = evaluateImpressionForSeat(impression({
    collaborationFacts: [{
      taskId: 3, title: '周报', outcome: 'cancelled', pinIds: ['p'],
    }],
  }), 'content');
  assert.equal(cancelled.verdict, 'demote');
  assert.equal(evaluateImpressionForSeat(null, 'design').verdict, 'unknown');
});

test('searchGroupTaskSeatCandidates merges local+remote and tie-breaks toward local', async () => {
  wire({
    searchRemote: async () => [{
      globalMetaId: REMOTE,
      name: 'Writer Cloud',
      bio: '商业文案与产品介绍',
      chatSkills: ['copy'],
      chainName: 'mvc',
      isOnline: true,
      lastSeenAgoSeconds: 3,
    }],
  });
  try {
    const result = await searchGroupTaskSeatCandidates({ query: '文案 介绍', roleHint: 'content', limit: 10 });
    assert.equal(result.roleHint, 'content');
    assert.ok(result.primary, 'has a primary');
    assert.equal(result.primary.source, 'local', 'close scores prefer the local writer');
    assert.ok(result.candidates.some((row) => row.source === 'remote'));
    assert.ok(result.candidates.every((row) => row.source === 'local' || row.source === 'remote'));
    assert.ok(LOCAL_TIE_MARGIN >= 1);
  } finally {
    setGroupTaskCandidateSearchDepsGetter(null);
  }
});

test('searchGroupTaskSeatCandidates drops a weak:design local from the design seat', async () => {
  const snapshots = new Map([
    [`${TWIN}:${LOCAL}`, impression({ capabilityTags: ['weak:design'] })],
  ]);
  wire({
    snapshots,
    locals: [{
      metabotId: 2,
      name: 'Writer Bot',
      enabled: true,
      type: 'worker',
      globalMetaId: LOCAL,
      bio: '视觉设计与海报',
      role: '设计',
      goal: null,
      chatSkills: ['design'],
    }],
    searchRemote: async () => [{
      globalMetaId: REMOTE,
      name: 'Pixel',
      bio: '视觉设计 视频',
      chatSkills: ['design'],
      chainName: 'mvc',
      isOnline: true,
      lastSeenAgoSeconds: 1,
    }],
  });
  try {
    const result = await searchGroupTaskSeatCandidates({ query: '设计 视频', roleHint: 'design' });
    assert.equal(result.blocked.length, 1);
    assert.equal(result.blocked[0].name, 'Writer Bot');
    assert.ok(!result.candidates.some((row) => row.name === 'Writer Bot'));
    assert.equal(result.primary?.name, 'Pixel');
    assert.equal(result.primary?.source, 'remote');
  } finally {
    setGroupTaskCandidateSearchDepsGetter(null);
  }
});

test('searchGroupTaskSeatCandidates drops a remote that is already a local worker', async () => {
  wire({
    searchRemote: async () => [{
      globalMetaId: LOCAL,
      name: 'Writer Cloud Twin',
      bio: '商业文案与产品介绍',
      chatSkills: ['copy'],
      chainName: 'mvc',
      isOnline: true,
      lastSeenAgoSeconds: 1,
    }],
  });
  try {
    const result = await searchGroupTaskSeatCandidates({ query: '文案', roleHint: 'content' });
    assert.equal(result.candidates.filter((row) => (row.globalMetaId || '').toLowerCase() === LOCAL).length, 1);
    assert.equal(result.primary?.source, 'local');
  } finally {
    setGroupTaskCandidateSearchDepsGetter(null);
  }
});

test('searchGroupTaskSeatCandidates boosts a prior done collaborator over an unknown peer', async () => {
  const other = 'idq1remoteb00000000000000000000000000000';
  wire({
    locals: [],
    snapshots: new Map([
      [`${TWIN}:${REMOTE}`, impression({
        collaborationFacts: [{
          taskId: 1, title: '介绍文案', seatRole: 'content', outcome: 'done', pinIds: ['p'],
        }],
      })],
    ]),
    searchRemote: async () => [
      {
        globalMetaId: other,
        name: 'B Writer',
        bio: '商业文案与产品介绍',
        chatSkills: ['copy'],
        chainName: 'mvc',
        isOnline: true,
        lastSeenAgoSeconds: 2,
      },
      {
        globalMetaId: REMOTE,
        name: 'A Writer',
        bio: '商业文案与产品介绍',
        chatSkills: ['copy'],
        chainName: 'mvc',
        isOnline: true,
        lastSeenAgoSeconds: 2,
      },
    ],
  });
  try {
    const result = await searchGroupTaskSeatCandidates({ query: '文案', roleHint: 'content' });
    assert.equal(result.primary?.name, 'A Writer');
    assert.equal(result.primary?.impression.verdict, 'boost');
    assert.ok((result.primary?.score ?? 0) > (result.backup?.score ?? 0));
  } finally {
    setGroupTaskCandidateSearchDepsGetter(null);
  }
});

test('searchGroupTaskSeatCandidates keeps locals when online search fails', async () => {
  wire({
    searchRemote: async () => {
      throw new Error('presence_unavailable');
    },
  });
  try {
    const result = await searchGroupTaskSeatCandidates({ query: '文案', roleHint: 'content' });
    assert.equal(result.primary?.source, 'local');
    assert.match(result.warnings.join('; '), /online search failed/);
    assert.equal(result.candidates.some((row) => row.source === 'remote'), false);
  } finally {
    setGroupTaskCandidateSearchDepsGetter(null);
  }
});

test('searchGroupTaskSeatCandidates sends query and roleHint to bots/search and keeps server score', async () => {
  let captured;
  wire({
    locals: [],
    searchRemote: async (input) => {
      captured = input;
      return [{
        globalMetaId: REMOTE,
        name: 'Counsel-bot',
        bio: '商业合同与合规审查',
        role: '法律顾问',
        goal: '帮客户审查合同',
        chatSkills: ['legal-review'],
        isOnline: true,
        lastSeenAgoSeconds: 42,
        score: 28,
        matchReasons: [{ field: 'bio', token: '合同', weight: 2 }],
        groupTaskCount: 2,
        recentGroupTasks: [{
          groupId: 'g1:i0',
          title: '合同审查协作',
          goal: '',
          joinedAs: 'chair',
          joinedAt: 1779000000,
          joinPinId: 'create-g1:i0',
          stillMember: true,
          kind: 'group',
        }],
      }];
    },
  });
  try {
    const result = await searchGroupTaskSeatCandidates({
      query: '法律 合同',
      roleHint: 'domain',
      domainLabel: 'legal',
    });
    assert.equal(captured.query, '法律 合同');
    assert.equal(captured.roleHint, 'domain');
    assert.ok(captured.excludeGlobalMetaIds.includes(TWIN));
    assert.equal(result.primary?.name, 'Counsel-bot');
    assert.equal(result.primary?.role, '法律顾问');
    assert.equal(result.primary?.rawScore, 28);
    assert.equal(result.primary?.groupTaskCount, 2);
    assert.equal(result.primary?.recentGroupTasks[0].groupId, 'g1:i0');
    assert.equal(result.primary?.matchReasons[0].field, 'bio');
  } finally {
    setGroupTaskCandidateSearchDepsGetter(null);
  }
});

test('searchGroupTaskSeatCandidates requires a query or role hint', async () => {
  wire({ searchRemote: async () => [] });
  try {
    await assert.rejects(
      () => searchGroupTaskSeatCandidates({}),
      /query or role_hint is required/,
    );
  } finally {
    setGroupTaskCandidateSearchDepsGetter(null);
  }
});
