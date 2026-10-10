/**
 * Dream-RSI exploration P0, commit 1 (design 2026-10-10 §3.2/§3.3): dream
 * output `practice_proposals` parsing + the `dream_practice_proposals` store.
 *
 * Covers:
 *   1. schema — table/index created by the idempotent migration, defaults on
 *      raw inserts, re-running initializeTables is a no-op and preserves rows,
 *   2. parseDreamOutput — code fences, unknown fields dropped, camelCase
 *      alias, empty/missing target_refs dropped (anti-hallucination),
 *      invalid risk_class falls back to read_only, 2-per-night cap,
 *   3. insertDreamPracticeProposals — title/prompt validation, risk_class
 *      default, status always 'pending',
 *   4. state machine — legal and illegal transitions, lazy TTL expiry, purge,
 *   5. end-to-end — a dream run persists parsed proposals as pending rows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore, getColumns, getIndexNames } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

const {
  parseDreamOutput,
  buildDreamPrompt,
  PRACTICE_PROPOSALS_MAX_PER_NIGHT,
} = require('../dist-electron/main/libs/dreamPrompt.js');
const { PRACTICE_PROPOSAL_TTL_DAYS } = require('../dist-electron/main/coworkStore.js');

function loadDreamServiceModule() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => process.cwd(),
        },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return require('../dist-electron/main/services/dreamService.js');
  } finally {
    Module._load = originalLoad;
  }
}

const { DreamService } = loadDreamServiceModule();
const { DreamStore } = require('../dist-electron/main/dreamStore.js');

const DAY = '2026-08-02';
const DAY_START = new Date(2026, 7, 2).getTime();
const DAYMS = 86_400_000;
const LONG_IDENTITY = `我是一个认真严谨的 MetaBot。${'我先验证再交付。'.repeat(30)}`;

const makePayload = (practiceProposals, overrides = {}) => JSON.stringify({
  daily_summary: '今天复盘了自己的薄弱点。',
  sections: {},
  work_reviews: [],
  important_memories: [],
  value_lessons: [],
  self_identity: LONG_IDENTITY,
  ...(practiceProposals !== undefined ? { practice_proposals: practiceProposals } : {}),
  ...overrides,
});

const seedActivity = (coworkStore, db) => {
  const session = coworkStore.createSession('和用户聊发布', '/tmp/a', '', 'local', [], 5);
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['m1', session.id, 'user', '视频做好了吗', '{}', DAY_START + 1000, 1]
  );
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['m2', session.id, 'assistant', '做好了,你看下', '{}', DAY_START + 2000, 2]
  );
  return session;
};

const metabotStoreStub = () => ({
  listMetabots: () => [
    { id: 5, name: '小火', role: '视频创作者', soul: '认真严谨', llm_id: 'bot-own-llm', enabled: true },
  ],
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

test('schema: dream_practice_proposals table, index, defaults, idempotent re-init', async () => {
  const { db, store, userDataPath, cleanup } = await createSqliteStore();
  try {
    const columns = getColumns(db, 'dream_practice_proposals');
    for (const column of [
      'id', 'metabot_id', 'dream_date', 'title', 'prompt', 'rationale',
      'target_refs_json', 'expected_evidence', 'risk_class', 'status',
      'scheduled_task_id', 'run_id', 'outcome_summary', 'created_at', 'updated_at',
    ]) {
      assert.ok(columns.includes(column), `missing column ${column}`);
    }
    assert.ok(
      getIndexNames(db, 'dream_practice_proposals').includes('idx_dream_practice_proposals_metabot_status'),
      'metabot/status index exists',
    );

    // Raw inserts get the documented defaults (status/risk_class/target_refs).
    db.run(
      `INSERT INTO dream_practice_proposals (metabot_id, dream_date, title, prompt, created_at, updated_at)
       VALUES (5, '2026-08-01', '练习', '指令', 1, 1)`,
    );
    const row = db.exec('SELECT status, risk_class, target_refs_json FROM dream_practice_proposals')[0].values[0];
    assert.equal(row[0], 'pending');
    assert.equal(row[1], 'read_only');
    assert.equal(row[2], '[]');

    // Re-running the whole schema pass is a no-op and preserves rows.
    store.initializeTables(userDataPath);
    assert.equal(db.exec('SELECT COUNT(*) FROM dream_practice_proposals')[0].values[0][0], 1);
    assert.deepEqual(
      getColumns(db, 'dream_practice_proposals').sort(),
      columns.sort(),
      're-init neither drops nor duplicates columns',
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Parser (parseDreamOutput → practiceProposals)
// ---------------------------------------------------------------------------

test('parser accepts fenced JSON and drops unknown fields on proposals', () => {
  const fenced = '```json\n' + makePayload([
    {
      title: ' 对比实验:两种检索策略 ',
      prompt: ' 完整的练习指令 ',
      rationale: '上周检索漏掉证据',
      target_refs: ['draft:12', ' date:2026-08-01 ', 'draft:12'],
      expected_evidence: '两种策略的召回差异',
      risk_class: 'interact_local',
      status: 'approved',
      unexpected: 'dropped',
    },
  ]) + '\n```';
  const result = parseDreamOutput(fenced);
  assert.equal(result.ok, true);
  const output = result.ok ? result.output : null;
  assert.equal(output.practiceProposals.length, 1);
  const proposal = output.practiceProposals[0];
  assert.equal(proposal.title, '对比实验:两种检索策略');
  assert.equal(proposal.prompt, '完整的练习指令');
  assert.equal(proposal.rationale, '上周检索漏掉证据');
  assert.deepEqual(proposal.targetRefs, ['draft:12', 'date:2026-08-01'], 'refs trimmed and deduped');
  assert.equal(proposal.expectedEvidence, '两种策略的召回差异');
  assert.equal(proposal.riskClass, 'interact_local');
  assert.equal('status' in proposal, false, 'model-supplied status is dropped');
  assert.equal('unexpected' in proposal, false, 'unknown fields are dropped');
});

test('parser accepts the camelCase practiceProposals alias', () => {
  const result = parseDreamOutput(makePayload([
    {
      title: '压力变体',
      prompt: '指令',
      targetRefs: ['procedure:3'],
      expectedEvidence: '证据',
      riskClass: 'chain_write',
    },
  ], {}).replace('"practice_proposals"', '"practiceProposals"'));
  assert.equal(result.ok, true);
  const output = result.ok ? result.output : null;
  assert.equal(output.practiceProposals.length, 1);
  assert.deepEqual(output.practiceProposals[0].targetRefs, ['procedure:3']);
  assert.equal(output.practiceProposals[0].riskClass, 'chain_write');
});

test('parser drops proposals without target_refs (anti-hallucination gate)', () => {
  const result = parseDreamOutput(makePayload([
    { title: '无出处', prompt: '指令', rationale: '泛泛的提升', risk_class: 'read_only' },
    { title: '空出处', prompt: '指令', target_refs: [], risk_class: 'read_only' },
    { title: '空白出处', prompt: '指令', target_refs: ['  ', ''], risk_class: 'read_only' },
    { title: '非数组出处', prompt: '指令', target_refs: 'draft:1', risk_class: 'read_only' },
    { title: '有出处', prompt: '指令', target_refs: ['draft:9'], risk_class: 'read_only' },
  ]));
  assert.equal(result.ok, true);
  const output = result.ok ? result.output : null;
  assert.deepEqual(output.practiceProposals.map((entry) => entry.title), ['有出处']);
});

test('parser defaults invalid risk_class to read_only and skips empty title/prompt', () => {
  const result = parseDreamOutput(makePayload([
    { title: '非法风险档', prompt: '指令', target_refs: ['draft:1'], risk_class: 'drop_tables' },
    { title: '大写风险档', prompt: '指令', target_refs: ['draft:1'], risk_class: 'INTERACT_LOCAL' },
    { title: '', prompt: '指令', target_refs: ['draft:1'] },
    { title: '无指令', prompt: '  ', target_refs: ['draft:1'] },
  ]));
  assert.equal(result.ok, true);
  const output = result.ok ? result.output : null;
  assert.deepEqual(
    output.practiceProposals.map((entry) => [entry.title, entry.riskClass]),
    [['非法风险档', 'read_only'], ['大写风险档', 'interact_local']],
  );
});

test('parser caps practice_proposals at PRACTICE_PROPOSALS_MAX_PER_NIGHT (2) per night', () => {
  assert.equal(PRACTICE_PROPOSALS_MAX_PER_NIGHT, 2);
  const proposals = [];
  for (let index = 1; index <= 4; index += 1) {
    proposals.push({
      title: `练习 ${index}`,
      prompt: `指令 ${index}`,
      target_refs: [`draft:${index}`],
      risk_class: 'read_only',
    });
  }
  const result = parseDreamOutput(makePayload(proposals));
  assert.equal(result.ok, true);
  const output = result.ok ? result.output : null;
  assert.deepEqual(
    output.practiceProposals.map((entry) => entry.title),
    ['练习 1', '练习 2'],
    'first two proposals survive, the rest is clamped',
  );
});

test('parser tolerates missing or non-array practice_proposals as an empty array', () => {
  for (const payload of [makePayload(undefined), makePayload('nonsense'), makePayload({})]) {
    const result = parseDreamOutput(payload);
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.output.practiceProposals : null, []);
  }
});

test('buildDreamPrompt instructs practice_proposals with the self-curriculum rules', () => {
  const prompt = buildDreamPrompt({
    botName: '小火',
    date: DAY,
    activity: { sessions: [], taskRuns: [], orderCount: 0, groupTasks: [] },
  });
  assert.match(prompt.user, /"practice_proposals"/);
  assert.match(prompt.user, /"target_refs"/);
  assert.match(prompt.user, /"risk_class"/);
  assert.match(prompt.user, /记录在案的薄弱点/, 'only recorded weaknesses may be targeted');
  assert.match(prompt.user, /自包含/, 'proposals must be self-contained');
  assert.match(prompt.user, /判别式实验/, 'discriminating experiments preferred');
  assert.match(prompt.user, /每晚最多 2 条/, 'nightly cap stated');
});

// ---------------------------------------------------------------------------
// Store: insert / list / get
// ---------------------------------------------------------------------------

test('insertDreamPracticeProposals validates title/prompt, defaults risk_class, lands pending', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  try {
    const inserted = coworkStore.insertDreamPracticeProposals(5, DAY, [
      {
        title: '对比实验:两轮记忆检索',
        prompt: '完整的练习指令',
        rationale: '上周检索漏证据',
        targetRefs: ['draft:12', 'draft:12', ' date:2026-08-01 '],
        expectedEvidence: '两种检索策略的结果差异',
        riskClass: 'interact_local',
      },
      { title: '', prompt: '无标题跳过', targetRefs: ['draft:1'] },
      { title: '无指令', prompt: '   ', targetRefs: ['draft:1'] },
      { title: '非法风险档', prompt: 'do X', riskClass: 'drop_tables', targetRefs: ['procedure:3'] },
      { title: '缺省风险档', prompt: 'do Y', targetRefs: ['date:2026-08-01'] },
    ]);
    assert.equal(inserted, 3, 'only valid entries are inserted');
    assert.equal(
      coworkStore.insertDreamPracticeProposals(0, DAY, [{ title: 't', prompt: 'p', targetRefs: ['draft:1'] }]),
      0,
      'invalid metabot id inserts nothing',
    );

    const rows = coworkStore.listDreamPracticeProposals(5);
    assert.equal(rows.length, 3);
    const byTitle = new Map(rows.map((row) => [row.title, row]));
    const full = byTitle.get('对比实验:两轮记忆检索');
    assert.equal(full.metabotId, 5);
    assert.equal(full.dreamDate, DAY);
    assert.equal(full.status, 'pending', 'every insert lands pending');
    assert.equal(full.riskClass, 'interact_local');
    assert.deepEqual(full.targetRefs, ['draft:12', 'date:2026-08-01'], 'refs deduped and trimmed');
    assert.equal(full.rationale, '上周检索漏证据');
    assert.equal(full.expectedEvidence, '两种检索策略的结果差异');
    assert.equal(full.scheduledTaskId, null);
    assert.equal(full.runId, null);
    assert.equal(full.outcomeSummary, null);
    assert.ok(full.createdAt > 0 && full.updatedAt > 0);
    assert.equal(byTitle.get('非法风险档').riskClass, 'read_only', 'unknown risk class falls back');
    assert.equal(byTitle.get('缺省风险档').riskClass, 'read_only', 'missing risk class defaults');
    assert.equal(byTitle.get('缺省风险档').rationale, null, 'missing rationale stores NULL');

    assert.equal(coworkStore.listDreamPracticeProposals(7).length, 0, 'other bots see nothing');
    assert.equal(coworkStore.listDreamPracticeProposals(5, { status: 'approved' }).length, 0);
    assert.equal(coworkStore.listDreamPracticeProposals(5, { status: 'pending' }).length, 3);

    const fetched = coworkStore.getDreamPracticeProposal(full.id, 5);
    assert.equal(fetched?.title, full.title);
    assert.equal(coworkStore.getDreamPracticeProposal(full.id, 999), null, 'ownership scoping hides the row');
    assert.equal(coworkStore.getDreamPracticeProposal(99999), null, 'unknown id reads as null');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

test('practice proposal state machine: legal transitions land, illegal ones refuse', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  try {
    coworkStore.insertDreamPracticeProposals(5, DAY, [
      { title: '走完整个生命周期', prompt: 'p', targetRefs: ['draft:1'] },
      { title: '直接否决', prompt: 'p', targetRefs: ['draft:2'] },
      { title: '先批准后否决', prompt: 'p', targetRefs: ['draft:3'] },
      { title: '排期后失败', prompt: 'p', targetRefs: ['draft:4'] },
    ]);
    const byTitle = (title) => coworkStore.listDreamPracticeProposals(5).find((row) => row.title === title);

    // Full legal path: pending → approved → scheduled → completed.
    const lifecycle = byTitle('走完整个生命周期');
    assert.equal(coworkStore.approveDreamPracticeProposal({ id: lifecycle.id, metabotId: 5 }), true);
    assert.equal(byTitle('走完整个生命周期').status, 'approved');
    assert.equal(
      coworkStore.markDreamPracticeProposalScheduled({ id: lifecycle.id, metabotId: 5, scheduledTaskId: 'task-uuid-1' }),
      true,
    );
    const scheduled = byTitle('走完整个生命周期');
    assert.equal(scheduled.status, 'scheduled');
    assert.equal(scheduled.scheduledTaskId, 'task-uuid-1');
    assert.equal(
      coworkStore.markDreamPracticeProposalCompleted({ id: lifecycle.id, metabotId: 5, runId: 'run-1', outcomeSummary: '练成了' }),
      true,
    );
    const completed = byTitle('走完整个生命周期');
    assert.equal(completed.status, 'completed');
    assert.equal(completed.runId, 'run-1');
    assert.equal(completed.outcomeSummary, '练成了');

    // Terminal states refuse further transitions.
    assert.equal(coworkStore.approveDreamPracticeProposal({ id: lifecycle.id, metabotId: 5 }), false);
    assert.equal(coworkStore.rejectDreamPracticeProposal({ id: lifecycle.id, metabotId: 5 }), false);
    assert.equal(
      coworkStore.markDreamPracticeProposalScheduled({ id: lifecycle.id, metabotId: 5, scheduledTaskId: 'task-uuid-2' }),
      false,
    );
    assert.equal(byTitle('走完整个生命周期').status, 'completed');

    // pending → rejected.
    const rejected = byTitle('直接否决');
    assert.equal(coworkStore.rejectDreamPracticeProposal({ id: rejected.id, metabotId: 5 }), true);
    assert.equal(byTitle('直接否决').status, 'rejected');
    assert.equal(coworkStore.approveDreamPracticeProposal({ id: rejected.id, metabotId: 5 }), false, 'rejected cannot be approved');

    // pending → approved → rejected (owner may reject at any point before scheduled).
    const lateRejected = byTitle('先批准后否决');
    assert.equal(coworkStore.approveDreamPracticeProposal({ id: lateRejected.id, metabotId: 5 }), true);
    assert.equal(
      coworkStore.rejectDreamPracticeProposal({ id: lateRejected.id, metabotId: 5, outcomeSummary: '主人觉得没必要' }),
      true,
    );
    const lateRejectedRow = byTitle('先批准后否决');
    assert.equal(lateRejectedRow.status, 'rejected');
    assert.equal(lateRejectedRow.outcomeSummary, '主人觉得没必要');
    assert.equal(
      coworkStore.markDreamPracticeProposalScheduled({ id: lateRejected.id, metabotId: 5, scheduledTaskId: 'task-uuid-3' }),
      false,
      'rejected cannot be scheduled',
    );

    // approved → scheduled → failed.
    const failedRun = byTitle('排期后失败');
    assert.equal(coworkStore.approveDreamPracticeProposal({ id: failedRun.id, metabotId: 5 }), true);
    assert.equal(
      coworkStore.markDreamPracticeProposalScheduled({ id: failedRun.id, metabotId: 5, scheduledTaskId: 'task-uuid-4' }),
      true,
    );
    assert.equal(
      coworkStore.markDreamPracticeProposalFailed({ id: failedRun.id, metabotId: 5, runId: 'run-4', outcomeSummary: '超时' }),
      true,
    );
    assert.equal(byTitle('排期后失败').status, 'failed');

    // Skipped stages refuse: pending → scheduled/completed/failed directly.
    coworkStore.insertDreamPracticeProposals(5, DAY, [{ title: '跳级', prompt: 'p', targetRefs: ['draft:5'] }]);
    const skipper = byTitle('跳级');
    assert.equal(
      coworkStore.markDreamPracticeProposalScheduled({ id: skipper.id, metabotId: 5, scheduledTaskId: 'task-uuid-5' }),
      false,
      'pending cannot be scheduled directly',
    );
    assert.equal(coworkStore.markDreamPracticeProposalCompleted({ id: skipper.id, metabotId: 5 }), false);
    assert.equal(coworkStore.markDreamPracticeProposalFailed({ id: skipper.id, metabotId: 5 }), false);
    assert.equal(
      coworkStore.markDreamPracticeProposalScheduled({ id: skipper.id, metabotId: 5, scheduledTaskId: '' }),
      false,
      'empty scheduledTaskId refuses',
    );
    assert.equal(byTitle('跳级').status, 'pending');

    // Wrong metabot id never transitions the row.
    assert.equal(coworkStore.approveDreamPracticeProposal({ id: skipper.id, metabotId: 999 }), false);
    assert.equal(byTitle('跳级').status, 'pending');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Lazy TTL expiry + purge
// ---------------------------------------------------------------------------

test('lazy TTL expiry: stale pending proposals expire on read, fresh ones survive', async () => {
  assert.equal(PRACTICE_PROPOSAL_TTL_DAYS, 3);
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  try {
    const now = Date.now();
    coworkStore.insertDreamPracticeProposals(5, DAY, [
      { title: '过期提案', prompt: 'p', targetRefs: ['draft:1'] },
      { title: '新鲜提案', prompt: 'p', targetRefs: ['draft:2'] },
      { title: '已批准不过期', prompt: 'p', targetRefs: ['draft:3'] },
    ]);
    const byTitle = (title) => coworkStore.listDreamPracticeProposals(5).find((row) => row.title === title);
    assert.equal(coworkStore.approveDreamPracticeProposal({ id: byTitle('已批准不过期').id, metabotId: 5 }), true);
    db.run(
      'UPDATE dream_practice_proposals SET created_at = ? WHERE title IN (?, ?)',
      [now - (PRACTICE_PROPOSAL_TTL_DAYS + 1) * DAYMS, '过期提案', '已批准不过期'],
    );

    // The sweep runs lazily inside the read: one stale pending row expires,
    // the approved row at the same age stays untouched.
    assert.equal(coworkStore.expireStaleDreamPracticeProposals(), 1);
    assert.equal(byTitle('过期提案').status, 'expired');
    assert.equal(byTitle('新鲜提案').status, 'pending');
    assert.equal(byTitle('已批准不过期').status, 'approved');
    assert.equal(coworkStore.expireStaleDreamPracticeProposals(), 0, 'the sweep is idempotent');

    // Expired rows refuse approval and leave the pending list.
    assert.equal(coworkStore.approveDreamPracticeProposal({ id: byTitle('过期提案').id, metabotId: 5 }), false);
    assert.deepEqual(
      coworkStore.listDreamPracticeProposals(5, { status: 'pending' }).map((row) => row.title),
      ['新鲜提案'],
    );

    // An explicit cutoff drives the sweep too (nightly caller shape).
    assert.equal(
      coworkStore.expireStaleDreamPracticeProposals({ cutoffMs: now + DAYMS }),
      1,
      'a future cutoff expires the remaining pending row',
    );
    assert.equal(byTitle('新鲜提案').status, 'expired');
  } finally {
    cleanup();
  }
});

test('purgeDreamPracticeProposals deletes only old rejected/expired rows', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  try {
    const now = Date.now();
    const OLD = now - 100 * DAYMS;
    coworkStore.insertDreamPracticeProposals(5, DAY, [
      { title: '旧否决', prompt: 'p', targetRefs: ['draft:1'] },
      { title: '旧过期', prompt: 'p', targetRefs: ['draft:2'] },
      { title: '新否决', prompt: 'p', targetRefs: ['draft:3'] },
      { title: '旧完成', prompt: 'p', targetRefs: ['draft:4'] },
      { title: '旧待批', prompt: 'p', targetRefs: ['draft:5'] },
    ]);
    coworkStore.insertDreamPracticeProposals(7, DAY, [{ title: '别家旧否决', prompt: 'p', targetRefs: ['draft:6'] }]);
    const byTitle = (title) => coworkStore.listDreamPracticeProposals(5).find((row) => row.title === title);
    coworkStore.rejectDreamPracticeProposal({ id: byTitle('旧否决').id, metabotId: 5 });
    coworkStore.rejectDreamPracticeProposal({ id: byTitle('新否决').id, metabotId: 5 });
    coworkStore.rejectDreamPracticeProposal({ id: coworkStore.listDreamPracticeProposals(7)[0].id, metabotId: 7 });
    const completed = byTitle('旧完成');
    coworkStore.approveDreamPracticeProposal({ id: completed.id, metabotId: 5 });
    coworkStore.markDreamPracticeProposalScheduled({ id: completed.id, metabotId: 5, scheduledTaskId: 'task-1' });
    coworkStore.markDreamPracticeProposalCompleted({ id: completed.id, metabotId: 5, runId: 'run-1' });
    // '旧过期' expires through the default sweep on a backdated created_at;
    // '旧待批' is fresh and stays pending. The purge keys on updated_at.
    db.run('UPDATE dream_practice_proposals SET created_at = ? WHERE title = ?', [OLD, '旧过期']);
    assert.equal(coworkStore.expireStaleDreamPracticeProposals(), 1);
    assert.equal(byTitle('旧过期').status, 'expired');
    assert.equal(byTitle('旧待批').status, 'pending');

    db.run(
      'UPDATE dream_practice_proposals SET updated_at = ? WHERE title IN (?, ?, ?, ?)',
      [OLD, '旧否决', '旧过期', '旧完成', '别家旧否决'],
    );

    const cutoff = now - 90 * DAYMS;
    assert.equal(
      coworkStore.purgeDreamPracticeProposals({ cutoffMs: cutoff, excludeMetabotIds: new Set([7]) }),
      2,
      'only the old rejected + expired rows of the included bots drain',
    );
    assert.deepEqual(
      coworkStore.listDreamPracticeProposals().map((row) => row.title).sort(),
      ['别家旧否决', '新否决', '旧完成', '旧待批'].sort(),
      'recent rows, completed rows, pending rows and excluded bots survive',
    );
    assert.equal(
      coworkStore.purgeDreamPracticeProposals({ cutoffMs: cutoff }),
      1,
      'exclusion lifted: the other bot drains',
    );
    assert.deepEqual(
      coworkStore.listDreamPracticeProposals().map((row) => row.title).sort(),
      ['新否决', '旧完成', '旧待批'].sort(),
      'completed and pending rows are never purged, however old',
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// End-to-end: dream run → pending proposal rows
// ---------------------------------------------------------------------------

test('end-to-end: dream run persists practice_proposals as pending rows (parse rules applied)', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  seedActivity(coworkStore, db);
  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 3, 3, 0),
    performChat: async () => makePayload([
      {
        title: '对比实验:发布前自检清单',
        prompt: '用两种自检清单各交付一次,对比漏检率。',
        rationale: 'draft:42 记录过交付漏检',
        target_refs: ['draft:42'],
        expected_evidence: '两次交付的漏检条目数差异',
        risk_class: 'read_only',
      },
      {
        title: '无出处提案',
        prompt: '这条没有 target_refs,必须被丢弃。',
        risk_class: 'read_only',
      },
      {
        title: '压力变体:深夜交付',
        prompt: '在深夜低速网络下重走上次的交付流程。',
        rationale: '2026-08-01 的交付在弱网下失败',
        target_refs: ['date:2026-08-01'],
        expected_evidence: '弱网下是否仍触发同一个超时坑',
        risk_class: 'nonsense',
      },
    ]),
  });
  try {
    await service.runNow(5, DAY);

    const rows = coworkStore.listDreamPracticeProposals(5);
    assert.equal(rows.length, 2, 'the uncited proposal is dropped by the parser');
    const byTitle = new Map(rows.map((row) => [row.title, row]));
    const first = byTitle.get('对比实验:发布前自检清单');
    assert.equal(first.status, 'pending');
    assert.equal(first.riskClass, 'read_only');
    assert.deepEqual(first.targetRefs, ['draft:42']);
    assert.equal(first.dreamDate, DAY);
    assert.equal(first.expectedEvidence, '两次交付的漏检条目数差异');
    const second = byTitle.get('压力变体:深夜交付');
    assert.equal(second.riskClass, 'read_only', 'invalid risk_class defaults to read_only end-to-end');
    assert.deepEqual(second.targetRefs, ['date:2026-08-01']);
    assert.equal(dreamStore.getRun(5, DAY).status, 'completed', 'the dream run itself is unaffected');
  } finally {
    cleanup();
  }
});
