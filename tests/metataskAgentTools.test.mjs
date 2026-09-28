import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildMetataskAgentTools } = require('../dist-electron/main/libs/metataskAgentTools.js');
const { replayMetaTask } = require('../dist-electron/main/services/metatask/engine.js');
const { innerHash, outerHash } = require('../dist-electron/main/services/metatask/canon.js');
const { rosterPinsFromEvents } = require('../dist-electron/main/services/metatask/collector.js');

/**
 * MetaTask agent tools (P2): writer-side protocol discipline before any chain
 * spend — claim guard refusals, #8/#9 vote gates, same-side review blocking,
 * submission hash assembly per the frozen canon, publish invariants and the
 * tree→spec→task ordering, amend publisher authority.
 */

const SESSION_BOT = 'idq1localAA0000000000000000000000000';
const LOCAL_PEER = 'idq1localBB0000000000000000000000000';
const FOREIGN_SUBMITTER = 'idq1foreigncc00000000000000000000';
const FOREIGN_PUBLISHER = 'idq1publisherx0000000000000000000';

let pinCounter = 0;
const nextPinId = () => `pin${String(++pinCounter).padStart(4, '0')}0i0`;

const ev = (path, body, over = {}) => ({
  pinId: over.pinId ?? nextPinId(),
  path,
  author: over.author ?? SESSION_BOT,
  height: over.height ?? 189_900,
  txIndex: over.txIndex ?? 0,
  timestampMs: over.timestampMs ?? 1_790_000_000_000,
  body,
});

/** A task published by FOREIGN_PUBLISHER: t1 open, t2 claimed by FOREIGN_SUBMITTER. */
const buildForeignTask = () => {
  const treePinId = nextPinId();
  const rootPinId = nextPinId();
  const tree = ev(
    'tree',
    {
      root: 'r1',
      nodes: [
        { id: 'r1', parent: null, title: 'root', kind: 'aggregate', specid: null, params: {}, deps: [], weight: 3000 },
        { id: 't1', parent: 'r1', title: 'open leaf', kind: 'proof', specid: null, params: {}, deps: [], weight: 7000 },
      ],
    },
    { pinId: treePinId, author: FOREIGN_PUBLISHER, height: 189_800 },
  );
  const task = ev(
    'task',
    {
      title: 'agent tools fixture',
      treeid: treePinId,
      // ttl/window 0 = no expiry derivation, so the fixture clock never reopens holders
      policy: { verify_quorum: 2, claim_ttl_hours: 0, verify_window_hours: 0 },
      tags: [],
    },
    { pinId: rootPinId, author: FOREIGN_PUBLISHER, height: 189_801 },
  );
  return { events: [tree, task], treePinId, rootPinId };
};

const buildHarness = (initialEvents) => {
  const state = { events: [...initialEvents] };
  const writes = [];
  const createPin = async (metabotId, metaidData, options) => {
    const pinId = nextPinId();
    writes.push({ metabotId, metaidData, options, pinId });
    return { pinId, txids: [`tx${writes.length}`], totalCost: 0 };
  };
  const refresher = {
    board: () => null,
    detail: (rootPinId) => {
      try {
        // Mirrors the refresher: roster pins travel with the event set.
        return replayMetaTask(state.events, {
          rootPinId,
          now: 1_790_050_000_000,
          rosterPins: rosterPinsFromEvents(state.events),
        });
      } catch {
        return null;
      }
    },
    refreshOnce: async () => {
      // fold new writes back into the local event pool, as a chain sweep would
      for (const write of writes) {
        if (write.folded) continue;
        write.folded = true;
        state.events.push(
          ev(
            String(write.metaidData.path ?? '').split('/').pop(),
            JSON.parse(write.metaidData.payload),
            { author: SESSION_BOT, height: 190_100 + state.events.length, pinId: write.pinId },
          ),
        );
      }
      return { ok: true, error: null };
    },
    loadEvents: () => state.events,
  };
  const handlers = {};
  const tool = (name, _description, _schema, handler) => {
    handlers[name] = handler;
    return { name };
  };
  buildMetataskAgentTools({
    tool,
    control: {
      refresher: () => refresher,
      localRosterMetaIds: () => [SESSION_BOT, LOCAL_PEER],
      resolveGlobalMetaId: (metabotId) => (metabotId === 1 ? SESSION_BOT : null),
    },
    createPin,
    sessionId: 'session-1',
    resolveMetabotId: () => 1,
  });
  return { handlers, writes, state };
};

