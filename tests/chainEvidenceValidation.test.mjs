/**
 * Dream-RSI exploration P1.5, commit 4 (design 2026-10-10 §5 + §6): the
 * chain-grounded evidence digest for the replay gate.
 *
 * Covers:
 *   1. extractChainRefs / collectChainEvidenceRefs — pin:// and metafile://
 *      URIs, bare pin ids (64hex+iN), bare 64-hex txids, no pin/txid double
 *      match, metaid:// skipped, draft-first ordering with source drafts,
 *   2. buildChainEvidenceDigest — pin EXISTS / NOT FOUND (typed 404) /
 *      UNVERIFIED on failure, txid CONFIRMED / NOT FOUND / UNVERIFIED, the
 *      local order cross-ref, the per-ref timeout, the per-night cap of 8,
 *      the counts mapping,
 *   3. renderChainEvidenceDigest — the §5.2 dated list format,
 *   4. end-to-end — the digest rides the validation prompt with the judging
 *      rules; the extended grounding gate discards verdicts citing
 *      uncollected refs; non-chain drafts judge as before; no deps wired =
 *      no digest, legacy behavior; verifier failure never fails the dream;
 *      telemetry fields land.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

const {
  CHAIN_EVIDENCE_MAX_REFS,
  extractChainRefs,
  collectChainEvidenceRefs,
  buildChainEvidenceDigest,
  renderChainEvidenceDigest,
  chainRefKeysOf,
} = require('../dist-electron/main/libs/chainEvidence.js');
const { buildCapabilityValidationPrompt } = require('../dist-electron/main/libs/capabilityValidationPrompt.js');

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
const LONG_IDENTITY = `我是一个认真严谨的 MetaBot。${'我先验证再交付。'.repeat(30)}`;
const PIN_A = `${'a'.repeat(64)}i0`;
const PIN_B = `${'b'.repeat(64)}i0`;
const PIN_GHOST = `${'c'.repeat(64)}i0`;
const TXID_A = 'd'.repeat(64);
const TXID_B = 'e'.repeat(64);

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

const dreamPayload = () => JSON.stringify({
  daily_summary: '普通的一天。',
  sections: {},
  work_reviews: [],
  important_memories: [],
  value_lessons: [],
  self_identity: LONG_IDENTITY,
  capability_learnings: [],
});

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

test('extractChainRefs: URIs, bare pin ids and txids; no double match; metaid:// skipped', () => {
  const refs = extractChainRefs(
    `发布了 pin://${PIN_A} 和 metafile://${PIN_B};交易 ${TXID_A} 已确认;` +
    `裸 pin ${PIN_A} 不重复;metaid://some-identity 不算;${TXID_A} 也不重复`,
  );
  assert.deepEqual(
    refs,
    [
      { kind: 'pin', id: PIN_A },
      { kind: 'pin', id: PIN_B },
      { kind: 'txid', id: TXID_A },
    ],
    'deduped, pin-id never also matches the txid pattern',
  );
  assert.deepEqual(extractChainRefs('没有引用的一天'), []);
  // A bare pin id is a pin, never a txid.
  assert.deepEqual(extractChainRefs(PIN_A), [{ kind: 'pin', id: PIN_A }]);
});

test('collectChainEvidenceRefs: draft refs first with source drafts, activity refs after', () => {
  const refs = collectChainEvidenceRefs({
    chainWrites: [{ pinId: PIN_B }],
    chainReads: [{ pinId: PIN_GHOST }],
    drafts: [
      { id: 1, text: `我发布了 pin://${PIN_A},又提到了 ${TXID_A}` },
      { id: 2, text: `我也引用了 pin://${PIN_A}` },
    ],
  });
  assert.deepEqual(
    refs.map((ref) => `${ref.kind}:${ref.id}`),
    [`pin:${PIN_A}`, `txid:${TXID_A}`, `pin:${PIN_B}`, `pin:${PIN_GHOST}`],
  );
  assert.deepEqual(refs[0].sourceDraftIds, [1, 2], 'both citing drafts recorded');
  assert.deepEqual(refs[2].sourceDraftIds, [], 'activity refs carry no draft');
});

// ---------------------------------------------------------------------------
// Verification + digest
// ---------------------------------------------------------------------------

test('digest: pin EXISTS/NOT FOUND/UNVERIFIED and txid CONFIRMED with order cross-ref', async () => {
  const refs = collectChainEvidenceRefs({
    drafts: [{ id: 1, text: `${PIN_A} ${PIN_B} ${PIN_GHOST} ${TXID_A}` }],
  });
  const digest = await buildChainEvidenceDigest(refs, {
    readPin: async (pinId) => {
      if (pinId === PIN_A) return { path: '/protocols/skill-service', protocol: 'skill-service', createdAt: 1780000000 };
      if (pinId === PIN_B) return null;
      const error = new Error('pin not found');
      error.name = 'MetawebPinNotFoundError';
      throw error;
    },
    isPinNotFound: (error) => error?.name === 'MetawebPinNotFoundError',
    fetchRawTx: async () => '00ff'.repeat(64),
    findOrdersByPaymentTxid: (txid) =>
      txid === TXID_A ? [{ id: 'abcdef12-3456-7890', status: 'completed' }] : [],
    now: () => Date.parse('2026-10-11T02:13:44Z'),
  });
  const byRef = new Map(digest.entries.map((entry) => [entry.ref, entry]));
  assert.equal(byRef.get(`pin://${PIN_A}`).label, 'EXISTS');
  assert.ok(byRef.get(`pin://${PIN_A}`).detail.includes('path=/protocols/skill-service'));
  assert.ok(byRef.get(`pin://${PIN_A}`).detail.includes('created=2026-05-28'));
  assert.equal(byRef.get(`pin://${PIN_B}`).label, 'NOT FOUND');
  assert.equal(byRef.get(`pin://${PIN_GHOST}`).label, 'NOT FOUND', 'typed 404 maps to NOT FOUND');
  const txEntry = byRef.get(`txid:${TXID_A}`);
  assert.equal(txEntry.label, 'CONFIRMED');
  assert.ok(txEntry.detail.includes('order abcdef12 status=completed'));
  assert.deepEqual(digest.counts, { refs: 4, supported: 2, contradicted: 2, notFound: 2, errors: 0 });
  assert.equal(digest.verifiedAt, '2026-10-11T02:13:44.000Z');

  const rendered = renderChainEvidenceDigest(digest);
  assert.ok(rendered.startsWith('Chain evidence (verified by host at 2026-10-11T02:13:44.000Z):'));
  assert.ok(rendered.includes(`- pin://${PIN_A}  EXISTS`));
  assert.ok(rendered.includes(`- txid:${TXID_A}  CONFIRMED`));
});

test('digest: failures and timeouts degrade to UNVERIFIED; a refunded order counts as contradicted', async () => {
  const refs = collectChainEvidenceRefs({
    drafts: [{ id: 1, text: `${PIN_A} ${TXID_A} ${TXID_B}` }],
  });
  const digest = await buildChainEvidenceDigest(refs, {
    readPin: async () => {
      await new Promise(() => {}); // never resolves
      return null;
    },
    fetchRawTx: async (txid) => {
      if (txid === TXID_A) throw new Error('network down');
      return ''; // not found on any chain
    },
    findOrdersByPaymentTxid: (txid) =>
      txid === TXID_B ? [{ id: 'beefbeef-0000', status: 'refunded' }] : [],
    timeoutMs: 30,
    now: () => 0,
  });
  const byRef = new Map(digest.entries.map((entry) => [entry.ref, entry]));
  assert.equal(byRef.get(`pin://${PIN_A}`).label, 'UNVERIFIED', 'timeout degrades, never errors');
  assert.ok(byRef.get(`pin://${PIN_A}`).detail.includes('timed out'));
  assert.equal(byRef.get(`txid:${TXID_A}`).label, 'UNVERIFIED');
  assert.ok(byRef.get(`txid:${TXID_A}`).detail.includes('network down'));
  assert.equal(byRef.get(`txid:${TXID_B}`).label, 'NOT FOUND');
  assert.ok(byRef.get(`txid:${TXID_B}`).detail.includes('status=refunded'));
  assert.deepEqual(digest.counts, { refs: 3, supported: 0, contradicted: 1, notFound: 1, errors: 2 });
});

test('digest: per-night cap of CHAIN_EVIDENCE_MAX_REFS; knownRefIds keeps every collected ref', async () => {
  assert.equal(CHAIN_EVIDENCE_MAX_REFS, 8);
  const drafts = [];
  for (let index = 0; index < 10; index += 1) {
    drafts.push({ id: index + 1, text: `${String(index).padStart(2, '0')}${'0'.repeat(62)}i0` });
  }
  const refs = collectChainEvidenceRefs({ drafts });
  assert.equal(refs.length, 10);
  const digest = await buildChainEvidenceDigest(refs, {
    readPin: async () => null,
    now: () => 0,
  });
  assert.equal(digest.entries.length, 8, 'verification capped');
  assert.equal(digest.knownRefIds.length, 10, 'the grounding gate knows every collected ref');
  assert.equal(digest.counts.refs, 8);
  assert.equal(digest.counts.notFound, 8);
});

test('digest: missing verifiers degrade to UNVERIFIED without throwing', async () => {
  const refs = collectChainEvidenceRefs({ drafts: [{ id: 1, text: `${PIN_A} ${TXID_A}` }] });
  const digest = await buildChainEvidenceDigest(refs, { now: () => 0 });
  assert.deepEqual(digest.entries.map((entry) => entry.label), ['UNVERIFIED', 'UNVERIFIED']);
  assert.ok(digest.entries.every((entry) => entry.detail.includes('verifier unavailable')));
});

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

test('validation prompt renders the digest + judging rules and per-draft chain refs only when present', () => {
  const base = {
    botName: '小火',
    date: DAY,
    drafts: [
      { id: 7, dreamDate: '2026-08-01', title: '发布技能', description: 'd', capabilityType: 'skill', chainRefs: [`pin://${PIN_A}`] },
      { id: 8, dreamDate: '2026-08-01', title: '纯会话技巧', description: 'd', capabilityType: 'skill' },
    ],
    recentSummaries: [],
  };
  const without = buildCapabilityValidationPrompt(base);
  assert.ok(!without.user.includes('链上证据'), 'no digest → no section, legacy prompt');
  assert.ok(!without.user.includes('链上引用:'));

  const withDigest = buildCapabilityValidationPrompt({
    ...base,
    chainEvidence: `Chain evidence (verified by host at 2026-10-11T02:13:44Z):\n- pin://${PIN_A}  EXISTS path=/protocols/skill-service`,
  });
  assert.ok(withDigest.user.includes('## 链上证据'));
  assert.ok(withDigest.user.includes(`- pin://${PIN_A}  EXISTS`));
  assert.ok(withDigest.user.includes('NOT FOUND') && withDigest.user.includes('keep_draft'), 'judging rules present');
  assert.ok(withDigest.user.includes(`链上引用:pin://${PIN_A}`), 'the chain-carrying draft is marked');
  const markedLine = withDigest.user.split('\n').filter((line) => line.includes('链上引用:'));
  assert.equal(markedLine.length, 1, 'only the chain-carrying draft is marked (scope discipline §5.3)');
});

// ---------------------------------------------------------------------------
// End-to-end through the dream validation pass
// ---------------------------------------------------------------------------

function buildService(coworkStore, dreamStore, { chainEvidence, verdictsForIds }) {
  const calls = [];
  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 3, 3, 0),
    chainEvidence,
    performChat: async (system, user) => {
      calls.push({ system, user });
      if (system.includes('能力验证')) {
        return JSON.stringify({ verdicts: verdictsForIds(user) });
      }
      return dreamPayload();
    },
  });
  return { service, calls };
}

test('end-to-end: digest rides the validation prompt; contradicted claim rejected; ghost-cited verdict dropped', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  seedActivity(coworkStore, db);
  coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
    { title: '发布服务', description: `我成功发布了服务 pin://${PIN_A}`, capabilityType: 'skill' },
    { title: '没发布成', description: `服务发布失败,pin://${PIN_B} 不存在`, capabilityType: 'skill' },
    { title: '纯会话技巧', description: '回复前先读上下文', capabilityType: 'skill' },
  ]);
  const byTitle = (title) => coworkStore.listCapabilityDrafts(5).find((draft) => draft.title === title);
  const readPinCalls = [];

  const { service, calls } = buildService(coworkStore, dreamStore, {
    chainEvidence: {
      readPin: async (pinId) => {
        readPinCalls.push(pinId);
        if (pinId === PIN_A) return { path: '/protocols/skill-service', protocol: 'skill-service', createdAt: 1780000000 };
        if (pinId === PIN_B) return null;
        return null;
      },
    },
    verdictsForIds: (user) => {
      const entries = [...user.matchAll(/### 草案 #(\d+)[\s\S]*?标题:([^\n]+)/g)];
      return entries.map((match) => {
        const id = Number(match[1]);
        const title = match[2];
        if (title === '发布服务') {
          return { id, verdict: 'validated', score: 0.95, rationale: `pin://${PIN_A} 已在链上确认存在` };
        }
        if (title === '没发布成') {
          return { id, verdict: 'rejected', score: 0.9, rationale: `pin://${PIN_B} 是 NOT FOUND,声明与链上矛盾` };
        }
        // The pure-conversation draft gets a verdict citing a pin that was
        // never collected tonight — the grounding gate must discard it.
        return { id, verdict: 'validated', score: 0.95, rationale: `凭 pin://${PIN_GHOST} 判断有效` };
      });
    },
  });
  try {
    await service.runNow(5, DAY);

    const validationCall = calls.find((call) => call.system.includes('能力验证'));
    assert.ok(validationCall.user.includes('## 链上证据'), 'digest section in the prompt');
    assert.ok(validationCall.user.includes(`- pin://${PIN_A}  EXISTS`), 'verified pin renders EXISTS');
    assert.ok(validationCall.user.includes('path=/protocols/skill-service'));
    assert.ok(validationCall.user.includes(`- pin://${PIN_B}  NOT FOUND`));
    assert.ok(validationCall.user.includes('涉链裁决规则'));
    assert.ok(validationCall.user.includes(`链上引用:pin://${PIN_A}`), 'chain-carrying drafts marked');
    assert.deepEqual(readPinCalls.sort(), [PIN_A, PIN_B].sort(), 'exactly the cited pins were verified (no chain work for the pure draft)');

    assert.equal(byTitle('发布服务').status, 'validated', 'supported claim validates');
    assert.equal(byTitle('没发布成').status, 'rejected', 'contradicted claim rejects');
    assert.equal(byTitle('纯会话技巧').status, 'draft', 'the ghost-cited verdict is discarded, draft untouched');

    const telemetry = dreamStore.getRun(5, DAY).telemetry;
    assert.deepEqual(
      telemetry.chainEvidence,
      { refs: 2, supported: 1, contradicted: 1, notFound: 1, errors: 0 },
    );
  } finally {
    cleanup();
  }
});

test('end-to-end: verifier failure degrades to UNVERIFIED and never fails the dream run', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  seedActivity(coworkStore, db);
  coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
    { title: '发布服务', description: `我发布了 pin://${PIN_A}`, capabilityType: 'skill' },
  ]);
  const { service, calls } = buildService(coworkStore, dreamStore, {
    chainEvidence: {
      readPin: async () => {
        throw new Error('ECONNREFUSED');
      },
    },
    verdictsForIds: (user) => {
      const id = Number(user.match(/### 草案 #(\d+)/)[1]);
      return [{ id, verdict: 'keep_draft', score: 0.5, rationale: '证据不足' }];
    },
  });
  try {
    await service.runNow(5, DAY);
    const validationCall = calls.find((call) => call.system.includes('能力验证'));
    assert.ok(validationCall.user.includes(`- pin://${PIN_A}  UNVERIFIED`));
    assert.equal(dreamStore.getRun(5, DAY).status, 'completed');
    assert.equal(coworkStore.listCapabilityDrafts(5)[0].status, 'draft', 'keep_draft leaves the draft pending');
    assert.deepEqual(
      dreamStore.getRun(5, DAY).telemetry.chainEvidence,
      { refs: 1, supported: 0, contradicted: 0, notFound: 0, errors: 1 },
    );
  } finally {
    cleanup();
  }
});

test('end-to-end: no verifier deps wired → no digest, legacy judging, telemetry null', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  seedActivity(coworkStore, db);
  coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
    { title: '发布服务', description: `我发布了 pin://${PIN_A}`, capabilityType: 'skill' },
  ]);
  const { service, calls } = buildService(coworkStore, dreamStore, {
    chainEvidence: undefined,
    verdictsForIds: (user) => {
      const id = Number(user.match(/### 草案 #(\d+)/)[1]);
      return [{ id, verdict: 'validated', score: 0.95, rationale: `链上有 pin://${PIN_A}` }];
    },
  });
  try {
    await service.runNow(5, DAY);
    const validationCall = calls.find((call) => call.system.includes('能力验证'));
    assert.ok(!validationCall.user.includes('## 链上证据'), 'no digest section without deps');
    // The grounding gate is off without a digest: the pin-citing verdict lands.
    assert.equal(coworkStore.listCapabilityDrafts(5)[0].status, 'validated');
    assert.equal(dreamStore.getRun(5, DAY).telemetry.chainEvidence, null);
  } finally {
    cleanup();
  }
});

test('chainRefKeysOf powers the grounding gate membership check', () => {
  assert.deepEqual(chainRefKeysOf(`见 pin://${PIN_A} 与 ${TXID_A}`), [`pin:${PIN_A}`, `txid:${TXID_A}`]);
  assert.deepEqual(chainRefKeysOf('没有引用'), []);
});
