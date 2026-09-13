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
  const calls = { setEnabled: [], startSurf: [], legacyDisable: [] };
  const metawebStudy = {
    enqueueStudyJob: async () => { throw new Error('not used here'); },
    disableQaSurfJob: (metabotId) => {
      calls.legacyDisable.push(metabotId);
      return true;
    },
    listStudyJobs: (metabotId) => overrides.jobs ?? [surfJobFixture()],
  };
  const metawebSurf = {
    setSurfBeforeDreamEnabled: (metabotId, enabled) => {
      calls.setEnabled.push({ metabotId, enabled });
      if (overrides.setEnabledError) throw overrides.setEnabledError;
    },
    isSurfBeforeDreamEnabled: () => true,
    startSurfForMetabot: (metabotId) => {
      calls.startSurf.push(metabotId);
      if (overrides.startSurfError) throw overrides.startSurfError;
      return { runId: 'surf-run-1' };
    },
    isSurfRunning: () => overrides.running ?? false,
  };
  const tools = buildMetawebStudyAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    metawebStudy,
    metawebSurf,
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
    'metaweb_study_status',
    'metaweb_qa_surf_enqueue',
    'metaweb_qa_surf_disable',
  ]);
});

test('study tools register without the surf control (controls are decoupled)', () => {
  const metawebStudy = {
    enqueueStudyJob: async () => { throw new Error('not used here'); },
    disableQaSurfJob: () => true,
    listStudyJobs: () => [],
  };
  const tools = buildMetawebStudyAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    metawebStudy,
    // no metawebSurf — a study-only embedding must keep the topic tools
    sessionId: SESSION_ID,
    resolveMetabotId: () => METABOT_ID,
  });
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['metaweb_study_enqueue', 'metaweb_study_status'],
    'topic tools survive a missing surf control; legacy aliases drop out',
  );
});

test('metaweb_qa_surf_enqueue aliases to MetaWeb surf: enables pre-dream surf, retires the legacy job, starts one run now', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.metaweb_qa_surf_enqueue.handler({});
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.setEnabled, [{ metabotId: METABOT_ID, enabled: true }]);
  assert.deepEqual(calls.legacyDisable, [METABOT_ID], 'legacy qa-surf row retired so it cannot double-run');
  assert.deepEqual(calls.startSurf, [METABOT_ID]);
  const text = result.content[0].text;
  assert.match(text, /Nightly MetaWeb surf enabled/);
  assert.match(text, /run id: surf-run-1/);
  assert.match(text, /recurs every night before dreaming/);
  assert.match(text, /metaweb_qa_surf_disable/);
});

test('metaweb_qa_surf_enqueue while a surf is running skips the duplicate start', async () => {
  const { calls, byName } = makeHarness({ running: true });
  const result = await byName.metaweb_qa_surf_enqueue.handler({});
  assert.equal(result.isError, undefined);
  assert.equal(calls.startSurf.length, 0);
  assert.match(result.content[0].text, /already in progress/);
});

test('metaweb_qa_surf_enqueue fails honestly without a bot or on errors', async () => {
  const noBot = makeHarness({ metabotId: undefined });
  const noBotResult = await noBot.byName.metaweb_qa_surf_enqueue.handler({});
  assert.equal(noBotResult.isError, true);
  assert.match(noBotResult.content[0].text, /could not resolve which MetaBot/);
  const failing = makeHarness({ setEnabledError: new Error('db locked') });
  const failingResult = await failing.byName.metaweb_qa_surf_enqueue.handler({});
  assert.equal(failingResult.isError, true);
  assert.match(failingResult.content[0].text, /failed: db locked/);
});

test('metaweb_qa_surf_disable turns pre-dream surf off and retires the legacy job', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.metaweb_qa_surf_disable.handler({});
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.setEnabled, [{ metabotId: METABOT_ID, enabled: false }]);
  assert.deepEqual(calls.legacyDisable, [METABOT_ID]);
  assert.match(result.content[0].text, /Nightly MetaWeb surf disabled/);
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
    "'read_metaweb_pins_batch'",
    "'metaweb_pin_versions'",
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

test('coworkRunner has a MetaWeb surf allowlist: participation tools present, dangerous tools absent', () => {
  const runnerSource = require('node:fs')
    .readFileSync(new URL('../dist-electron/main/libs/coworkRunner.js', import.meta.url), 'utf8');
  const match = runnerSource.match(/METAWEB_SURF_TOOL_ALLOWLIST = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(match, 'MetaWeb surf allowlist exists');
  const allowlist = match[1];
  assert.match(allowlist, /\.\.\.METAWEB_QA_SURF_TOOL_ALLOWLIST/);
  // The full surf surface: social reads, generic reader, the narrow comment
  // tool, persona-driven publishing, and conservative agentpedia challenges.
  for (const expected of [
    "'search_social_posts'",
    "'social_post_detail'",
    "'social_post_comments'",
    "'omni_read'",
    "'comment_pin'",
    "'post_simplequestion'",
    "'post_buzz'",
    "'post_simplenote'",
    "'agentpedia_challenge'",
  ]) {
    assert.ok(allowlist.includes(expected), `surf allowlist contains ${expected}`);
  }
  // Absence beats deny: no arbitrary protocol writes, no wallet, no uploads.
  assert.doesNotMatch(allowlist, /omni_cast/);
  assert.doesNotMatch(allowlist, /wallet_/);
  assert.doesNotMatch(allowlist, /upload_file/);
  // Surf sessions never see the surf triggers (no nested surfing).
  assert.doesNotMatch(allowlist, /metaweb_surf_start/);
});

test('main.ts passes the job kind into the study session', () => {
  const mainSource = require('node:fs')
    .readFileSync(new URL('../dist-electron/main/main.js', import.meta.url), 'utf8');
  assert.match(mainSource, /metawebStudySession:\s*\{\s*pinBudget:\s*job\.budgetPins,\s*kind:\s*job\.kind\s*\}/);
});

test('main.ts wires the surf session budgets from the briefing', () => {
  const mainSource = require('node:fs')
    .readFileSync(new URL('../dist-electron/main/main.js', import.meta.url), 'utf8');
  // The write-state object doubles as the guard's receipt record (item 6),
  // so the marker is the hoisted variable, not an inline literal.
  assert.match(mainSource, /interactionBudget:\s*context\.briefing\.interactionBudget/);
  assert.match(mainSource, /metawebSurfSession:\s*writeState/);
});
