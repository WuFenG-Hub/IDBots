/**
 * S1 时基缺陷回归（IDBots 宿主侧 F-A）：EventMeta.timestamp 的单位契约。
 *
 * 缺陷（2026-09-27 说明书 s1-host-fix-spec.md §1/§2）：宿主的 meta.timestamp
 * 有两条互相矛盾的车道 —— 「链上行走 withRowMeta 原样透传」（索引器写的是
 * Unix 秒 group_chat_messages.chain_timestamp）与「自写事件盖 this.now()」
 * （毫秒）。适配器拿同一个毫秒常量窗口（MOVE_TIMEOUT_MS = 900_000）对两条
 * 车道喂进来的值做同一个减法，于是同一条链上 timeout.claimed 在写它的一方
 * 判「超时成立」、在读到它的一方判「还没超时」，后者继续走子，链上物化为
 * prevStateHash/stateHash 告警（G3 idx16 / G4 idx20 同型）。
 *
 * 本套件锁定（离线，不需要网络、不需要真实对局）：
 *  - 用例 1  单位契约本身：链上行的 10 位秒值必须归一为毫秒；已是毫秒的值
 *            原样通过（|v| < 1e11 ⇒ 秒，与第三方重放器 normalizeTs 同判据）。
 *            修前 runtime.js 无此函数 ⇒ 精确红。
 *  - 用例 2  G3 的真实数字复刻：满座行 1_790_450_695（秒）→ 对手席的
 *            timeout.claimed 行 1_790_451_657（秒），差 962 s。写侧（发 claim
 *            的席位）按毫秒差 962_000 > 900_000 判超时成立；读侧必须同判。
 *            修前读侧把 962 当毫秒用（962 ≤ 900_000）⇒ 判未超时 ⇒ 相位停在
 *            playing ⇒ 红，这就是「一边判超时一边不判」的原样复现。
 *  - 用例 3  反向护栏：claim 落在窗口内（100 s < 900 s）不得终局——防止
 *            「归一」被写成「一律乘 1000」的越界修复。
 *
 * 与第三方重放器的关系：`replay-verify.mjs` 的 auto 口径（|n| < 1e11 ⇒ 秒）
 * 与本文件用例 1 的判据逐字一致，所以宿主与第三方在同一份链上数据上同判。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(import.meta.dirname, '..');

/** Electron stub — adapterSandbox only needs app.isPackaged + app.getAppPath(). */
const electronStub = {
  app: { isPackaged: false, getAppPath: () => projectRoot },
};
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, parent, isMain);
};

/** 陈旧产物守卫：探针标识符取自本修复新引入的代码（toEventMetaMs），
 *  旧产物缺失特征 → 显式红灯 + 重编译指引。
 *  TIMEBASE_ALLOW_STALE=1 只在「修前基线要落在行为断言上」时使用（红绿对照
 *  的精确红：守卫先加会让基线跑死在 setup 而不是行为断言上），日常跑必须不带。 */
const DIST_RUNTIME_JS = path.join(projectRoot, 'dist-electron', 'main', 'agentGame', 'runtime.js');
(function assertFreshAgentGameDist() {
  if (process.env.TIMEBASE_ALLOW_STALE === '1') return;
  let src;
  try {
    src = fs.readFileSync(DIST_RUNTIME_JS, 'utf8');
  } catch {
    throw new Error(`[stale-dist-guard] ${DIST_RUNTIME_JS} 不存在：先编译 electron 主进程（pnpm run compile:electron）再跑本套件`);
  }
  if (!src.includes('toEventMetaMs')) {
    throw new Error('[stale-dist-guard] dist-electron/main/agentGame/runtime.js 缺单位归一特征（toEventMetaMs，旧产物）：请重编译后重跑');
  }
})();

setTimeout(() => {
  console.error('[suite-watchdog] 套件 120s 未结束：静默挂起（疑似 dist-electron 陈旧或资源竞争），强制 exit 1');
  process.exit(1);
}, 120_000).unref();

/** Minimal SqliteDatabase-shape adapter over node:sqlite. */
class TestSqliteDb {
  constructor() {
    this.db = new DatabaseSync(':memory:');
  }

