import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildMetawebStudyAgentTools,
  formatStudyJobList,
} = require('../dist-electron/main/libs/metawebStudyAgentTools.js');

const SESSION_ID = 'sess-qa-surf-1';
const METABOT_ID = 7;

function surfJobFixture(overrides = {}) {
  return {
    id: 'qa-surf-1',
    metabotId: METABOT_ID,
    kind: 'qa-surf',
    topic: 'On-chain Q&A surfing',
    topicFingerprint: 'qa-surf',
    status: 'pending',
    budgetPins: 10,
    processedPinIds: ['q1i0', 'q2i0'],
    runCount: 3,
    consecutiveFailures: 0,
    lastRunAt: '2026-09-07T02:00:00.000Z',
    lastRunSummary: 'answered 1, saved 2',
    lastError: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-07T02:30:00.000Z',
    ...overrides,
  };
}

function makeHarness(overrides = {}) {
  const calls = { enqueueSurf: [], disableSurf: [] };
  const metawebStudy = {
    enqueueStudyJob: async () => { throw new Error('not used here'); },
    enqueueQaSurfJob: (metabotId, input) => {
      calls.enqueueSurf.push({ metabotId, input });
      if (overrides.enqueueSurfError) throw overrides.enqueueSurfError;
      return overrides.enqueueSurfResult ?? { job: surfJobFixture(), created: true };
    },
    disableQaSurfJob: (metabotId) => {
      calls.disableSurf.push(metabotId);
      return overrides.disableResult ?? true;
    },
    listStudyJobs: (metabotId) => overrides.jobs ?? [surfJobFixture()],
  };
  const tools = buildMetawebStudyAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    metawebStudy,
    sessionId: SESSION_ID,
    resolveMetabotId: (sessionId) => ('metabotId' in overrides ? overrides.metabotId : METABOT_ID),
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

test('registers the surf enable/disable tools beside the study tools', () => {
  const { byName } = makeHarness();
  assert.deepEqual(Object.keys(byName), [
    'metaweb_study_enqueue',
    'metaweb_qa_surf_enqueue',
    'metaweb_qa_surf_disable',
    'metaweb_study_status',
  ]);
});

test('metaweb_qa_surf_enqueue passes the budget through and explains the recurring contract', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.metaweb_qa_surf_enqueue.handler({ nightly_budget: 15 });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.enqueueSurf, [{ metabotId: METABOT_ID, input: { budgetPins: 15 } }]);
  const text = result.content[0].text;
  assert.match(text, /Nightly Q&A surfing enabled/);
  assert.match(text, /recurring|recurs/i);
  assert.match(text, /metaweb_qa_surf_disable/);
  // Already-active is a no-op message, not an error.
  const active = makeHarness({ enqueueSurfResult: { job: surfJobFixture({ status: 'running', runCount: 5 }), created: false } });
  const activeResult = await active.byName.metaweb_qa_surf_enqueue.handler({});
  assert.equal(activeResult.isError, undefined);
  assert.match(activeResult.content[0].text, /already running/);
});

test('metaweb_qa_surf_enqueue fails honestly without a bot or on service errors', async () => {
  const noBot = makeHarness({ metabotId: undefined });
  const noBotResult = await noBot.byName.metaweb_qa_surf_enqueue.handler({});
  assert.equal(noBotResult.isError, true);
  assert.match(noBotResult.content[0].text, /could not resolve which MetaBot/);
  const failing = makeHarness({ enqueueSurfError: new Error('db locked') });
  const failingResult = await failing.byName.metaweb_qa_surf_enqueue.handler({});
  assert.equal(failingResult.isError, true);
  assert.match(failingResult.content[0].text, /failed: db locked/);
});

test('metaweb_qa_surf_disable distinguishes stopped vs nothing-active', async () => {
  const { calls, byName } = makeHarness();
  const stopped = await byName.metaweb_qa_surf_disable.handler({});
  assert.equal(stopped.isError, undefined);
  assert.deepEqual(calls.disableSurf, [METABOT_ID]);
  assert.match(stopped.content[0].text, /disabled/i);
  const none = makeHarness({ disableResult: false });
  const noneResult = await none.byName.metaweb_qa_surf_disable.handler({});
  assert.equal(noneResult.isError, undefined);
  assert.match(noneResult.content[0].text, /not active/);
});

test('study status renders surf jobs as recurring with handled-pins wording', () => {
  const list = formatStudyJobList([surfJobFixture()]);
  assert.match(list, /\[recurring Q&A surfing\]/);
  assert.match(list, /pins handled: 2/);
  const topicList = formatStudyJobList([surfJobFixture({ kind: 'topic', topic: 'video', processedPinIds: ['a'] })]);
  assert.doesNotMatch(topicList, /recurring/);
  assert.match(topicList, /pins saved: 1/);
});

// ---------------------------------------------------------------------------
// Session wiring: surf allowlist + kind pass-through (source anchors)
// ---------------------------------------------------------------------------

test('coworkRunner has a qa-surf allowlist: learning tools + answer/react, nothing else', () => {
  const runnerSource = require('node:fs')
    .readFileSync(new URL('../dist-electron/main/libs/coworkRunner.js', import.meta.url), 'utf8');
  const studyMatch = runnerSource.match(/METAWEB_STUDY_TOOL_ALLOWLIST = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(studyMatch, 'study allowlist exists');
  const studyAllowlist = studyMatch[1];
  const allowlistMatch = runnerSource.match(/METAWEB_QA_SURF_TOOL_ALLOWLIST = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(allowlistMatch, 'surf allowlist exists');
  const allowlist = allowlistMatch[1];
  // The learning surface is inherited via the study allowlist spread…
  for (const expected of [
    "'read_metaweb_pin'",
    "'knowledge_base_add_document'",
    "'knowledge_base_learn'",
    "'procedure_save'",
  ]) {
    assert.ok(studyAllowlist.includes(expected), `study allowlist contains ${expected}`);
  }
  assert.match(allowlist, /\.\.\.METAWEB_STUDY_TOOL_ALLOWLIST/);
  // …and the surf additions are exactly the Q&A participation tools.
  for (const expected of [
    "'search_qa'",
    "'list_latest_questions'",
    "'get_question_answers'",
    "'post_simpleanswer'",
    "'like_pin'",
  ]) {
    assert.ok(allowlist.includes(expected), `surf allowlist contains ${expected}`);
  }
  // Absence beats deny: no asking, no buzz/notes, no generic caster.
  assert.doesNotMatch(allowlist, /post_simplequestion/);
  assert.doesNotMatch(allowlist, /post_buzz/);
  assert.doesNotMatch(allowlist, /post_simplenote/);
  assert.doesNotMatch(allowlist, /omni_cast/);
  // The kind switch routes surf sessions to it.
  assert.match(runnerSource, /kind === 'qa-surf'/);
});

test('main.ts passes the job kind into the study session', () => {
  const mainSource = require('node:fs')
    .readFileSync(new URL('../dist-electron/main/main.js', import.meta.url), 'utf8');
  assert.match(mainSource, /metawebStudySession:\s*\{\s*pinBudget:\s*job\.budgetPins,\s*kind:\s*job\.kind\s*\}/);
});
