/**
 * Agent-Game 收敛机制三缺口回归（924-2 首局真实数据驱动）。
 *
 * 缺口来源：S1 首局全自主对局证据档案（S1-first-game-evidence.md，owner 拍板
 * 批准三项宿主修复）。本套件逐项锁定：
 *  - GAP-1  groupChatBackfillService 落库不触发 groupMessageInsertedHook →
 *           经回填恢复的新群历史永远到不了 agentGame runtime（只有 WS 路径唤醒）。
 *  - GAP-3a 写前 draft reduce 无归因（docs/07 §2 归因靠 row meta.senderMetaId）
 *           → adapter 无法把动作归到本方席位 → draft 恒 no-op → 事件烙下
 *           stateHash == prevStateHash → 第三方重放全部拒绝 → 同着法无限再生。
 *  - GAP-3b lastActionSeq 按流计数（非法/被拒事件也推进期望值）→ 后续动作
 *           seq 全部偏离 adapter 连续性 → 第三方收敛永久卡死（924-2 实测：
 *           黑方 lastActionSeq=12 而流只收敛 plies=1）。
 *
 * 真实用例与裁判：
 *  - tests/fixtures/s1-first-game-polluted-stream.json = 924-2 首局组C 的
 *    15 行真实链上事件流（idbots.sqlite group c7b209fe…，msg_index 1..15：
 *    match.created + 双方 seat.claimed + 12 action；第三方确定性重放收敛
 *    plies=1 turn=black，12 动作中仅 seq1 被 adapter 接受）。
 *  - tests/fixtures/xiangqi-adapter/ = 裁判 adapter，字节级复制自
 *    llm-play-chinese-chess main（70eb722+66e0d95 修复后），agent-game/adapter.js
 *    sha256 = eabf1f423c869f91ef9c755e95d61e97ad32189e87a910b4bdfee4678c664a5e，
 *    即首局 v1.0.2 游戏包的同一份裁判代码（PROVENANCE.md）。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

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

/** 陈旧产物守卫（同 agentGame* 系列）：本套件对 gitignored 的 dist-electron
 *  编译产物跑回归。探针标识符取自三项修复新引入的代码（beforeSerialized =
 *  GAP-3b 变更检测的局部变量），旧产物缺失特征 → 显式红灯 + 重编译指引。 */
const DIST_RUNTIME_JS = path.join(projectRoot, 'dist-electron', 'main', 'agentGame', 'runtime.js');
(function assertFreshAgentGameDist() {
  let src;
  try {
    src = fs.readFileSync(DIST_RUNTIME_JS, 'utf8');
  } catch {
    throw new Error(`[stale-dist-guard] ${DIST_RUNTIME_JS} 不存在：先编译 electron 主进程（pnpm run compile:electron）再跑本套件`);
  }
  if (!process.env.AGENT_GAME_CONVERGENCE_ALLOW_STALE_DIST && !src.includes('beforeSerialized')) {
    throw new Error('[stale-dist-guard] dist-electron/main/agentGame/runtime.js 缺 GAP-3b 修复特征（beforeSerialized，旧产物）：请重编译（pnpm run compile:electron）后重跑');
  }
})();

setTimeout(() => {
  console.error('[suite-watchdog] 套件 120s 未结束：静默挂起（疑似 dist-electron 陈旧或资源竞争），强制 exit 1');
  process.exit(1);
}, 120_000).unref();

/** Minimal SqliteDatabase-shape adapter over node:sqlite (mirrors agentGameSeatClaim). */
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
/* 924-2 真实污染流 + 真实裁判 adapter fixtures                       */
/* ------------------------------------------------------------------ */

const STREAM = JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'tests', 'fixtures', 's1-first-game-polluted-stream.json'), 'utf8'),
);
const FIXTURE_ADAPTER_DIR = path.join(projectRoot, 'tests', 'fixtures', 'xiangqi-adapter');
/** 字节级复制件的哈希必须始终等于首局 v1.0.2 裁判哈希（防 fixture 漂移）。 */
const JUDGE_ADAPTER_SHA256 = 'eabf1f423c869f91ef9c755e95d61e97ad32189e87a910b4bdfee4678c664a5e';
{
  const actual = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(FIXTURE_ADAPTER_DIR, 'agent-game', 'adapter.js')))
    .digest('hex');
  assert.equal(actual, JUDGE_ADAPTER_SHA256, '裁判 adapter fixture 漂移：agent-game/adapter.js sha256 不再等于 v1.0.2 游戏包哈希');
}