  exec(sql, params = []) {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
      this.db.exec(sql);
      return [];
    }
    const stmt = this.db.prepare(sql);
    if (/^\s*(SELECT|PRAGMA)/i.test(sql)) {
      const rows = stmt.all(...params);
      const columns = stmt.columns().map((column) => column.name || column.column || '');
      return [{ columns, values: rows.map((row) => columns.map((column) => row[column])) }];
    }
    stmt.run(...params);
    return [];
  }

  run(sql, params = []) {
    return this.exec(sql, params);
  }
}

function createAgentGameTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_game_sessions (
    session_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'paused',
    app_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    game_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    seat TEXT NOT NULL,
    rules_hash TEXT NOT NULL,
    adapter_hash TEXT NOT NULL,
    manifest_uri TEXT NOT NULL,
    protocol_paths TEXT,
    budget_llm_calls INTEGER NOT NULL DEFAULT 0,
    budget_llm_calls_used INTEGER NOT NULL DEFAULT 0,
    budget_writes INTEGER NOT NULL DEFAULT 0,
    budget_writes_used INTEGER NOT NULL DEFAULT 0,
    last_index INTEGER,
    last_action_seq INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    expires_at INTEGER NOT NULL DEFAULT 0,
    consent TEXT,
    lease_id TEXT,
    lease_expires_at INTEGER,
    serialized_state TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_game_grants (
    resource_uri TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    app_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    game_id TEXT NOT NULL,
    rules_hash TEXT NOT NULL,
    adapter_hash TEXT NOT NULL,
    seat TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    ttl_ms INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL DEFAULT 0,
    budget_llm_calls INTEGER NOT NULL DEFAULT 0,
    budget_writes INTEGER NOT NULL DEFAULT 0,
    protocol_paths TEXT,
    revoked_at INTEGER,
    reason TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (resource_uri, actor_id, app_id, group_id, game_id, rules_hash, adapter_hash, seat)
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_game_write_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    action_seq INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    pin_id TEXT,
    tx_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (group_id, action_seq, event_id)
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_game_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    session_id TEXT,
    actor_id TEXT,
    fields TEXT,
    ts INTEGER NOT NULL
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS group_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pin_id TEXT UNIQUE NOT NULL,
    tx_id TEXT,
    group_id TEXT NOT NULL,
    channel_id TEXT,
    sender_metaid TEXT NOT NULL,
    sender_global_metaid TEXT,
    sender_address TEXT,
    sender_name TEXT,
    sender_avatar TEXT,
    sender_chat_pubkey TEXT,
    protocol TEXT NOT NULL,
    content TEXT,
    content_type TEXT,
    encryption TEXT,
    reply_pin TEXT,
    mention TEXT,
    chain_timestamp INTEGER,
    chain TEXT,
    raw_data TEXT,
    is_processed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );`);
  db.exec(`ALTER TABLE group_chat_messages ADD COLUMN msg_index INTEGER;`);
}

/* ------------------------------------------------------------------ */
/* 常量 + 字节级裁判 adapter fixture（与 agentGameConvergence 同一份）  */
/* ------------------------------------------------------------------ */

const GAME_ID = 'xiangqi';
const GROUP_ID = 'timebase-group-1';
const RED_AGENT = 'idq1timebase-red-00000000000000000000000000';
const BLACK_AGENT = 'idq1timebase-black-0000000000000000000000';
const RULES_HASH = 'sha256:timebase-regression-rules-hash';

const FIXTURE_ADAPTER_DIR = path.join(projectRoot, 'tests', 'fixtures', 'xiangqi-adapter');
const FIXTURE_ADAPTER_SHA256 = crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(FIXTURE_ADAPTER_DIR, 'agent-game', 'adapter.js')))
  .digest('hex');

/* ------------------------------------------------------------------ */
/* Host harness                                                        */
/* ------------------------------------------------------------------ */

const { createAgentGameHost } = require('../dist-electron/main/agentGame/index.js');
const { toEventMetaMs } = require('../dist-electron/main/agentGame/runtime.js');

/** G3 实测坐标（说明书 §1.2）：满座行 1_790_450_695（秒），claim 行 1_790_451_657（秒）。 */
const G3_ROW_SEC = 1_790_450_695;
const G3_CLAIM_SEC = 1_790_451_657;

/** chainWrite 录制器：记录每次链写并同步落 group_chat_messages 行（行时间戳为毫秒）。 */
function makeChainRecorder(db, groupId) {
  const calls = [];
  let rowSeq = 0;
  return {
    calls,
    async chainWrite(gid, plaintext, opts) {
      const rowTs = Date.now();
      calls.push({ groupId: gid, plaintext, opts: opts ?? null, rowTs });
      rowSeq += 1;
      const maxRow = db.exec('SELECT COALESCE(MAX(msg_index), 0) FROM group_chat_messages WHERE group_id = ?', [gid]);
      const nextIndex = Number(maxRow[0]?.values?.[0]?.[0] ?? 0) + 1;
      db.run(
        `INSERT INTO group_chat_messages
          (pin_id, group_id, sender_metaid, sender_global_metaid, protocol, content, encryption, chain_timestamp, msg_index)
         VALUES (?, ?, ?, ?, 'simplegroupchat', ?, '', ?, ?)`,
        [`timebase-pin-${rowSeq}`, gid, opts?.asAgentId ?? 'unknown', opts?.asAgentId ?? null, plaintext, rowTs, nextIndex],
      );
      return { pinId: `timebase-pin-${calls.length}` };
    },
  };
}

function materializeJudgeAdapter() {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-game-timebase-'));
  fs.mkdirSync(path.join(artifactDir, 'agent-game'), { recursive: true });
  fs.mkdirSync(path.join(artifactDir, 'js'), { recursive: true });
  for (const rel of ['agent-game/adapter.js', 'js/notation.js', 'js/rules.js']) {
    fs.copyFileSync(path.join(FIXTURE_ADAPTER_DIR, rel), path.join(artifactDir, rel));
  }
  fs.writeFileSync(path.join(artifactDir, 'package.json'), JSON.stringify({ type: 'module' }));
  const manifest = {
    protocol: 'agent-game/1',
    gameId: GAME_ID,
    rulesVersion: '1.0.0',
    adapter: './agent-game/adapter.js',
    adapterHash: `sha256:${FIXTURE_ADAPTER_SHA256}`,
    turnModel: 'sequential',
    informationModel: 'public',
    maxPlayers: 2,
  };
  fs.writeFileSync(path.join(artifactDir, 'game-manifest.json'), JSON.stringify(manifest));
  return {
    artifactDir,
    manifestFetch: async () => JSON.parse(fs.readFileSync(path.join(artifactDir, 'game-manifest.json'), 'utf8')),
    adapterPathFor: async (_manifestUri, mf) => path.join(artifactDir, mf.adapter),
  };
}

function buildHost({ llm }) {
  const db = new TestSqliteDb();
  createAgentGameTables(db);
  const judge = materializeJudgeAdapter();
  const recorder = makeChainRecorder(db, GROUP_ID);
  const host = createAgentGameHost({
    db,
    saveDb: () => {},
    llmComplete: llm,
    chainWrite: recorder.chainWrite,
    manifestFetch: judge.manifestFetch,
    adapterPathFor: judge.adapterPathFor,
    resolveActor: () => RED_AGENT,
    actorNameFor: (id) => (id === RED_AGENT ? 'Builder阿码' : id === BLACK_AGENT ? 'AI_Sunny' : ''),
    log: (m) => { if (process.env.TIMEBASE_DEBUG) console.error('[runtime]', m); },
  });
  return {
    host,
    db,
    recorder,
    artifactDir: judge.artifactDir,
    cleanup: () => fs.rmSync(judge.artifactDir, { recursive: true, force: true }),
  };
}

function startParams(overrides = {}) {
  return {
    appId: 'timebase.v1',
    sessionType: 'agent-game',
    groupId: GROUP_ID,
    gameId: GAME_ID,
    manifestUri: 'metaapp://judge-fixture-pin-i0',
    rulesHash: RULES_HASH,
    seat: 'red',
    agentId: RED_AGENT,
    ttlMs: 3_600_000,
    budget: { llmCalls: 20, writes: 20 },
    ...overrides,
  };
}

/** 两阶段 start：phase1 确认卡 → phase2 建会话。 */
async function startSession(host, params) {
  const resourceUri = `metaapp://confirm-${Math.random().toString(36).slice(2)}`;
  const phaseOne = await host.handleSessionMethod('start', params, params.agentId, { resourceUri });
  assert.equal(phaseOne.manualAction, true, 'phase 1 must issue a confirmation');
  const session = await host.handleSessionMethod('start', phaseOne.confirmRequest.payload, params.agentId, { resourceUri });
  assert.equal(session.__error || false, false, `phase 2 failed: ${session.code} ${session.message}`);
  return session;
}