test('metatask_claim: guard refuses a claimed node without spending; open node publishes', async () => {
  const { events, rootPinId } = buildForeignTask();
  const claim = ev('claim', { taskid: rootPinId, node: 'r1' }, { author: FOREIGN_SUBMITTER, height: 189_910 });
  const { handlers, writes } = buildHarness([...events, claim]);

  const refused = await handlers.metatask_claim({ rootPinId, node: 'r1' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /claim-rejected:r1:claimed/);
  assert.equal(writes.length, 0, 'a refused guard must never reach the chain');

  const allowed = await handlers.metatask_claim({ rootPinId, node: 't1' });
  assert.equal(allowed.isError, undefined);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].metaidData.path, '/protocols/metatask/claim');
  assert.deepEqual(JSON.parse(writes[0].metaidData.payload), { taskid: rootPinId, node: 't1' });
});

test('metatask_claim: unknown node refused', async () => {
  const { events, rootPinId } = buildForeignTask();
  const { handlers, writes } = buildHarness(events);
  const refused = await handlers.metatask_claim({ rootPinId, node: 'nope' });
  assert.equal(refused.isError, true);
  assert.equal(writes.length, 0);
});

test('metatask_submit: hash assembly per frozen canon; foreign claim refused; wrong claimPin refused', async () => {
  const { events, rootPinId } = buildForeignTask();
  // Session bot holds t1.
  const claim = ev('claim', { taskid: rootPinId, node: 't1' }, { author: SESSION_BOT, height: 189_910, pinId: 'claim0000001i0' });
  // Foreign bot holds r1 (submit on it must be refused).
  const foreignClaim = ev('claim', { taskid: rootPinId, node: 'r1' }, { author: FOREIGN_SUBMITTER, height: 189_911 });
  const { handlers, writes } = buildHarness([...events, claim, foreignClaim]);

  const foreign = await handlers.metatask_submit({
    rootPinId,
    node: 'r1',
    claimPinId: foreignClaim.pinId,
    result: { type: 'triage', ok: true },
  });
  assert.equal(foreign.isError, true);
  assert.match(foreign.content[0].text, /different bot/);

  const stale = await handlers.metatask_submit({
    rootPinId,
    node: 't1',
    claimPinId: 'nottheclaim00000000000000000000000i0',
    result: { type: 'triage' },
  });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /claim-rejected:t1/);

  const resultInput = { type: 'triage', verdict_text: '判定通过', rows: [1, 2, 3] };
  const ok = await handlers.metatask_submit({
    rootPinId,
    node: 't1',
    claimPinId: 'claim0000001i0',
    result: resultInput,
  });
  assert.equal(ok.isError, undefined);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].metaidData.path, '/protocols/metatask/submission');
  const payload = JSON.parse(writes[0].metaidData.payload);
  assert.equal(payload.claimid, 'claim0000001i0');
  // result.hash is the inner hash over the result minus hash; payload.hash is the outer.
  const { hash: _drop, ...core } = payload.result;
  assert.equal(payload.result.hash, innerHash(resultInput));
  assert.equal(payload.hash, outerHash({ ...resultInput, hash: innerHash(resultInput) }));
  assert.equal(payload.childids.length, 0);
});