const GAME_ID = 'xiangqi';
const RED_AGENT = STREAM.redAgentId;
const BLACK_AGENT = STREAM.rows[2].senderGlobalMetaId; // row3 = black seat.claimed
const RULES_HASH = JSON.parse(STREAM.rows[0].content).rulesHash;

/* ------------------------------------------------------------------ */
/* Host harness（mirror agentGameSeatClaim）                          */
/* ------------------------------------------------------------------ */

const { createAgentGameHost } = require('../dist-electron/main/agentGame/index.js');

/** chainWrite 录制器：记录每次链写；insertRows=true 时同步把事件作为
 *  group_chat_messages 新行落库（模拟链上落定 + WS 唤醒通路之外的存量行）。 */
function makeChainRecorder(db, groupId, { insertRows = true } = {}) {
  const calls = [];
  let rowSeq = 0;
  return {
    calls,
    async chainWrite(gid, plaintext, opts) {
      calls.push({ groupId: gid, plaintext, opts: opts ?? null });
      if (insertRows) {
        rowSeq += 1;
        const maxRow = db.exec('SELECT COALESCE(MAX(msg_index), 0) FROM group_chat_messages WHERE group_id = ?', [gid]);
        const nextIndex = Number(maxRow[0]?.values?.[0]?.[0] ?? 0) + 1;
        db.run(
          `INSERT INTO group_chat_messages
            (pin_id, group_id, sender_metaid, sender_global_metaid, protocol, content, encryption, chain_timestamp, msg_index)
           VALUES (?, ?, ?, ?, 'simplegroupchat', ?, '', ?, ?)`,
          [`conv-pin-${rowSeq}`, gid, opts?.asAgentId ?? 'unknown', opts?.asAgentId ?? null, plaintext, Date.now(), nextIndex],
        );
      }
      return { pinId: `conv-pin-${calls.length}` };
    },
  };
}

/** 把 fixture 裁判 adapter 复制进临时 artifact 目录（保持 ../js 相对布局），
 *  返回 manifest + adapterPathFor 依赖。 */
function materializeJudgeAdapter() {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-game-judge-'));
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
    adapterHash: `sha256:${JUDGE_ADAPTER_SHA256}`,
    turnModel: 'sequential',
    informationModel: 'public',
    maxPlayers: 2,
  };
  fs.writeFileSync(path.join(artifactDir, 'game-manifest.json'), JSON.stringify(manifest));
  return {
    artifactDir,
    manifest,
    manifestFetch: async () => JSON.parse(fs.readFileSync(path.join(artifactDir, 'game-manifest.json'), 'utf8')),
    adapterPathFor: async (_manifestUri, mf) => path.join(artifactDir, mf.adapter),
  };
}

function buildHost({ llmText, insertRows = true } = {}) {
  const db = new TestSqliteDb();
  createAgentGameTables(db);
  const judge = materializeJudgeAdapter();
  const recorder = makeChainRecorder(db, STREAM.groupId, { insertRows });
  const host = createAgentGameHost({
    db,
    saveDb: () => {},
    llmComplete: async () => ({ content: llmText }),
    chainWrite: recorder.chainWrite,
    manifestFetch: judge.manifestFetch,
    adapterPathFor: judge.adapterPathFor,
    resolveActor: () => RED_AGENT,
    actorNameFor: (id) => (id === RED_AGENT ? 'Builder阿码' : id === BLACK_AGENT ? 'AI_Sunny' : ''),
    log: () => {},
  });
  return { host, db, recorder, artifactDir: judge.artifactDir, cleanup: () => fs.rmSync(judge.artifactDir, { recursive: true, force: true }) };
}

