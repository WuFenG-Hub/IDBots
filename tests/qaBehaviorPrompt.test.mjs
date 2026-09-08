import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { QA_BEHAVIOR_RULE } = require('../dist-electron/main/libs/qaBehaviorPrompt.js');
const {
  composePromptSections,
  PROMPT_SECTION_ORDER,
} = require('../dist-electron/main/libs/promptComposer.js');
const {
  buildGroupTaskSystemPrompt,
} = require('../dist-electron/main/services/groupTaskPrompts.js');

const METABOT = {
  id: 1, name: 'Twin Bot', bio: 'Coordinates the team', goal: 'Ship group tasks',
  globalmetaid: 'gmid-twin', metaid: 'metaid-1', llm_id: 'llm-1',
};
const TASK = { title: 'T', goal: 'G', acceptanceCriteria: 'A' };
const MEMBERS = [
  { metabotId: 1, name: 'Twin Bot', role: 'chair', globalMetaId: 'gmid-twin' },
  { metabotId: 2, name: 'Coder Bot', role: 'worker', globalMetaId: 'gmid-w2' },
];

test('the rule carries the full search-before-ask loop with every live tool', () => {
  assert.match(QA_BEHAVIOR_RULE, /search first, ask when stuck, answer what you know/i);
  assert.match(QA_BEHAVIOR_RULE, /Search BEFORE asking/);
  assert.match(QA_BEHAVIOR_RULE, /search_qa/);
  assert.match(QA_BEHAVIOR_RULE, /read_metaweb_pin/);
  assert.match(QA_BEHAVIOR_RULE, /list_latest_questions/);
  assert.match(QA_BEHAVIOR_RULE, /max_answers=0/);
  assert.match(QA_BEHAVIOR_RULE, /get_question_answers/);
  assert.match(QA_BEHAVIOR_RULE, /post_simplequestion/);
  assert.match(QA_BEHAVIOR_RULE, /\/protocols\/simplequestion/);
  assert.match(QA_BEHAVIOR_RULE, /post_simpleanswer/);
  assert.match(QA_BEHAVIOR_RULE, /\/protocols\/simpleanswer/);
  assert.match(QA_BEHAVIOR_RULE, /like_pin/);
  assert.match(QA_BEHAVIOR_RULE, /only required field/);
  assert.match(QA_BEHAVIOR_RULE, /ending in a question mark \(`\?` or full-width `？`\)/);
  assert.match(QA_BEHAVIOR_RULE, /never re-ask what a search already answered/);
});

test('group task prompts (chair and worker, plain path) carry the QA rule', () => {
  for (const botRole of ['chair', 'worker']) {
    const prompt = buildGroupTaskSystemPrompt({
      metabot: METABOT, task: TASK, members: MEMBERS, botRole,
    });
    assert.ok(prompt.includes(QA_BEHAVIOR_RULE), `${botRole} prompt carries the QA rule`);
    // The chain-identifier rule stays alongside it.
    assert.match(prompt, /Chain identifiers are load-bearing/);
  }
});

test('METAWEB_QA_BEHAVIOR slot sorts between the learning loop and MetaApps blocks', () => {
  const prompt = composePromptSections([
    { name: 'idbots:metaweb-worldview', order: PROMPT_SECTION_ORDER.METAWEB_WORLDVIEW, text: 'WORLDVIEW' },
    { name: 'idbots:metaweb-learning-loop', order: PROMPT_SECTION_ORDER.METAWEB_LEARNING_LOOP, text: 'LEARNING_LOOP' },
    { name: 'idbots:metaweb-qa-behavior', order: PROMPT_SECTION_ORDER.METAWEB_QA_BEHAVIOR, text: QA_BEHAVIOR_RULE },
    { name: 'idbots:metaapps', order: PROMPT_SECTION_ORDER.METAAPPS, text: 'METAAPPS' },
  ]);
  const worldviewAt = prompt.indexOf('WORLDVIEW');
  const loopAt = prompt.indexOf('LEARNING_LOOP');
  const ruleAt = prompt.indexOf('MetaWeb Q&A — search first, ask when stuck');
  const metaappsAt = prompt.indexOf('METAAPPS');
  assert.ok(worldviewAt >= 0 && loopAt > worldviewAt && ruleAt > loopAt && metaappsAt > ruleAt,
    'QA behavior renders after the learning loop and before METAAPPS');
});

test('the cowork runner wires the qa-behavior section and worldview routing into its composed prompt', () => {
  const runnerSource = require('node:fs')
    .readFileSync(new URL('../dist-electron/main/libs/coworkRunner.js', import.meta.url), 'utf8');
  assert.match(runnerSource, /idbots:metaweb-qa-behavior/);
  assert.match(runnerSource, /QA_BEHAVIOR_RULE/);
  // The worldview's protocol-routing paragraph mentions both Q&A protocols.
  assert.match(runnerSource, /post_simplequestion \(\/protocols\/simplequestion\)/);
  assert.match(runnerSource, /post_simpleanswer \(\/protocols\/simpleanswer\)/);
});