test('metatask_verify: #9/#8 write gates and same-side blocking before any spend', async () => {
  const { events, rootPinId } = buildForeignTask();
  const claim = ev('claim', { taskid: rootPinId, node: 't1' }, { author: FOREIGN_SUBMITTER, height: 189_910 });
  const sub = ev(
    'submission',
    {
      taskid: rootPinId,
      node: 't1',
      claimid: claim.pinId,
      result: { type: 'triage' },
      hash: '2'.repeat(64),
      contentType: 'application/json;utf-8',
      attachment: null,
      childids: [],
    },
    { author: FOREIGN_SUBMITTER, height: 189_920 },
  );
  // Same-side target: a submission by a LOCAL bot.
  const localClaim = ev('claim', { taskid: rootPinId, node: 'r1' }, { author: LOCAL_PEER, height: 189_915 });
  const localSub = ev(
    'submission',
    {
      taskid: rootPinId,
      node: 'r1',
      claimid: localClaim.pinId,
      result: { type: 'triage' },
      hash: '3'.repeat(64),
      contentType: 'application/json;utf-8',
      attachment: null,
      childids: [],
    },
    { author: LOCAL_PEER, height: 189_925 },
  );
  const { handlers, writes } = buildHarness([...events, claim, sub, localClaim, localSub]);

  const noSemantic = await handlers.metatask_verify({
    targetPinId: sub.pinId,
    verdict: 'pass',
    method: 'spec rerun pass',
    semanticCheck: '  ',
  });
  assert.equal(noSemantic.isError, true);
  assert.match(noSemantic.content[0].text, /semantic_check/);

  const noFailReason = await handlers.metatask_verify({
    targetPinId: sub.pinId,
    verdict: 'fail',
    method: 'spec rerun fail',
    semanticCheck: 'checked statement',
  });
  assert.equal(noFailReason.isError, true);
  assert.match(noFailReason.content[0].text, /failReason/);

  const sameSide = await handlers.metatask_verify({
    targetPinId: localSub.pinId,
    verdict: 'pass',
    method: 'spec rerun pass',
    semanticCheck: 'checked',
  });
  assert.equal(sameSide.isError, true);
  assert.match(sameSide.content[0].text, /same_side_roster/);

  assert.equal(writes.length, 0, 'all gate refusals must happen before any chain spend');

  const pass = await handlers.metatask_verify({
    targetPinId: sub.pinId,
    verdict: 'pass',
    method: 'spec rerun pass; inner+outer hash match',
    semanticCheck: 'statement matches the node spec; definitions aligned',
  });
  assert.equal(pass.isError, undefined);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].metaidData.path, '/protocols/metatask/verify');
  const payload = JSON.parse(writes[0].metaidData.payload);
  assert.equal(payload.targetid, sub.pinId);
  assert.equal(payload.semantic_check, 'statement matches the node spec; definitions aligned');
  assert.equal(payload.failreason, undefined);
});

test('metatask_publish: invariants checked before the first pin; roster→tree→spec→task order', async () => {
  const { handlers, writes } = buildHarness([]);

  const badWeights = await handlers.metatask_publish({
    title: 'bad',
    nodes: [
      { id: 'r1', parent: null, title: 'root', kind: 'aggregate', weight: 4000 },
      { id: 't1', parent: 'r1', title: 'leaf', kind: 'proof', weight: 5000 },
    ],
    spec: { name: 'check', lang: 'bash', entry: 'check.sh' },
    policy: { claimTtlHours: 48, verifyQuorum: 2, verifyWindowHours: 72 },
  });
  assert.equal(badWeights.isError, true);
  assert.match(badWeights.content[0].text, /10000/);
  assert.equal(writes.length, 0, 'invariant failures must not spend');

  const ok = await handlers.metatask_publish({
    title: 'formalize JSP-000035',
    brief: 'Lean formalization with machine-checked specs',
    nodes: [
      { id: 'r1', parent: null, title: 'root', kind: 'aggregate', weight: 2000 },
      { id: 't1', parent: 'r1', title: 'main theorem', kind: 'formalize', weight: 6000 },
      { id: 't2', parent: 'r1', title: 'lemma ladder', kind: 'formalize', weight: 2000 },
    ],
    spec: { name: 'lean-build-check', lang: 'bash', entry: 'check.sh', script: 'lake build' },
    policy: { claimTtlHours: 48, verifyQuorum: 2, verifyWindowHours: 72, submitterShareBP: 8000 },
    tags: ['metatask', 'jsp'],
  });
  assert.equal(ok.isError, undefined);
  const paths = writes.map((write) => write.metaidData.path);
  // Local roster has 2 bots → roster pin first, then tree → spec → task.
  assert.deepEqual(paths, ['/protocols/metatask-roster', '/protocols/metatask/tree', '/protocols/metatask/spec', '/protocols/metatask/task']);
  const treePayload = JSON.parse(writes[1].metaidData.payload);
  const specPayload = JSON.parse(writes[2].metaidData.payload);
  const taskPayload = JSON.parse(writes[3].metaidData.payload);
  assert.equal(taskPayload.treeid, writes[1].pinId);
  assert.equal(taskPayload.specid, writes[2].pinId);
  assert.equal(treePayload.root, 'r1');
  assert.equal(treePayload.nodes.length, 3);
  assert.equal(taskPayload.policy.split.submitterShareBP, 8000);
  assert.equal(taskPayload.policy.split.rosterid, writes[0].pinId);
  // The root spec goes through the SAME payload builder as metatask_publish_spec.
  assert.deepEqual(Object.keys(specPayload), ['name', 'lang', 'entry', 'script', 'input', 'output']);
  assert.equal(specPayload.name, 'lean-build-check');
  assert.equal(specPayload.lang, 'bash');
  assert.equal(specPayload.entry, 'check.sh');
  assert.equal(specPayload.script, 'lake build');
  assert.equal(specPayload.input, '');
  assert.equal(specPayload.output, '');
  assert.equal(specPayload.validation, undefined);
  assert.match(ok.content[0].text, /discovery buzz/i);
});

