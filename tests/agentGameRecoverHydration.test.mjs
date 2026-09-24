/**
 * GAP-5 回归：重启恢复路径必须先从持久化库水合真状态，ensureSandbox 不得
 * 用初始板覆盖库中已有对局（runtime.ts recover→ensureSandbox 预置
 * initialState，与 catchUp 从库水合的分叉点）。
 *
 * 缺口来源：G2/G3 重启恢复取证——宿主重启后内存 states 必空，recover() 先经
 * ensureSandbox 预置初始板，catchUp 的「仅当 map 为空才从库水合」永远轮空，
 * bot 从假盘面出子（与第三方重放发散）。真实裁判 adapter（与 convergence
 * 套件同一份字节级复制件）+ 两阶段真会话驱动：
 *  - 用例 1  重启→恢复→首条群消息到达：库中真状态（plies=1）必须存活，
 *            黑方 h9g7 折叠后红方从真局面（plies=2）续跑出子，stateHash
 *            与第三方全流重放一致。
 *  - 用例 2  库中 serialized_state 损坏：恢复语义 = 暂停 + 结构化
 *            state_corrupt，原样保留损坏 blob，绝不预置初始板落子；
 *            resume 同码拒绝。
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

/** 陈旧产物守卫（同 agentGame* 系列）：本套件对 gitignored 的 dist-electron
 *  编译产物跑回归。探针取 GAP-3b 修复特征（beforeSerialized），更旧产物 →
 *  显式红灯 + 重编译指引；GAP-5 红/绿判别由用例断言本身完成。 */
const DIST_RUNTIME_JS = path.join(projectRoot, 'dist-electron', 'main', 'agentGame', 'runtime.js');
(function assertFreshAgentGameDist() {
  let src;
  try {
    src = fs.readFileSync(DIST_RUNTIME_JS, 'utf8');
  } catch {
    throw new Error(`[stale-dist-guard] ${DIST_RUNTIME_JS} 不存在：先编译 electron 主进程（npx -p typescript@5 tsc --project electron-tsconfig.json && node scripts/copy-electron-js.cjs）再跑本套件`);
  }
  if (!src.includes('beforeSerialized')) {
    throw new Error('[stale-dist-guard] dist-electron/main/agentGame/runtime.js 缺 GAP-3b 修复特征（beforeSerialized，过旧产物）：请重编译后重跑');
  }
})();

setTimeout(() => {
  console.error('[suite-watchdog] 套件 180s 未结束：静默挂起（疑似 dist-electron 陈旧或资源竞争），强制 exit 1');
  process.exit(1);
}, 180_000).unref();

/** Minimal SqliteDatabase-shape adapter over node:sqlite (mirrors agentGameConvergence). */
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
/* 真实裁判 adapter fixture（与 agentGameConvergence 同源字节级复制件） */
/* ------------------------------------------------------------------ */

const STREAM = JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'tests', 'fixtures', 's1-first-game-polluted-stream.json'), 'utf8'),
);
const FIXTURE_ADAPTER_DIR = path.join(projectRoot, 'tests', 'fixtures', 'xiangqi-adapter');
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
/* Host harness（mirror agentGameConvergence；buildHost 支持共享 db）   */
/* ------------------------------------------------------------------ */

const { createAgentGameHost } = require('../dist-electron/main/agentGame/index.js');

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
          [`conv-pin-${rowSeq}-${Date.now()}-${Math.random().toString(36).slice(2)}`, gid, opts?.asAgentId ?? 'unknown', opts?.asAgentId ?? null, plaintext, Date.now(), nextIndex],
        );
      }
      return { pinId: `conv-pin-${calls.length}` };
    },
  };
}

function materializeJudgeAdapter() {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-game-gap5-'));
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
    manifestFetch: async () => JSON.parse(fs.readFileSync(path.join(artifactDir, 'game-manifest.json'), 'utf8')),
    adapterPathFor: async (_manifestUri, mf) => path.join(artifactDir, mf.adapter),
  };
}