function startParams(overrides = {}) {
  return {
    appId: 'convergence.v1',
    sessionType: 'agent-game',
    groupId: STREAM.groupId,
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

/** 两阶段 start：phase1 确认卡 → phase2 建会话（同一 resourceUri，失败即断言失败）。 */
async function startSession(host, params) {
  const resourceUri = `metaapp://confirm-${Math.random().toString(36).slice(2)}`;
  const phaseOne = await host.handleSessionMethod('start', params, params.agentId, { resourceUri });
  assert.equal(phaseOne.manualAction, true, 'phase 1 must issue a confirmation');
  const session = await host.handleSessionMethod('start', phaseOne.confirmRequest.payload, params.agentId, { resourceUri });
  assert.equal(session.__error || false, false, `phase 2 failed: ${session.code} ${session.message}`);
  return session;
}

async function waitFor(predicate, { timeoutMs = 15_000, stepMs = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

function insertRow(db, { pinId, groupId = STREAM.groupId, senderGlobalMetaId, msgIndex, chainTimestamp, content }) {
  db.run(
    `INSERT INTO group_chat_messages
      (pin_id, group_id, sender_metaid, sender_global_metaid, protocol, content, encryption, chain_timestamp, msg_index)
     VALUES (?, ?, ?, ?, 'simplegroupchat', ?, 'aes', ?, ?)`,
    [pinId, groupId, 'legacy-metaid', senderGlobalMetaId, content, chainTimestamp, msgIndex],
  );
}

/** envelopeOf：合成 agent-game/1 事件行（GAP-3a 用例的最小前缀流）。 */
function envelopeOf(type, extra = {}) {
  return JSON.stringify({
    protocol: 'agent-game/1',
    gameId: GAME_ID,
    matchId: STREAM.groupId,
    rulesHash: RULES_HASH,
    type,
    eventId: `row:${type}:${Math.random().toString(36).slice(2)}`,
    ...extra,
  });
}

async function loadJudgeAdapter(artifactDir) {
  return import(pathToFileURL(path.join(artifactDir, 'agent-game', 'adapter.js')).href);
}

const shaOf = (serialized) => `sha256:${crypto.createHash('sha256').update(serialized).digest('hex')}`;

/** 第三方裁判重放：fresh adapter state + 逐行 meta（index/senderMetaId/timestamp）
 *  折叠给定行（+可选额外事件），返回最终 serialized（规范化字符串）。 */
async function thirdPartyReplay(artifactDir, rows, extraEvents = []) {
  const adapter = await loadJudgeAdapter(artifactDir);
  let state = adapter.initialState({ gameId: GAME_ID, seat: 'red' });
  for (const row of rows) {
    const env = JSON.parse(row.content ?? row.raw);
    state = adapter.reduce(state, {
      ...env,
      meta: { index: row.msgIndex, senderMetaId: row.senderGlobalMetaId, timestamp: row.chainTimestamp },
    });
  }
  let seq = rows.length ? Math.max(...rows.map((r) => r.msgIndex)) : 0;
  for (const event of extraEvents) {
    seq += 1;
    state = adapter.reduce(state, {
      ...event,
      meta: { index: seq, senderMetaId: event.__sender, timestamp: Date.now() },
    });
  }
  return adapter.serializeState(state);
}

test('GAP-3a: 写前 draft 按会话身份归因——链上 body 无 meta、stateHash 真推进、与第三方重放一致', { timeout: 40_000 }, async () => {
  const { host, db, recorder, artifactDir, cleanup } = buildHost({ llmText: 'h2e2' });
  try {
    // 前缀流：match.created（红方发起）+ 黑方 seat.claimed（真实身份）。
    insertRow(db, {
      pinId: 'gap3a-pin-1', senderGlobalMetaId: RED_AGENT, msgIndex: 1, chainTimestamp: 1_000,
      content: envelopeOf('match.created', { eventId: 'row:mc:1', payload: { title: 'GAP-3a fixture' } }),
    });
    insertRow(db, {
      pinId: 'gap3a-pin-2', senderGlobalMetaId: BLACK_AGENT, msgIndex: 2, chainTimestamp: 2_000,
      content: envelopeOf('seat.claimed', { eventId: 'row:sc:2', payload: { requestedRole: 'black', name: 'AI_Sunny' } }),
    });

    const session = await startSession(host, startParams());

    // 等 red 的动作事件上链（第 1 笔是我们自己的 seat.claimed）。
    await waitFor(() => recorder.calls.filter((c) => JSON.parse(c.plaintext).type === 'action').length >= 1, { label: 'action write' });
    const actionCall = recorder.calls.find((c) => JSON.parse(c.plaintext).type === 'action');
    const event = JSON.parse(actionCall.plaintext);

    // ① docs/07 §2：归因元数据只走 row meta——链上 body 不得携带 meta。
    assert.equal(Object.prototype.hasOwnProperty.call(event, 'meta'), false, 'action 事件 body 不得携带 meta 字段');
    assert.equal(event.type, 'action');
    assert.equal(event.actionSeq, 1);

    // ② GAP-3a 核心：draft reduce 携带 senderMetaId 后 stateHash 必须真推进
    //    （基线缺陷：adapter 归因不到席位 → draft 恒 no-op → stateHash==prevStateHash）。
    assert.notEqual(event.stateHash, event.prevStateHash, 'stateHash 不得等于 prevStateHash（draft reduce 必须 true 推进）');

    // ③ 与第三方重放一致：rows1-3 重放哈希 == prevStateHash；再折疊本事件后
    //    哈希 == stateHash（首局组C 的 seq1 就是死在这条判据上）。
    const storedRows = db.exec(
      'SELECT msg_index, sender_global_metaid, chain_timestamp, content FROM group_chat_messages WHERE group_id = ? AND msg_index <= 3 ORDER BY msg_index',
      [STREAM.groupId],
    )[0].values.map((v) => ({ msgIndex: v[0], senderGlobalMetaId: v[1], chainTimestamp: v[2], content: v[3] }));
    const preSerialized = await thirdPartyReplay(artifactDir, storedRows);
    assert.equal(event.prevStateHash, shaOf(preSerialized), 'prevStateHash 必须等于第三方对前缀流的重放哈希');
    const postSerialized = await thirdPartyReplay(artifactDir, storedRows, [{ ...event, __sender: RED_AGENT }]);
    assert.equal(event.stateHash, shaOf(postSerialized), 'stateHash 必须等于第三方折疊本事件后的重放哈希');

    // ④ 落库即推进本地状态（消除「同着法无限再生」窗口）+ 期望 seq 前进。
    const view = await host.handleSessionMethod('status', { sessionId: session.sessionId }, RED_AGENT, {});
    assert.equal(view.lastActionSeq, 1);
    // store 里是 JSON.stringify(原始状态对象)（adapter 规范化串只用于哈希）。
    const stored = JSON.parse(host.store.getSerializedState(session.sessionId));
    assert.equal(stored.plies, 1, '动作提交后本地状态必须立即推进（post-write reduce 按身份归因）');
    assert.equal(stored.board.turn, 'black');
  } finally {
    await host.runtime.dispose().catch(() => {});
    cleanup();
  }
});

test('GAP-3b: 15 行真实污染流收敛——期望 seq 只按 adapter 接受的动作推进，黑方续走 seq=2 而非 13', { timeout: 40_000 }, async () => {
  const { host, db, recorder, artifactDir, cleanup } = buildHost({ llmText: 'h9g7' });
  try {
    // 逐字落盘 924-2 组C 的 15 行真实链上流（content 字节不改动）。
    for (const row of STREAM.rows) {
      insertRow(db, {
        pinId: `s1-pin-${row.msgIndex}`, senderGlobalMetaId: row.senderGlobalMetaId,
        msgIndex: row.msgIndex, chainTimestamp: row.chainTimestamp, content: row.content,
      });
    }

    // 黑方会话入场（流中 seats.black.metaId == BLACK_AGENT）：收敛后轮到黑方。
    const session = await startSession(host, startParams({ seat: 'black', agentId: BLACK_AGENT }));

    // 等黑方真实的下一手动作上链。
    await waitFor(() => recorder.calls.filter((c) => JSON.parse(c.plaintext).type === 'action').length >= 1, { label: 'black action write' });
    const actionCall = recorder.calls.find((c) => JSON.parse(c.plaintext).type === 'action');
    const event = JSON.parse(actionCall.plaintext);

    // ① GAP-3b 核心：污染流里 adapter 只接受了 seq1（plies=1），被拒的
    //    seq2..12 不得推进期望值 → 黑方续走必须是 seq2（基线缺陷会带出 13）。
    assert.equal(event.actionSeq, 2, `黑方续走 actionSeq 必须是 2（基线按流计数会再生出 13），实际 ${event.actionSeq}`);
    assert.equal(event.payload?.move, 'h9g7');

    // ② 会话期望 seq 与第三方收敛视图一致。
    const view = await host.handleSessionMethod('status', { sessionId: session.sessionId }, BLACK_AGENT, {});
    assert.equal(view.lastActionSeq, 2);

    // ③ 第三方裁判：15 行污染流 + 我方 claim + seq2 动作 → plies=2 轮红方，
    //    且哈希链与黑方烙下的 stateHash 一致（GAP-3a 修复让新事件可被重放接受）。
    assert.notEqual(event.stateHash, event.prevStateHash, '新动作的 stateHash 必须真推进（GAP-3a 联动）');
    const storedRows = db.exec(
      'SELECT msg_index, sender_global_metaid, chain_timestamp, content FROM group_chat_messages WHERE group_id = ? AND msg_index <= 16 ORDER BY msg_index',
      [STREAM.groupId],
    )[0].values.map((v) => ({ msgIndex: v[0], senderGlobalMetaId: v[1], chainTimestamp: v[2], content: v[3] }));
    const postSerialized = await thirdPartyReplay(artifactDir, storedRows, [{ ...event, __sender: BLACK_AGENT }]);
    const post = JSON.parse(postSerialized);
    assert.equal(post.plies, 2, '第三方重放必须收敛 plies=2');
    assert.equal(post.turn, 'red', '第三方重放后必须轮到红方');
    assert.equal(event.stateHash, shaOf(postSerialized), '黑方烙下的 stateHash 必须与第三方重放一致');
  } finally {
    await host.runtime.dispose().catch(() => {});
    cleanup();
  }
});

test('GAP-1: group chat backfill 落库唤醒 agentGame hook；零插入不空唤醒', { timeout: 30_000 }, async () => {
  // 惰性 require：让 GAP-3a/3b 用例在基线（未修复产物）上也能独立跑出断言红，
  // 本用例对缺失导出报显式 TypeError 红。
  const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
  const {
    createGroupChatBackfillLoop,
    setGroupChatBackfillActiveGroupIdsGetter,
  } = require('../dist-electron/main/services/groupChatBackfillService.js');
  const {
    setGroupMessageInsertedHook,
    notifyGroupMessageInserted,
  } = require('../dist-electron/main/services/metaWebListenerService.js');

  const GROUP_ID = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000i0';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-gap1-backfill-'));
  const store = await SqliteStore.create(tempDir);
  try {
    const historyItem = (index) => ({
      index,
      txId: `tx-gap1-${index}`,
      pinId: `tx-gap1-${index}-i0`,
      groupId: GROUP_ID,
      channelId: '',
      metaId: `metaid-${index}`,
      globalMetaId: `gmid-${index}`,
      address: 'mvc-addr',
      nickName: 'SenderNick',
      userInfo: { name: 'Sender Name' },
      protocol: '/protocols/simplegroupchat',
      content: `backfill message ${index}`,
      contentType: 'text/plain',
      encryption: '',
      chatType: 0,
      replyPin: '',
      mention: [],
      timestamp: 1_785_000_000_000 + index,
      chain: 'mvc',
    });
    const pageEnvelope = (list) => ({ code: 0, data: { list } });
    const fetchJson = async () => pageEnvelope([historyItem(0), historyItem(1)]);

    const wakes = [];
    setGroupMessageInsertedHook((groupId) => wakes.push(groupId));
    setGroupChatBackfillActiveGroupIdsGetter(() => [GROUP_ID]);
    const loop = createGroupChatBackfillLoop({ db: store.getDatabase(), saveDb: () => {}, fetchJson, emitLog: () => {} });

    // 首轮：2 行落库 → 必须唤醒一次（新群历史经回填也能到 runtime，GAP-1）。
    const first = await loop.syncOnce();
    assert.equal(first.inserted, 2);
    assert.deepEqual(wakes, [GROUP_ID], 'backfill 落库后必须触发 groupMessageInserted hook');

    // 复跑：INSERT OR IGNORE 幂等，零插入 → 不得空唤醒（不制造噪声 tick）。
    const second = await loop.syncOnce();
    assert.equal(second.inserted, 0);
    assert.equal(wakes.length, 1, '零插入不得触发 hook');

    // WS 路径同槽位：显式 notify 也到达（单钩子双通路汇聚）。
    notifyGroupMessageInserted(GROUP_ID);
    assert.deepEqual(wakes, [GROUP_ID, GROUP_ID]);
  } finally {
    setGroupMessageInsertedHook(null);
    try {
      store.close();
    } catch { /* already closed */ }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