test('metatask_amend: publisher-only; bases from the current tree head', async () => {
  // A task PUBLISHED by the session bot's side.
  const treePinId = nextPinId();
  const rootPinId = nextPinId();
  const tree = ev(
    'tree',
    {
      root: 'r1',
      nodes: [
        { id: 'r1', parent: null, title: 'root', kind: 'aggregate', specid: null, params: {}, deps: [], weight: 5000 },
        { id: 't1', parent: 'r1', title: 'leaf', kind: 'proof', specid: null, params: {}, deps: [], weight: 5000 },
      ],
    },
    { pinId: treePinId, author: SESSION_BOT, height: 189_800 },
  );
  const task = ev(
    'task',
    { title: 'mine', treeid: treePinId, policy: { verify_quorum: 2, claim_ttl_hours: 0, verify_window_hours: 0 }, tags: [] },
    { pinId: rootPinId, author: SESSION_BOT, height: 189_801 },
  );
  // A claim by a foreign bot freezes t1 against reweight.
  const foreignClaim = ev('claim', { taskid: rootPinId, node: 't1' }, { author: FOREIGN_SUBMITTER, height: 189_910 });
  const { handlers, writes } = buildHarness([tree, task, foreignClaim]);

  const frozen = await handlers.metatask_amend({
    rootPinId,
    ops: [{ op: 'reweight', node: 't1', weight: 4000 }],
  });
  assert.equal(frozen.isError, true);
  assert.match(frozen.content[0].text, /frozen-on-start/);
  assert.equal(writes.length, 0);

  const ok = await handlers.metatask_amend({
    rootPinId,
    ops: [
      { op: 'add_node', node: { id: 't2', parent: 'r1', title: 'added', kind: 'proof', weight: 1000 } },
      { op: 'reweight', node: 'r1', weight: 4000 },
    ],
  });
  assert.equal(ok.isError, undefined, `expected success, got: ${ok.content?.[0]?.text}`);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].metaidData.path, '/protocols/metatask/amend');
  const payload = JSON.parse(writes[0].metaidData.payload);
  assert.equal(payload.bases, treePinId);
  assert.equal(payload.taskid, rootPinId);
});

// ── publisher self-claim refusal (protocol §12 item 6) ───────────────────────