/** db 缺省时新建并建表；传入共享 db（重启场景）时原样复用。 */
function buildHost({ db, llmText, llmComplete, insertRows = true } = {}) {
  const owned = !db;
  const theDb = db ?? new TestSqliteDb();
  if (owned) createAgentGameTables(theDb);
  const judge = materializeJudgeAdapter();
  const recorder = makeChainRecorder(theDb, STREAM.groupId, { insertRows });
  const host = createAgentGameHost({
    db: theDb,
    saveDb: () => {},
    llmComplete: llmComplete ?? (async () => ({ content: llmText })),
    chainWrite: recorder.chainWrite,
    manifestFetch: judge.manifestFetch,
    adapterPathFor: judge.adapterPathFor,
    resolveActor: () => RED_AGENT,
    actorNameFor: (id) => (id === RED_AGENT ? 'Builder阿码' : id === BLACK_AGENT ? 'AI_Sunny' : ''),
    log: () => {},
  });
  return {
    host, db: theDb, recorder,
    artifactDir: judge.artifactDir,
    cleanup: () => fs.rmSync(judge.artifactDir, { recursive: true, force: true }),
  };
}

function startParams(overrides = {}) {
  return {
    appId: 'gap5.v1',
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

function dbRows(db, maxIndex) {
  return db.exec(
    'SELECT msg_index, sender_global_metaid, chain_timestamp, content FROM group_chat_messages WHERE group_id = ? AND msg_index <= ? ORDER BY msg_index',
    [STREAM.groupId, maxIndex],
  )[0].values.map((v) => ({ msgIndex: v[0], senderGlobalMetaId: v[1], chainTimestamp: v[2], content: v[3] }));
}

/** 第三方裁判重放（mirror agentGameConvergence）：fresh adapter state + 逐行
 *  meta 折叠给定行（+可选额外事件），返回最终 serialized。 */
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

/** 模式驱动的假 LLM：从提示词内嵌的 action schema 里取第一个合法着法。
 *  重启后的走子必须基于水合后的真局面——固定文本在这里会掩盖盘面差异。 */
function schemaDrivenLlm(prompts) {
  return async (messages) => {
    const user = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    prompts.push(user);
    const m = user.match(/"legalMoves":\[([^\]]*)\]/);
    assert.ok(m, 'walk prompt must embed the adapter action schema with legalMoves');
    const moves = JSON.parse(`[${m[1]}]`);
    assert.ok(moves.length > 0, 'schema must offer at least one legal move');
    return { content: moves[0] };
  };
}

/** 局前史（两用例共用）：GAP-3a 同款最小前缀——match.created + 黑方
 *  seat.claimed 落库，红方会话入场走出 h2e2（plies=1 轮黑方）。 */
async function seedPrehistory(db) {
  insertRow(db, {
    pinId: 'gap5-pin-1', senderGlobalMetaId: RED_AGENT, msgIndex: 1, chainTimestamp: 1_000,
    content: envelopeOf('match.created', { eventId: 'row:mc:1', payload: { title: 'GAP-5 restart fixture' } }),
  });
  insertRow(db, {
    pinId: 'gap5-pin-2', senderGlobalMetaId: BLACK_AGENT, msgIndex: 2, chainTimestamp: 2_000,
    content: envelopeOf('seat.claimed', { eventId: 'row:sc:2', payload: { requestedRole: 'black', name: 'AI_Sunny' } }),
  });
  return { rows: dbRows(db, 99) };
}

test('GAP-5: 重启恢复先从库水合——初始板不得覆盖库中真状态，恢复后对局续跑', { timeout: 120_000 }, async () => {
  /* ---- Phase A：真会话走出前史（库中 plies=1，轮黑方）---- */
  const phaseA = buildHost({ llmText: 'h2e2' });
  const { db } = phaseA;
  let sessionId;
  try {
    await seedPrehistory(db);
    const session = await startSession(phaseA.host, startParams());
    sessionId = session.sessionId;
    await waitFor(
      () => phaseA.recorder.calls.filter((c) => JSON.parse(c.plaintext).type === 'action').length >= 1,
      { label: 'red seq1 action write' },
    );
    const truth = JSON.parse(phaseA.host.store.getSerializedState(sessionId));
    assert.equal(truth.plies, 1, '前史：红方 h2e2 已入账（plies=1）');
    assert.equal(truth.board.turn, 'black', '前史：轮黑方');
  } finally {
    await phaseA.host.runtime.dispose().catch(() => {});
  }

  /* ---- Phase B：重启——同库新建 runtime（内存 states 必空），红方恢复 ---- */
  const prompts = [];
  const phaseB = buildHost({ db, llmComplete: schemaDrivenLlm(prompts) });
  try {
    // ① 恢复：必须从库水合真状态，会话干净回到 running。
    await phaseB.host.recover();
    const view = await phaseB.host.handleSessionMethod('status', { sessionId }, RED_AGENT, {});
    assert.equal(view.status, 'running', '恢复后会话必须回到 running');
    assert.equal(view.lastError ?? null, null, '恢复不得留下错误');
    assert.equal(
      JSON.parse(phaseB.host.store.getSerializedState(sessionId)).plies, 1,
      '恢复后库中仍是真状态 plies=1（catchUp 无新消息早退，不得预置初始板）',
    );

    // ② 首条群消息：黑方 h9g7（第三方真实行，prevHash/stateHash 由裁判重放算出）。
    const rows14 = dbRows(db, 4);
    const preSerialized = await thirdPartyReplay(phaseB.artifactDir, rows14);
    const blackMove = {
      protocol: 'agent-game/1', gameId: GAME_ID, matchId: STREAM.groupId, rulesHash: RULES_HASH,
      type: 'action', eventId: `gap5-black:${crypto.randomUUID()}`, actionSeq: 2,
      prevStateHash: shaOf(preSerialized), stateHash: '',
      payload: { move: 'h9g7', note: 'gap5 injected black reply' },
    };
    const postBlack = await thirdPartyReplay(phaseB.artifactDir, rows14, [{ ...blackMove, __sender: BLACK_AGENT }]);
    assert.equal(JSON.parse(postBlack).plies, 2, 'fixture 自检：h9g7 必须被裁判接受（plies 1→2）');
    blackMove.stateHash = shaOf(postBlack);
    insertRow(db, {
      pinId: 'gap5-pin-5', senderGlobalMetaId: BLACK_AGENT, msgIndex: 5, chainTimestamp: 5_000,
      content: JSON.stringify(blackMove),
    });
    phaseB.host.onGroupMessage(STREAM.groupId);

    // ③ 续跑：红方基于真状态（plies=2）应手并被裁判接受 → plies=3。
    await waitFor(() => {
      const raw = phaseB.host.store.getSerializedState(sessionId);
      return raw !== null && JSON.parse(raw).plies >= 3
        && phaseB.recorder.calls.some((c) => JSON.parse(c.plaintext).type === 'action');
    }, { label: 'red post-restart action' });
    const after = JSON.parse(phaseB.host.store.getSerializedState(sessionId));
    assert.equal(after.plies, 3, '恢复后黑方 h9g7 + 红方应手必须把真状态推进到 plies=3（基线缺陷：初始板覆盖 → plies 回落）');
    assert.equal(after.board.turn, 'black', '红方应手后必须轮黑方');

    // ④ 走子提示词必须看到真局面（plies=2），不是初始板（plies=0）。
    const movePrompt = prompts.find((p) => p.includes('"plies":2'));
    assert.ok(movePrompt, '恢复后的走子 LLM 提示词必须基于水合后的真状态 plies=2（基线缺陷会看到初始板 plies=0）');

    // ⑤ 红方事件与第三方全流重放一致（S1 判据 3 的恢复版）。
    const actionEvent = phaseB.recorder.calls.map((c) => JSON.parse(c.plaintext)).find((e) => e.type === 'action');
    assert.equal(actionEvent.actionSeq, 3, '恢复后红方续走必须是 seq3（1 h2e2 + 2 h9g7 之后）');
    const allRows = dbRows(db, 99);
    const postSerialized = await thirdPartyReplay(phaseB.artifactDir, allRows, [{ ...actionEvent, __sender: RED_AGENT }]);
    assert.equal(JSON.parse(postSerialized).plies, 3, '第三方重放必须收敛 plies=3');
    assert.equal(actionEvent.stateHash, shaOf(postSerialized), '恢复后红方动作的 stateHash 必须与第三方全流重放一致');
  } finally {
    await phaseB.host.runtime.dispose().catch(() => {});
    phaseB.cleanup();
    phaseA.cleanup();
  }
});

test('GAP-5: 库中状态损坏——恢复暂停并报 state_corrupt，不预置初始板、不落子', { timeout: 120_000 }, async () => {
  /* ---- Phase A：真会话走出前史（库中 plies=1）---- */
  const phaseA = buildHost({ llmText: 'h2e2' });
  const { db } = phaseA;
  let sessionId;
  try {
    await seedPrehistory(db);
    const session = await startSession(phaseA.host, startParams());
    sessionId = session.sessionId;
    await waitFor(
      () => phaseA.recorder.calls.filter((c) => JSON.parse(c.plaintext).type === 'action').length >= 1,
      { label: 'red seq1 action write' },
    );
  } finally {
    await phaseA.host.runtime.dispose().catch(() => {});
  }

  // 模拟库损坏：serialized_state 写成非法 JSON（截断）。
  const corruptBlob = '{"plies":1,"board":{"turn":"blac';
  db.run('UPDATE agent_game_sessions SET serialized_state = ? WHERE session_id = ?', [corruptBlob, sessionId]);

  /* ---- Phase B：重启恢复撞上损坏库 ---- */
  const llmCalls = [];
  const phaseB = buildHost({
    db,
    llmComplete: async (messages) => { llmCalls.push(messages); return { content: 'h2e2' }; },
  });
  try {
    await phaseB.host.recover();
    const view = await phaseB.host.handleSessionMethod('status', { sessionId }, RED_AGENT, {});
    assert.equal(view.status, 'paused', '损坏状态必须暂停（不得带着伪造盘面续跑）');
    const row = db.exec('SELECT last_error, serialized_state FROM agent_game_sessions WHERE session_id = ?', [sessionId])[0].values[0];
    const lastError = JSON.parse(row[0]);
    assert.equal(lastError.code, 'state_corrupt', `lastError 必须带结构化 state_corrupt 码，实际 ${lastError.code}`);
    assert.equal(row[1], corruptBlob, '损坏 blob 必须原样保留（不得被初始板覆盖）');
    assert.equal(llmCalls.length, 0, '不得基于伪造盘面调用 LLM 落子');

    // resume 同码拒绝（结构化错误透传 RPC 面），会话保持暂停。
    const resumed = await phaseB.host.handleSessionMethod('resume', { sessionId }, RED_AGENT, {});
    assert.equal(resumed.__error, true, 'resume 必须拒绝');
    assert.equal(resumed.code, 'state_corrupt', 'resume 拒绝必须透传 state_corrupt 码');
    const after = db.exec('SELECT status, serialized_state FROM agent_game_sessions WHERE session_id = ?', [sessionId])[0].values[0];
    assert.equal(after[0], 'paused', 'resume 拒绝后会话保持 paused');
    assert.equal(after[1], corruptBlob, 'resume 拒绝后损坏 blob 仍原样保留');
    assert.equal(llmCalls.length, 0, 'resume 拒绝路径也不得调用 LLM');
  } finally {
    await phaseB.host.runtime.dispose().catch(() => {});
    phaseB.cleanup();
    phaseA.cleanup();
  }
});
