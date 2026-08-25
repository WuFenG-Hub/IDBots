import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);

function loadCompiled(modulePath) {
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
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

const loadModule = (modulePath) => {
  try {
    return loadCompiled(`../dist-electron/main/${modulePath}`);
  } catch {
    return loadCompiled(`../dist-electron/${modulePath}`);
  }
};

const {
  decideGroupTaskResponders,
} = loadModule('services/groupTaskDaemon.js');
const {
  parseGroupTaskEntropyP0Config,
  isCeremonyAckLine,
  truncateGroupLogLine,
  renderGroupLogLines,
  GROUP_LOG_MESSAGE_MAX_CHARS,
} = loadModule('libs/groupTaskEntropy.js');

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('entropy config parses defaults, overrides and garbage safely', () => {
  assert.deepEqual(parseGroupTaskEntropyP0Config(null), { floorGate: true, ackTemplate: true, logFold: true });
  assert.deepEqual(parseGroupTaskEntropyP0Config('not json'), { floorGate: true, ackTemplate: true, logFold: true });
  assert.deepEqual(
    parseGroupTaskEntropyP0Config(JSON.stringify({ floorGate: false })),
    { floorGate: false, ackTemplate: true, logFold: true },
  );
});

test('isCeremonyAckLine recognizes ACK shapes but lets questions through', () => {
  assert.equal(isCeremonyAckLine('[WORKING] 已接单，正在制作演示视频，预计 10 分钟'), true);
  assert.equal(isCeremonyAckLine('[STANDBY] 待命中'), true);
  assert.equal(isCeremonyAckLine('  [WORKING] starts after trim'), true);
  assert.equal(isCeremonyAckLine('[WORKING] 已接单，但 API key 从哪里拿?'), false, 'question guard');
  assert.equal(isCeremonyAckLine('[WORKING] 需要确认一下吗？'), false, 'fullwidth question guard');
  assert.equal(isCeremonyAckLine('[DELIVERABLE] pin://abc'), false, 'not an ACK shape');
  assert.equal(isCeremonyAckLine('随便一句话'), false);
  assert.equal(isCeremonyAckLine(''), false);
});

test('group log line truncation keeps head and tail with a marker', () => {
  const short = 'plan: do the thing';
  assert.equal(truncateGroupLogLine(short), short);
  const long = `HEAD${'x'.repeat(2_000)}TAIL`;
  const truncated = truncateGroupLogLine(long);
  assert.ok(truncated.length <= GROUP_LOG_MESSAGE_MAX_CHARS + 10, 'bounded');
  assert.ok(truncated.startsWith('HEAD'));
  assert.ok(truncated.endsWith('TAIL'));
  assert.ok(truncated.includes(' … '));
});

test('renderGroupLogLines folds consecutive ceremony lines and never the trigger', () => {
  const entries = [
    { senderName: 'Chair', content: '@Coder Bot please build the demo' },
    { senderName: 'Coder Bot', content: '[WORKING] 已接单，开始制作' },
    { senderName: 'Designer Bot', content: '[STANDBY] 待命' },
    { senderName: 'Coder Bot', content: '[WORKING] 继续制作' },
    { senderName: 'Owner', content: '进度如何', isTrigger: true },
  ];
  const lines = renderGroupLogLines(entries, { fold: true });
  const folded = lines.find((line) => line.includes('[folded]'));
  assert.ok(folded, 'a fold line exists');
  assert.match(folded, /3 acknowledgment\/standby line\(s\) omitted \(Coder Bot, Designer Bot\)/);
  const trigger = lines.find((line) => line.includes('>>>'));
  assert.ok(trigger && trigger.includes('Owner: 进度如何'));
  assert.equal(lines.some((line) => line.includes('已接单')), false, 'raw ACK bodies gone');

  const unfolded = renderGroupLogLines(entries, { fold: false });
  assert.equal(unfolded.some((line) => line.includes('[folded]')), false);
  assert.equal(unfolded.filter((line) => line.includes('[WORKING]')).length, 2);
});

// ---------------------------------------------------------------------------
// Responder gating
// ---------------------------------------------------------------------------

const BOSS_GMID = 'gmid-boss';
const GATE_BOTS = new Map([
  [1, { id: 1, name: 'Twin Bot', metaid: 'metaid-1', globalmetaid: 'gmid-twin', boss_global_metaid: BOSS_GMID }],
  [2, { id: 2, name: 'Coder Bot', metaid: 'metaid-2', globalmetaid: 'gmid-w2', boss_global_metaid: BOSS_GMID }],
  [3, { id: 3, name: 'Designer Bot', metaid: 'metaid-3', globalmetaid: 'gmid-w3', boss_global_metaid: BOSS_GMID }],
]);
const GATE_MEMBERS = [
  { metabotId: 1, globalmetaid: 'gmid-twin', role: 'chair', name: 'Twin Bot' },
  { metabotId: 2, globalmetaid: 'gmid-w2', role: 'worker', name: 'Coder Bot' },
  { metabotId: 3, globalmetaid: 'gmid-w3', role: 'worker', name: 'Designer Bot' },
];
const gateMessage = (overrides = {}) => ({
  id: 1,
  senderMetaId: 'metaid-w2',
  senderGlobalMetaId: 'gmid-w2',
  senderName: 'Coder Bot',
  content: 'hello group',
  mention: null,
  senderSuspect: false,
  ...overrides,
});
const TASK = { id: 1, status: 'executing', hasOpenCheckpoint: false };

test('floor gate: ceremony ACK from a worker no longer triggers the chair', () => {
  const decisions = decideGroupTaskResponders(
    gateMessage({ content: '[WORKING] 已接单，正在制作，预计 10 分钟' }),
    TASK, GATE_MEMBERS, GATE_BOTS,
  );
  assert.deepEqual(decisions, [], 'no chair LLM turn for a plain ceremony ACK');

  const withQuestion = decideGroupTaskResponders(
    gateMessage({ content: '[WORKING] 已接单，但素材库地址是哪个?' }),
    TASK, GATE_MEMBERS, GATE_BOTS,
  );
  assert.deepEqual(withQuestion.map((decision) => decision.reason), ['chair_floor_control'], 'question guard reaches the chair');

  const legacy = decideGroupTaskResponders(
    gateMessage({ content: '[WORKING] 已接单，正在制作' }),
    TASK, GATE_MEMBERS, GATE_BOTS,
    { entropyFloorGate: false },
  );
  assert.deepEqual(legacy.map((decision) => decision.reason), ['chair_floor_control'], 'kv rollback restores old behavior');
});

test('floor gate: other paths untouched (plain chatter still floor-controls)', () => {
  const chatter = decideGroupTaskResponders(
    gateMessage({ content: '我先把环境配好了' }),
    TASK, GATE_MEMBERS, GATE_BOTS,
  );
  assert.deepEqual(chatter.map((decision) => decision.reason), ['chair_floor_control']);

  const deliverable = decideGroupTaskResponders(
    gateMessage({ content: '[DELIVERABLE] pin://abcdef123 [WORKING] done' }),
    TASK, GATE_MEMBERS, GATE_BOTS,
  );
  assert.deepEqual(deliverable.map((decision) => decision.reason), ['chair_deliverable'], 'deliverable gate wins even with a WORKING prefix');

  const owner = decideGroupTaskResponders(
    gateMessage({ content: '[WORKING] 已接单', senderGlobalMetaId: BOSS_GMID, senderName: 'Owner' }),
    { ...TASK, status: 'review' },
    GATE_MEMBERS, GATE_BOTS,
  );
  assert.deepEqual(owner.map((decision) => decision.reason), ['chair_owner_message'], 'owner in review still reaches the chair');
});

test('review: truncateGroupLogLine never splits surrogate pairs (llmSafeText rules)', () => {
  // Emoji straddling the head boundary and the tail boundary.
  const text = `A${'😀'.repeat(150)}B${'x'.repeat(600)}C${'🎉'.repeat(150)}Z`;
  const truncated = truncateGroupLogLine(text);
  assert.ok(truncated.length < text.length);
  assert.ok(truncated.startsWith('A'));
  assert.ok(truncated.endsWith('Z') || truncated.includes(' … '));
  // No lone surrogates anywhere: every code unit in a surrogate range must
  // be immediately paired (the DeepSeek-400 class of payload bug).
  for (let index = 0; index < truncated.length; index += 1) {
    const code = truncated.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = truncated.charCodeAt(index + 1);
      assert.ok(next >= 0xDC00 && next <= 0xDFFF, `high surrogate at ${index} must be paired`);
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      const prev = truncated.charCodeAt(index - 1);
      assert.ok(prev >= 0xD800 && prev <= 0xDBFF, `low surrogate at ${index} must be paired`);
    }
  }
});

test('review: substantive [WORKING] lines are exempt from the ceremony gate', () => {
  assert.equal(isCeremonyAckLine('[WORKING] 已接单，正在制作'), true, 'short pure ACK stays ceremony');
  assert.equal(
    isCeremonyAckLine(`[WORKING] API 限流，已切换备用源，正在重试第 3 次，若 10 分钟内仍失败将降级为本地缓存版本，此为状态通报${'详'.repeat(180)}`),
    false,
    'long blocker-style update is NOT ceremony',
  );
  assert.equal(isCeremonyAckLine('[WORKING] 已接单，见 pin://abcdef123'), false, 'carries a reference URI');
});

test('review: substantive [WORKING] lines still reach the chair via floor control', () => {
  const blocker = decideGroupTaskResponders(
    gateMessage({ content: `[WORKING] API 限流，已切换备用源，正在重试${'，细节'.repeat(60)}` }),
    TASK, GATE_MEMBERS, GATE_BOTS,
  );
  assert.deepEqual(blocker.map((decision) => decision.reason), ['chair_floor_control']);
});