test('metatask_claim: the task root author is refused its own task before any spend', async () => {
  const treePinId = nextPinId();
  const rootPinId = nextPinId();
  const tree = ev(
    'tree',
    {
      root: 'r1',
      nodes: [
        { id: 'r1', parent: null, title: 'root', kind: 'aggregate', specid: null, params: {}, deps: [], weight: 5000 },
        { id: 't1', parent: 'r1', title: 'leaf', kind: 'proof', specid: null, params: {}, deps: [], weight: 5000 },
      ],
    },
    { pinId: treePinId, height: 189_800 },
  );
  // Authored by the SESSION bot: it is the task root author (publisher).
  const task = ev(
    'task',
    { title: 'published by me', treeid: treePinId, policy: { verify_quorum: 2, claim_ttl_hours: 0, verify_window_hours: 0 }, tags: [] },
    { pinId: rootPinId, height: 189_801 },
  );
  const { handlers, writes } = buildHarness([tree, task]);

  const refused = await handlers.metatask_claim({ rootPinId, node: 't1' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /§12 item 6/);
  assert.match(refused.content[0].text, /submitter != task root author/);
  assert.equal(writes.length, 0, 'the publisher must never spend a claim fee on its own task');
});

// ── same-side roster wiring (collected roster pins reach the engine) ─────────

test('metatask_claim/replay: collected roster pins filter same-side votes (guard sees it)', async () => {
  const rosterPinId = nextPinId();
  const treePinId = nextPinId();
  const rootPinId = nextPinId();
  const roster = ev(
    'metatask-roster',
    { groups: [[SESSION_BOT, LOCAL_PEER]], owner: 'idbots-local-roster', createdAt: 1_790_000_000_000 },
    { pinId: rosterPinId, author: FOREIGN_PUBLISHER, height: 191_490 },
  );
  const tree = ev(
    'tree',
    {
      root: 'r1',
      nodes: [
        { id: 'r1', parent: null, title: 'root', kind: 'aggregate', specid: null, params: {}, deps: [], weight: 3000 },
        { id: 't1', parent: 'r1', title: 'leaf', kind: 'proof', specid: null, params: {}, deps: [], weight: 7000 },
      ],
    },
    { pinId: treePinId, author: FOREIGN_PUBLISHER, height: 191_491 },
  );
  // The task points at the roster pin through its split policy.
  const task = ev(
    'task',
    {
      title: 'roster task',
      treeid: treePinId,
      policy: {
        verify_quorum: 2,
        claim_ttl_hours: 0,
        verify_window_hours: 0,
        split: { submitterShareBP: 8000, rosterid: rosterPinId },
      },
      tags: [],
    },
    { pinId: rootPinId, author: FOREIGN_PUBLISHER, height: 191_492 },
  );
  const claim = ev('claim', { taskid: rootPinId, node: 't1' }, { author: SESSION_BOT, height: 191_500 });
  const sub = ev(
    'submission',
    {
      taskid: rootPinId,
      node: 't1',
      claimid: claim.pinId,
      result: { type: 'triage' },
      hash: '4'.repeat(64),
      contentType: 'application/json;utf-8',
      attachment: null,
      childids: [],
    },
    { author: SESSION_BOT, height: 191_501 },
  );
  const vote = (author, over) =>
    ev(
      'verify',
      { targetid: sub.pinId, verdict: 'pass', method: 'replay pass', semantic_check: 'checked' },
      { author, ...over },
    );
  const independent = vote('idq1foreignreviewer0000000000000', { height: 191_502 });
  // Same-side (LOCAL_PEER shares a roster group with the submitter): if the
  // roster pin were NOT fed to the engine, this fail would reopen the node.
  const sameSideFail = ev(
    'verify',
    { targetid: sub.pinId, verdict: 'fail', method: 'replay fail', semantic_check: 'checked', failreason: 'counterexample' },
    { author: LOCAL_PEER, height: 191_503 },
  );
  const { handlers, writes } = buildHarness([roster, tree, task, claim, sub, independent, sameSideFail]);

  const replay = await handlers.metatask_replay({ rootPinId });
  assert.equal(replay.isError, undefined);
  const replayed = JSON.parse(replay.content[0].text);
  assert.equal(replayed.nodeStates.t1.status, 'claimed');
  assert.ok(
    replayed.ignoredEvents.some(
      (entry) => entry.pinId === sameSideFail.pinId && entry.reason === 'same_side_roster',
    ),
    `expected same_side_roster for the local peer vote, got ${JSON.stringify(replayed.ignoredEvents)}`,
  );

  // The claim guard replays with the same roster map: t1 is still held, so the
  // claim is refused before any spend.
  const refused = await handlers.metatask_claim({ rootPinId, node: 't1' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /claim-rejected:t1:claimed/);
  assert.equal(writes.length, 0);
});

// ── metatask_publish_spec: standalone spec pins (no carrier task) ────────────

const ARTIFACT_REF = 'metafile://correspondenceartifact000000000000000000000000000000i0';
const SPEC_SCRIPT = '#!/usr/bin/env python3\nimport json, sys\nprint("pass")\n';

/** The wave-1 campaign's validation shape (protocol §3, all three items). */
const buildValidation = (correspondence = ARTIFACT_REF, over = {}) => ({
  null_tolerance: true,
  enumeration_closure: { closure: '2^n + 2^i + 2^j, 0<=j<i<=n-1', selfcheck_n: 8, expected_count: 28 },
  proposition_fidelity: {
    correspondence,
    artifactPin: correspondence,
    coverage: ['statement', 'definitions', 'proof-direction'],
  },
  ...over,
});

const specArgs = (over = {}) => ({
  name: 'witness-extraction-301',
  lang: 'python3',
  entry: 'spec-witness-extraction.py',
  script: SPEC_SCRIPT,
  input: { repo: 'metafile://repo-artifact' },
  output: { verdict: 'pass|fail|invalid' },
  validation: buildValidation(),
  ...over,
});

test('metatask_publish_spec: exactly one spec pin, no carrier task, protocol payload', async () => {
  const { handlers, writes } = buildHarness([]);
  // Registered alongside the other metatask_* tools.
  assert.equal(typeof handlers.metatask_publish_spec, 'function');
  const result = await handlers.metatask_publish_spec(specArgs());
  assert.equal(result.isError, undefined, result.content?.[0]?.text);

  assert.equal(writes.length, 1, 'a standalone spec publish spends one pin and creates no task/tree');
  const [write] = writes;
  assert.equal(write.metaidData.path, '/protocols/metatask/spec');
  assert.equal(write.metaidData.contentType, 'application/json');
  assert.equal(write.metaidData.version, '1.1.0');
  assert.equal(write.metaidData.encryption, '0');
  assert.equal(write.options.origin, 'tool:metatask_publish_spec');

  const payload = JSON.parse(write.metaidData.payload);
  assert.deepEqual(Object.keys(payload), ['name', 'lang', 'entry', 'script', 'input', 'output', 'validation']);
  assert.equal(payload.name, 'witness-extraction-301');
  assert.equal(payload.lang, 'python3');
  assert.equal(payload.entry, 'spec-witness-extraction.py');
  assert.equal(payload.script, SPEC_SCRIPT);
  assert.deepEqual(payload.input, { repo: 'metafile://repo-artifact' });
  assert.deepEqual(payload.output, { verdict: 'pass|fail|invalid' });
  assert.deepEqual(payload.validation, buildValidation());

  const out = JSON.parse(result.content[0].text);
  assert.equal(out.specPinId, write.pinId);
  assert.deepEqual(out.txids, ['tx1']);
  assert.equal(out.totalCost, 0);
  assert.equal(out.hasValidation, true);
  assert.match(out.note, /specid/);
  assert.equal(write.folded, true, 'the write is followed by a projection refresh');
});

test('metatask_publish_spec: validation block enforced before any spend', async () => {
  const { handlers, writes } = buildHarness([]);

  const noValidation = await handlers.metatask_publish_spec(specArgs({ validation: undefined }));
  assert.equal(noValidation.isError, true);
  assert.match(noValidation.content[0].text, /spec\.validation is required/);

  const missingItem = await handlers.metatask_publish_spec(
    specArgs({ validation: { null_tolerance: true, enumeration_closure: { closure: 'x', expected_count: 1 } } }),
  );
  assert.equal(missingItem.isError, true);
  assert.match(missingItem.content[0].text, /proposition_fidelity/);

  const placeholder = await handlers.metatask_publish_spec(
    specArgs({ validation: buildValidation('PUBLISH_ARTIFACT_FIRST') }),
  );
  assert.equal(placeholder.isError, true);
  assert.match(placeholder.content[0].text, /placeholder/i);
  assert.match(placeholder.content[0].text, /PUBLISH_ARTIFACT_FIRST/);

  const notAPin = await handlers.metatask_publish_spec(
    specArgs({ validation: buildValidation('https://example.com/correspondence.md') }),
  );
  assert.equal(notAPin.isError, true);
  assert.match(notAPin.content[0].text, /pin:\/\/ \| metafile:\/\//);

  const selfAttested = await handlers.metatask_publish_spec(
    specArgs({
      validation: buildValidation(ARTIFACT_REF, {
        proposition_fidelity: { statement: true, definitions: true, proof_direction: true },
      }),
    }),
  );
  assert.equal(selfAttested.isError, true);
  assert.match(selfAttested.content[0].text, /self-attested boolean/);

  const closureWithoutCount = await handlers.metatask_publish_spec(
    specArgs({
      validation: buildValidation(ARTIFACT_REF, {
        enumeration_closure: { closure: '2^n + 2^i' },
      }),
    }),
  );
  assert.equal(closureWithoutCount.isError, true);
  assert.match(closureWithoutCount.content[0].text, /integer self-check count/);

  const emptyScript = await handlers.metatask_publish_spec(specArgs({ script: '   ' }));
  assert.equal(emptyScript.isError, true);
  assert.match(emptyScript.content[0].text, /verifier script/);

  assert.equal(writes.length, 0, 'every gate refusal must happen before any chain spend');

  const ok = await handlers.metatask_publish_spec(specArgs());
  assert.equal(ok.isError, undefined);
  assert.equal(writes.length, 1);
});

test('metatask_publish_spec: pin:// script reference, campaign artifactPin shape, pre-H_ACT2 opt-out', async () => {
  const { handlers, writes } = buildHarness([]);

  const referenceScript = await handlers.metatask_publish_spec(
    specArgs({ script: '  pin://scriptpin000000000000000000000000000000000000000000000000000i0  ' }),
  );
  assert.equal(referenceScript.isError, undefined, referenceScript.content?.[0]?.text);
  const referenced = JSON.parse(writes[0].metaidData.payload);
  assert.equal(referenced.script, 'pin://scriptpin000000000000000000000000000000000000000000000000000i0');
  assert.equal(referenced.input.repo, 'metafile://repo-artifact');

  // The protocol's `correspondence` field alone is enough (no artifactPin).
  const correspondenceOnly = await handlers.metatask_publish_spec(
    specArgs({
      validation: buildValidation(ARTIFACT_REF, {
        proposition_fidelity: { correspondence: ARTIFACT_REF },
      }),
    }),
  );
  assert.equal(correspondenceOnly.isError, undefined, correspondenceOnly.content?.[0]?.text);

  // A single-line non-protocol URI is refused instead of being published as
  // "inline text" (protocol §3 allows inline text or a pin://|metafile:// ref).
  const httpsOnly = await handlers.metatask_publish_spec(specArgs({ script: 'https://example.com/verifier.py' }));
  assert.equal(httpsOnly.isError, true);
  assert.match(httpsOnly.content[0].text, /not pin:\/\/ or metafile:\/\//);

  // Pre-H_ACT2 (v1.1-era) specs: explicit opt-out, no validation block written.
  const legacy = await handlers.metatask_publish_spec({
    name: 'legacy-verifier',
    lang: 'bash',
    entry: 'check.sh',
    script: 'echo pass',
    enforceHAct2Validation: false,
  });
  assert.equal(legacy.isError, undefined, legacy.content?.[0]?.text);
  const legacyPayload = JSON.parse(writes[writes.length - 1].metaidData.payload);
  assert.equal(legacyPayload.validation, undefined);
  assert.equal(legacyPayload.input, '');
  assert.equal(legacyPayload.output, '');
  assert.equal(legacyPayload.lang, 'bash');
});
