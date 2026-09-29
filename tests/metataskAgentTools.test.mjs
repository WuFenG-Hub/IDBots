import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

const buildHarness = (initialEvents, over = {}) => {
  const state = { events: [...initialEvents] };
  const writes = [];
  const createPin = async (metabotId, metaidData, options) => {
    const pinId = nextPinId();
    writes.push({ metabotId, metaidData, options, pinId });
    return { pinId, txids: [`tx${writes.length}`], totalCost: 0 };
  };
  const refresher = {
    // A synthetic board lets read tools be tested without a projection store.
    board: () => over.board ?? null,
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

// ── mid-task estimates surfaced by the read tools ────────────────────────────

test('metatask_get: estimation block for an in-progress task, null once settled', async () => {
  const reviewerA = 'idq1foreignrevieweraaa';
  const reviewerB = 'idq1foreignreviewerbbb';
  const { events, rootPinId } = buildForeignTask(); // r1:3000 aggregate, t1:7000 leaf, quorum 2
  const claimT1 = ev('claim', { taskid: rootPinId, node: 't1' }, { author: FOREIGN_SUBMITTER, height: 189_910 });
  const subT1 = ev(
    'submission',
    {
      taskid: rootPinId,
      node: 't1',
      claimid: claimT1.pinId,
      result: { type: 'triage' },
      hash: '7'.repeat(64),
      contentType: 'application/json;utf-8',
      attachment: null,
      childids: [],
    },
    { author: FOREIGN_SUBMITTER, height: 189_920 },
  );
  const passOnT1 = (author, height) =>
    ev(
      'verify',
      { targetid: subT1.pinId, verdict: 'pass', method: 'replay pass', semantic_check: 'checked' },
      { author, height },
    );
  const midTaskEvents = [...events, claimT1, subT1, passOnT1(reviewerA, 189_930), passOnT1(reviewerB, 189_931)];

  const midTask = buildHarness(midTaskEvents);
  const midRead = await midTask.handlers.metatask_get({ rootPinId });
  assert.equal(midRead.isError, undefined, midRead.content?.[0]?.text);
  const midDetail = JSON.parse(midRead.content[0].text);
  assert.equal(midDetail.settlement, null);
  assert.equal(midDetail.estimation.basis, 'weighted');
  // t1 (7000bp) is the only verified node: submitter 5600, pool 1400 split
  // equally between two reviewers with identical (1/1) accuracy histories.
  assert.deepEqual(midDetail.estimation.shares, [
    { metaId: FOREIGN_SUBMITTER, shareBP: 5600, from: { submittedBP: 5600, reviewedBP: 0 } },
    { metaId: reviewerA, shareBP: 700, from: { submittedBP: 0, reviewedBP: 700 } },
    { metaId: reviewerB, shareBP: 700, from: { submittedBP: 0, reviewedBP: 700 } },
  ]);
  assert.equal(midDetail.progress.verified, 1);

  // Complete the task (root verified too): a manifest now exists and the
  // estimate must not be surfaced alongside it.
  const claimR1 = ev('claim', { taskid: rootPinId, node: 'r1' }, { author: FOREIGN_SUBMITTER, height: 189_940 });
  const subR1 = ev(
    'submission',
    {
      taskid: rootPinId,
      node: 'r1',
      claimid: claimR1.pinId,
      result: { type: 'aggregate' },
      hash: '8'.repeat(64),
      contentType: 'application/json;utf-8',
      attachment: null,
      childids: [],
    },
    { author: FOREIGN_SUBMITTER, height: 189_941 },
  );
  const settled = buildHarness([
    ...midTaskEvents,
    claimR1,
    subR1,
    ev('verify', { targetid: subR1.pinId, verdict: 'pass', method: 'replay pass', semantic_check: 'checked' }, { author: reviewerA, height: 189_950 }),
    ev('verify', { targetid: subR1.pinId, verdict: 'pass', method: 'replay pass', semantic_check: 'checked' }, { author: reviewerB, height: 189_951 }),
  ]);
  const settledRead = await settled.handlers.metatask_get({ rootPinId });
  const settledDetail = JSON.parse(settledRead.content[0].text);
  assert.ok(settledDetail.settlement, 'the completed task settles');
  assert.equal(settledDetail.estimation, null, 'settlement.shares is the truth once a manifest exists');
  assert.equal(settledDetail.settlement.shares.reduce((sum, share) => sum + share.shareBP, 0), 10000);
});

test('metatask_list: per-task myStats carries estShareBP', async () => {
  const board = {
    refresh: { lastRefreshAtMs: 1, lastOkAtMs: 1, lastError: null, boundaryBlock: 189_931, refreshing: false },
    alerts: [],
    tasks: [
      {
        rootPinId: 'task0000000009i0',
        title: 'mid-task',
        publisher: FOREIGN_PUBLISHER,
        progress: { total: 2, verified: 1, claimed: 0, open: 1, disputed: 0 },
        participantCount: 2,
        myRoles: ['participant'],
        myStats: { claimed: 1, submitted: 1, verified: 1, reviewVotes: 0, shareBP: 0, estShareBP: 4000 },
        settlementFinalized: false,
        freshness: { boundaryBlock: 189_931, evaluatedAtMs: 0, eventCount: 5 },
      },
    ],
  };
  const { handlers } = buildHarness([], { board });
  const listed = await handlers.metatask_list({});
  assert.equal(listed.isError, undefined, listed.content?.[0]?.text);
  const payload = JSON.parse(listed.content[0].text);
  assert.equal(payload.tasks.length, 1);
  assert.deepEqual(payload.tasks[0].myStats, {
    claimed: 1,
    submitted: 1,
    verified: 1,
    reviewVotes: 0,
    shareBP: 0,
    estShareBP: 4000,
  });
  assert.equal(payload.tasks[0].settlementFinalized, false);
});

// ── draftsFile mode: publish machine-validated campaign drafts verbatim ──────
// The wave-1 launch failed because the publishing bot re-typed a ~90KB nested
// validation block by hand, mangled it, and read the resulting refusal as a
// validator disagreement. File mode removes that transcription step entirely.

const DRAFTS_TASK_ID = 'T1-JSP-000301';
const DRAFTS_ROOT_SPEC_KEY = 'powerful-pair-verifier';
const DRAFTS_STANDALONE_SPEC_KEY = 'witness-extraction-301';

/** A whole spec object with all seven protocol fields, in payload key order. */
const fileSpec = (name, entry, over = {}) => ({
  name,
  lang: 'python3',
  entry,
  script: `#!/usr/bin/env python3\nprint("${name} pass")\n`,
  input: { repo: 'metafile://repo-artifact' },
  output: { verdict: 'pass|fail|invalid' },
  validation: buildValidation(),
  ...over,
});

const buildDraftsFixture = () => ({
  specs: {
    [DRAFTS_ROOT_SPEC_KEY]: fileSpec(DRAFTS_ROOT_SPEC_KEY, 'spec-powerful-pair.py'),
    [DRAFTS_STANDALONE_SPEC_KEY]: fileSpec(DRAFTS_STANDALONE_SPEC_KEY, 'spec-witness-extraction.py'),
    'semantic-review-301': fileSpec('semantic-review-301', 'spec-semantic-review.py'),
  },
  tasks: [
    {
      id: DRAFTS_TASK_ID,
      rootSpec: DRAFTS_ROOT_SPEC_KEY,
      correspondenceArtifact: 'correspondence-T1-JSP-000301',
      publish: {
        title: 'formalize JSP-000301 (drafts fixture)',
        brief: 'fixture brief',
        nodes: [
          { id: 'root', parent: null, title: 'aggregate', kind: 'aggregate', specid: null, params: {}, deps: [], weight: 3000 },
          { id: 'witness', parent: 'root', title: 'search', kind: 'search', specid: `SPEC_PIN:${DRAFTS_STANDALONE_SPEC_KEY}`, params: {}, deps: [], weight: 4000 },
          { id: 'review', parent: 'root', title: 'triage', kind: 'triage', specid: 'SPEC_PIN:semantic-review-301', params: {}, deps: [], weight: 3000 },
        ],
        policy: { claimTtlHours: 48, verifyQuorum: 2, verifyWindowHours: 72, submitterShareBP: 8000 },
        tags: ['metatask', 'jsp'],
      },
    },
  ],
});

/** Run `body` with a temp drafts file (never the real 91KB launch kit). */
const withDraftsFile = async (drafts, body) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-metatask-drafts-'));
  const file = path.join(dir, 'wave1-task-drafts.json');
  fs.writeFileSync(file, JSON.stringify(drafts, null, 2), 'utf8');
  try {
    return await body(file, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('metatask_publish_spec: draftsFile+specKey publishes the file spec byte-for-byte', async () => {
  const { handlers, writes } = buildHarness([]);
  await withDraftsFile(buildDraftsFixture(), async (draftsFile) => {
    const result = await handlers.metatask_publish_spec({ draftsFile, specKey: DRAFTS_STANDALONE_SPEC_KEY });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    assert.equal(writes.length, 1, 'one spec pin, no tree/task');
    assert.equal(writes[0].metaidData.path, '/protocols/metatask/spec');
    assert.equal(writes[0].options.origin, 'tool:metatask_publish_spec');

    const expected = buildDraftsFixture().specs[DRAFTS_STANDALONE_SPEC_KEY];
    assert.deepEqual(Object.keys(JSON.parse(writes[0].metaidData.payload)), Object.keys(expected));
    assert.equal(writes[0].metaidData.payload, JSON.stringify(expected), 'payload bytes equal the drafts entry');

    const out = JSON.parse(result.content[0].text);
    assert.equal(out.specPinId, writes[0].pinId);
    assert.equal(out.source, 'draftsFile');
    assert.equal(out.specKey, DRAFTS_STANDALONE_SPEC_KEY);
    assert.equal(out.hasValidation, true);
  });
});

test('metatask_publish_spec: refuse when both modes are supplied, or one half is missing', async () => {
  const { handlers, writes } = buildHarness([]);
  await withDraftsFile(buildDraftsFixture(), async (draftsFile) => {
    const both = await handlers.metatask_publish_spec({
      draftsFile,
      specKey: DRAFTS_STANDALONE_SPEC_KEY,
      name: 'hand-typed-name',
    });
    assert.equal(both.isError, true);
    assert.match(both.content[0].text, /not both/);

    const bothValidationOnly = await handlers.metatask_publish_spec({
      draftsFile,
      specKey: DRAFTS_STANDALONE_SPEC_KEY,
      validation: buildValidation(),
    });
    assert.equal(bothValidationOnly.isError, true);
    assert.match(bothValidationOnly.content[0].text, /not both/);

    const fileOnly = await handlers.metatask_publish_spec({ draftsFile });
    assert.equal(fileOnly.isError, true);
    assert.match(fileOnly.content[0].text, /draftsFile and specKey must be passed together/);

    const keyOnly = await handlers.metatask_publish_spec({ specKey: DRAFTS_STANDALONE_SPEC_KEY });
    assert.equal(keyOnly.isError, true);
    assert.match(keyOnly.content[0].text, /draftsFile and specKey must be passed together/);

    const unknownKey = await handlers.metatask_publish_spec({ draftsFile, specKey: 'nope-301' });
    assert.equal(unknownKey.isError, true);
    assert.match(unknownKey.content[0].text, /specs\["nope-301"\] not found/);
    assert.match(unknownKey.content[0].text, /witness-extraction-301/);

    assert.equal(writes.length, 0, 'every file-mode refusal precedes any spend');
  });
});

test('metatask_publish_spec: unreadable draftsFile or non-object JSON is refused', async () => {
  const { handlers, writes } = buildHarness([]);
  await withDraftsFile(buildDraftsFixture(), async (draftsFile, dir) => {
    const missing = await handlers.metatask_publish_spec({
      draftsFile: path.join(dir, 'missing-file.json'),
      specKey: DRAFTS_STANDALONE_SPEC_KEY,
    });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /cannot read draftsFile/);

    const relative = await handlers.metatask_publish_spec({
      draftsFile: 'scripts/metatask-campaign/wave1-task-drafts.json',
      specKey: DRAFTS_STANDALONE_SPEC_KEY,
    });
    assert.equal(relative.isError, true);
    assert.match(relative.content[0].text, /must be an absolute path/);

    const arrayFile = path.join(dir, 'array.json');
    fs.writeFileSync(arrayFile, '[]', 'utf8');
    const notObject = await handlers.metatask_publish_spec({ draftsFile: arrayFile, specKey: 'x' });
    assert.equal(notObject.isError, true);
    assert.match(notObject.content[0].text, /must contain a JSON object/);

    assert.equal(writes.length, 0);
  });
});

test('metatask_publish: draftsFile+taskId substitutes SPEC_PIN placeholders and refuses unmapped ones', async () => {
  const { handlers, writes } = buildHarness([]);
  await withDraftsFile(buildDraftsFixture(), async (draftsFile) => {
    const unmapped = await handlers.metatask_publish({ draftsFile, taskId: DRAFTS_TASK_ID });
    assert.equal(unmapped.isError, true);
    assert.match(unmapped.content[0].text, /SPEC_PIN:semantic-review-301/);
    assert.match(unmapped.content[0].text, /SPEC_PIN:witness-extraction-301/);
    assert.equal(writes.length, 0, 'no spend with an unresolved placeholder');

    const result = await handlers.metatask_publish({
      draftsFile,
      taskId: DRAFTS_TASK_ID,
      specPinByKey: {
        [DRAFTS_STANDALONE_SPEC_KEY]: 'pin://witnessspec0000000000000000000000000000000000001i0',
      },
    });
    assert.equal(result.isError, true, 'the second placeholder is still unmapped');
    assert.match(result.content[0].text, /SPEC_PIN:semantic-review-301/);
    assert.ok(!/SPEC_PIN:witness-extraction-301/.test(result.content[0].text), 'mapped placeholder is not reported');
    assert.equal(writes.length, 0);

    const ok = await handlers.metatask_publish({
      draftsFile,
      taskId: DRAFTS_TASK_ID,
      specPinByKey: {
        [DRAFTS_STANDALONE_SPEC_KEY]: 'pin://witnessspec0000000000000000000000000000000000001i0',
        'semantic-review-301': 'pin://reviewspec0000000000000000000000000000000000001i0',
      },
    });
    assert.equal(ok.isError, undefined, ok.content?.[0]?.text);
    const paths = writes.map((write) => write.metaidData.path);
    assert.deepEqual(paths, [
      '/protocols/metatask-roster',
      '/protocols/metatask/tree',
      '/protocols/metatask/spec',
      '/protocols/metatask/task',
    ]);
    const treePayload = JSON.parse(writes[1].metaidData.payload);
    assert.equal(treePayload.root, 'root');
    assert.deepEqual(
      treePayload.nodes.map((node) => [node.id, node.specid]),
      [
        ['root', null],
        ['witness', 'pin://witnessspec0000000000000000000000000000000000001i0'],
        ['review', 'pin://reviewspec0000000000000000000000000000000000001i0'],
      ]
    );
    const taskPayload = JSON.parse(writes[3].metaidData.payload);
    assert.equal(taskPayload.title, 'formalize JSP-000301 (drafts fixture)');
    assert.equal(taskPayload.brief, 'fixture brief');
    assert.equal(taskPayload.policy.verify_quorum, 2);
    assert.deepEqual(taskPayload.tags, ['metatask', 'jsp']);
    // The root spec is written by this call from the drafts' rootSpec entry.
    const specPayload = JSON.parse(writes[2].metaidData.payload);
    assert.equal(specPayload.name, DRAFTS_ROOT_SPEC_KEY);
    assert.equal(specPayload.script, buildDraftsFixture().specs[DRAFTS_ROOT_SPEC_KEY].script);
    const out = JSON.parse(ok.content[0].text);
    assert.equal(out.source, 'draftsFile');
    assert.equal(out.taskId, DRAFTS_TASK_ID);
  });
});

test('metatask_publish: both modes, unknown taskId and stray specPinByKey are refused', async () => {
  const { handlers, writes } = buildHarness([]);
  await withDraftsFile(buildDraftsFixture(), async (draftsFile) => {
    const both = await handlers.metatask_publish({
      draftsFile,
      taskId: DRAFTS_TASK_ID,
      title: 'hand-typed title',
    });
    assert.equal(both.isError, true);
    assert.match(both.content[0].text, /not both/);

    const missingTaskId = await handlers.metatask_publish({ draftsFile });
    assert.equal(missingTaskId.isError, true);
    assert.match(missingTaskId.content[0].text, /draftsFile and taskId must be passed together/);

    const unknownTask = await handlers.metatask_publish({
      draftsFile,
      taskId: 'T9-JSP-000999',
      specPinByKey: {},
    });
    assert.equal(unknownTask.isError, true);
    assert.match(unknownTask.content[0].text, /no tasks\[\] entry with id "T9-JSP-000999"/);
    assert.match(unknownTask.content[0].text, /T1-JSP-000301/);

    const strayMap = await handlers.metatask_publish({
      title: 'inline',
      nodes: [
        { id: 'root', parent: null, title: 'root', kind: 'aggregate', weight: 10000 },
      ],
      spec: { name: 'x', lang: 'bash', entry: 'x.sh', script: 'echo pass' },
      policy: { claimTtlHours: 1, verifyQuorum: 1, verifyWindowHours: 1 },
      specPinByKey: {},
    });
    assert.equal(strayMap.isError, true);
    assert.match(strayMap.content[0].text, /specPinByKey only applies in draftsFile mode/);

    assert.equal(writes.length, 0);
  });
});

// ── enumeration_closure integer search is recursive ──────────────────────────

test('metatask_publish_spec: enumeration_closure accepts an integer at any depth', async () => {
  const { handlers, writes } = buildHarness([]);

  // The campaign drafts' own shape: the count lives inside a selfcheck object.
  const nestedObject = await handlers.metatask_publish_spec({
    name: 'nested-object',
    lang: 'python3',
    entry: 'nested.py',
    script: SPEC_SCRIPT,
    validation: buildValidation(ARTIFACT_REF, {
      enumeration_closure: {
        closure: 'primes of the two certificates',
        selfcheck: { jsp: 'JSP-000301', expected_count: 4, count_meaning: 'distinct primes' },
      },
    }),
  });
  assert.equal(nestedObject.isError, undefined, nestedObject.content?.[0]?.text);

  // ...and inside an array of vectors.
  const nestedArray = await handlers.metatask_publish_spec({
    name: 'nested-array',
    lang: 'python3',
    entry: 'nested-array.py',
    script: SPEC_SCRIPT,
    validation: buildValidation(ARTIFACT_REF, {
      enumeration_closure: {
        closure: 'every batch',
        selfcheck: [{ batch: 'b01', expected_count: 27 }, { batch: 'b02', expected_count: 30 }],
      },
    }),
  });
  assert.equal(nestedArray.isError, undefined, nestedArray.content?.[0]?.text);
  assert.equal(writes.length, 2);

  // A block with no integer anywhere (and no integer-looking string) refuses.
  const noInteger = await handlers.metatask_publish_spec({
    name: 'no-integer',
    lang: 'python3',
    entry: 'no-integer.py',
    script: SPEC_SCRIPT,
    validation: buildValidation(ARTIFACT_REF, {
      enumeration_closure: {
        closure: 'every batch',
        selfcheck: { batch: 'b01', count: 'twenty-seven' },
        count_meaning: 'a word, not a field',
      },
    }),
  });
  assert.equal(noInteger.isError, true);
  assert.match(noInteger.content[0].text, /integer self-check count/);

  // The closure string requirement is untouched.
  const noClosure = await handlers.metatask_publish_spec({
    name: 'no-closure',
    lang: 'python3',
    entry: 'no-closure.py',
    script: SPEC_SCRIPT,
    validation: buildValidation(ARTIFACT_REF, {
      enumeration_closure: { selfcheck: { expected_count: 4 } },
    }),
  });
  assert.equal(noClosure.isError, true);
  assert.match(noClosure.content[0].text, /closure/);

  assert.equal(writes.length, 2, 'only the two accepted specs were written');
});