/** 下一个可用 msg_index（宿主自写行的 msg_index 是异步落库的，硬编码会撞号）。 */
function nextMsgIndex(db) {
  const row = db.exec('SELECT COALESCE(MAX(msg_index), 0) FROM group_chat_messages WHERE group_id = ?', [GROUP_ID]);
  return Number(row[0]?.values?.[0]?.[0] ?? 0) + 1;
}

/** 手工插入一条链上消息行（chain_timestamp 传 10 位秒 —— 索引器的真实口径）。 */
function insertRow(db, { pinId, senderGlobalMetaId, content, chainTimestamp }) {
  const msgIndex = nextMsgIndex(db);
  db.run(
    `INSERT INTO group_chat_messages
      (pin_id, group_id, sender_metaid, sender_global_metaid, protocol, content, encryption, chain_timestamp, msg_index)
     VALUES (?, ?, ?, ?, 'simplegroupchat', ?, 'aes', ?, ?)`,
    [pinId, GROUP_ID, 'legacy-metaid', senderGlobalMetaId, content, chainTimestamp, msgIndex],
  );
  return msgIndex;
}

const envelopeOf = (type, extra = {}) => JSON.stringify({
  protocol: 'agent-game/1',
  gameId: GAME_ID,
  matchId: GROUP_ID,
  rulesHash: RULES_HASH,
  type,
  eventId: `row:${type}:${Math.random().toString(36).slice(2)}`,
  ...extra,
});

const matchCreatedContent = () => envelopeOf('match.created', { payload: { title: 'timebase regression match' } });
const seatClaimContent = (seat) => envelopeOf('seat.claimed', { payload: { requestedRole: seat } });
const timeoutClaimContent = () => envelopeOf('timeout.claimed', { payload: {} });

const realDateNow = Date.now;
async function waitFor(predicate, { timeoutMs = 15_000, stepMs = 20, label = 'condition' } = {}) {
  const deadline = realDateNow() + timeoutMs;
  while (realDateNow() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

/** 虚拟时钟：把「宿主自己的 now」对齐到 G3 的链上时刻，使自写车道与行车道可比。
 *  接管 Date.now（runtime/store/lease 全走 Date.now）；真实计时走 realDateNow。 */
function installFakeClock(atMs) {
  Date.now = () => atMs;
}
function uninstallFakeClock() {
  Date.now = realDateNow;
}

/** 前缀流：match.created（行=秒）→ 红方占座（宿主 start 自写，毫秒）→ 黑方占座（行=秒）。
 *  必须等自写行真正落库后再插下一行：否则手工 msg_index 会与异步自写行撞号。 */
async function seatBothSides(db, host, rowSec) {
  insertRow(db, {
    pinId: 'timebase-row-1', senderGlobalMetaId: RED_AGENT,
    chainTimestamp: rowSec, content: matchCreatedContent(),
  });
  const session = await startSession(host, startParams());
  await waitFor(() => ownSeatClaimCommitted(db), { label: 'own seat.claimed committed' });
  insertRow(db, {
    pinId: 'timebase-row-3', senderGlobalMetaId: BLACK_AGENT,
    chainTimestamp: rowSec, content: seatClaimContent('black'),
  });
  host.onGroupMessage(GROUP_ID);
  await waitFor(async () => {
    const state = await serializedStateOf(host, session.sessionId);
    return state?.phase === 'playing';
  }, { label: 'both seats claimed → playing' });
  return session;
}

function ownSeatClaimCommitted(db) {
  const row = db.exec(
    `SELECT status FROM agent_game_write_log WHERE group_id = ? AND action_seq = 0`,
    [GROUP_ID],
  )[0]?.values?.[0];
  return String(row?.[0]) === 'committed';
}

async function serializedStateOf(host, sessionId) {
  const raw = host.store.getSerializedState(sessionId);
  return raw ? JSON.parse(raw) : null;
}

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

test('EventMeta 单位契约：链上行的秒值归一为毫秒，已是毫秒的值原样通过', () => {
  assert.equal(typeof toEventMetaMs, 'function', 'runtime 必须导出 toEventMetaMs（单位归一唯一入口）');
  // 链上「行」是 10 位 Unix 秒（group_chat_messages.chain_timestamp）。
  assert.equal(toEventMetaMs(G3_ROW_SEC), 1_790_450_695_000, '10 位秒 → 毫秒（×1000）');
  assert.equal(toEventMetaMs(G3_CLAIM_SEC), 1_790_451_657_000, '10 位秒 → 毫秒（×1000）');
  // 已是毫秒的值必须原样通过（|v| >= 1e11）——第三方重放器 auto 口径的同一条判据。
  assert.equal(toEventMetaMs(1_790_451_657_000), 1_790_451_657_000, '毫秒值不得再 ×1000');
  assert.equal(toEventMetaMs(1_790_451_657_123), 1_790_451_657_123, '毫秒值（含小数级精度）原样通过');
});

test('G3 复刻：同一条 timeout.claimed 在写侧与读侧得到同一裁决（修前读侧判未超时）', { timeout: 40_000 }, async () => {
  installFakeClock(G3_CLAIM_SEC * 1000);
  let host = null;
  let cleanup = () => {};
  try {
    // 红席参战、本机大脑挂死（只为不让自写走子污染 lastProgressTs）。
    const built = buildHost({ llm: () => new Promise(() => {}) });
    host = built.host;
    cleanup = built.cleanup;

    const session = await seatBothSides(built.db, host, G3_ROW_SEC);

    // 对手席（黑）在 962 s 后声明超时：写侧按毫秒差 962_000 > 900_000 判成立。
    insertRow(built.db, {
      pinId: 'timebase-row-4', senderGlobalMetaId: BLACK_AGENT,
      chainTimestamp: G3_CLAIM_SEC, content: timeoutClaimContent(),
    });
    host.onGroupMessage(GROUP_ID);

    await waitFor(async () => {
      const state = await serializedStateOf(host, session.sessionId);
      return state?.phase === 'finished';
    }, { label: 'claim reduced to terminal (red on main: stays playing)' });

    const state = await serializedStateOf(host, session.sessionId);
    assert.equal(state.phase, 'finished', '读侧必须与写侧同判：claim 生效、对局终局');
    assert.equal(state.result?.winner, 'black', '赢家是发 claim 的一方（黑）');
    assert.equal(state.result?.reason, 'timeout', '终局理由是 timeout');
  } finally {
    if (host) await host.runtime.dispose().catch(() => {});
    cleanup();
    uninstallFakeClock();
  }
});

test('反向护栏：claim 落在窗口内（100 s < 900 s）不得终局——归一不是一律 ×1000', { timeout: 40_000 }, async () => {
  installFakeClock(G3_CLAIM_SEC * 1000);
  let host = null;
  let cleanup = () => {};
  try {
    const built = buildHost({ llm: () => new Promise(() => {}) });
    host = built.host;
    cleanup = built.cleanup;

    const session = await seatBothSides(built.db, host, G3_ROW_SEC);
    const inWindowSec = G3_ROW_SEC + 100; // 距满座仅 100 s

    const claimRowIndex = insertRow(built.db, {
      pinId: 'timebase-row-4', senderGlobalMetaId: BLACK_AGENT,
      chainTimestamp: inWindowSec, content: timeoutClaimContent(),
    });
    host.onGroupMessage(GROUP_ID);

    await waitFor(() => host.store.getSession(session.sessionId).lastIndex >= claimRowIndex, { label: 'claim row consumed' });
    const state = await serializedStateOf(host, session.sessionId);
    assert.equal(state.phase, 'playing', '窗口内的 claim 必须被丢弃（不得假超时）');
    assert.equal(state.result, null, '未终局时 result 必须为空');
  } finally {
    if (host) await host.runtime.dispose().catch(() => {});
    cleanup();
    uninstallFakeClock();
  }
});
