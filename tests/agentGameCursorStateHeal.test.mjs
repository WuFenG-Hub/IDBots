/**
 * 缺口修复二回归：状态游标脱钩的自愈与拒绝（GAP-5 家族变种）。
 *
 * 缺口来源（G2 作废局黑席取证）：黑席呈「持久化态=裸初始板而游标 idx=19
 * 已消费全史」且全程无 audit 无日志。形成面有二：
 *  ① catchUp 在无 sandbox / 无 state 时照常消费消息并推进 lastIndex——
 *     游标越过状态从未见过的事件；
 *  ② ensureSandbox 在恢复路径对无库态会话预置 initialState——裸板被盖上
 *     合法戳，与已推进的游标永久脱钩（bot 从假盘面出子）。
 *
 * 修复语义（本套件逐项锁定）：
 *  - 用例 1  裸板+已推进游标（G2 黑席原形）重启恢复：状态必须从群史全量
 *            重放自愈（与第三方重放全等），宿主下一手 prevStateHash 必须
 *            等于真盘哈希——绝不允许从裸板出子。（红基线：main 上恢复后
 *            停在 waiting 假盘，永不出子。）
 *  - 用例 2  无 sandbox 消费面封死：群消息在 recover 之前到达（onGroupMessage
 *            直通 catchUp、sandbox 未载）不得推进游标——消息留待恢复后折叠。
 *            （红基线：main 上游标被空推进到 5。）
 *  - 用例 3  库态损坏（不可解析）维持 state_corrupt 拒绝语义——自愈不得
 *            吞并既有 GAP-5 合同。
 *  - 用例 4  健康库态重启不受自愈扰动：prevStateHash 与真盘一致（回归护栏）。
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

/** 陈旧产物守卫：探针 = catchUp 全量重放自愈特征（本修复引入）。 */
const DIST_RUNTIME_JS = path.join(projectRoot, 'dist-electron', 'main', 'agentGame', 'runtime.js');
(function assertFreshAgentGameDist() {
  let src;
  try {
    src = fs.readFileSync(DIST_RUNTIME_JS, 'utf8');
  } catch {
    throw new Error(`[stale-dist-guard] ${DIST_RUNTIME_JS} 不存在：先编译（pnpm run compile:electron）再跑本套件`);
  }
  if (!src.includes('full-replay self-heal')) {
    throw new Error('[stale-dist-guard] dist-electron/main/agentGame/runtime.js 缺游标脱钩自愈特征（full-replay self-heal，旧产物）：请重编译后重跑');
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
    session_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'paused',
    app_id TEXT NOT NULL, group_id TEXT NOT NULL, game_id TEXT NOT NULL,
    agent_id TEXT NOT NULL, seat TEXT NOT NULL, rules_hash TEXT NOT NULL,
    adapter_hash TEXT NOT NULL, manifest_uri TEXT NOT NULL, protocol_paths TEXT,
    budget_llm_calls INTEGER NOT NULL DEFAULT 0, budget_llm_calls_used INTEGER NOT NULL DEFAULT 0,
    budget_writes INTEGER NOT NULL DEFAULT 0, budget_writes_used INTEGER NOT NULL DEFAULT 0,
    last_index INTEGER, last_action_seq INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    expires_at INTEGER NOT NULL DEFAULT 0, consent TEXT, lease_id TEXT, lease_expires_at INTEGER,
    serialized_state TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_game_grants (
    resource_uri TEXT NOT NULL, actor_id TEXT NOT NULL, app_id TEXT NOT NULL,
    group_id TEXT NOT NULL, game_id TEXT NOT NULL, rules_hash TEXT NOT NULL,
    adapter_hash TEXT NOT NULL, seat TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    ttl_ms INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL DEFAULT 0,
    budget_llm_calls INTEGER NOT NULL DEFAULT 0, budget_writes INTEGER NOT NULL DEFAULT 0,
    protocol_paths TEXT, revoked_at INTEGER, reason TEXT, created_at INTEGER NOT NULL,
    PRIMARY KEY (resource_uri, actor_id, app_id, group_id, game_id, rules_hash, adapter_hash, seat)
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_game_write_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL, action_seq INTEGER NOT NULL,
    event_id TEXT NOT NULL, session_id TEXT NOT NULL, pin_id TEXT, tx_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE (group_id, action_seq, event_id)
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_game_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, session_id TEXT,
    actor_id TEXT, fields TEXT, ts INTEGER NOT NULL
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS group_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pin_id TEXT UNIQUE NOT NULL, tx_id TEXT,
    group_id TEXT NOT NULL, channel_id TEXT, sender_metaid TEXT NOT NULL,
    sender_global_metaid TEXT, sender_address TEXT, sender_name TEXT, sender_avatar TEXT,
    sender_chat_pubkey TEXT, protocol TEXT NOT NULL, content TEXT, content_type TEXT,
    encryption TEXT, reply_pin TEXT, mention TEXT, chain_timestamp INTEGER, chain TEXT,
    raw_data TEXT, is_processed INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
  );`);
  db.exec(`ALTER TABLE group_chat_messages ADD COLUMN msg_index INTEGER;`);
}

const GAME_ID = 'xiangqi';
const GROUP_ID = '2ded670e303afcdfd93de13930dbab485b76950aef07b6310d8ca92f318209bfi0';
const RED_AGENT = 'idq1winred000000000000000000000000000000000000000000000red000';
const BLACK_AGENT = 'idq1winblack000000000000000000000000000000000000000000black00';
const RULES_HASH = 'sha256:cursor-heal-rules-hash';

const FIXTURE_ADAPTER_DIR = path.join(projectRoot, 'tests', 'fixtures', 'xiangqi-adapter');
const JUDGE_ADAPTER_SHA256 = 'eabf1f423c869f91ef9c755e95d61e97ad32189e87a910b4bdfee4678c664a5e';
{
  const actual = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(FIXTURE_ADAPTER_DIR, 'agent-game', 'adapter.js')))
    .digest('hex');
  assert.equal(actual, JUDGE_ADAPTER_SHA256, '裁判 adapter fixture 漂移');
}

const { createAgentGameHost } = require('../dist-electron/main/agentGame/index.js');

const shaOf = (serialized) => `sha256:${crypto.createHash('sha256').update(serialized).digest('hex')}`;

function materializeJudgeAdapter() {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-game-heal-'));
  fs.mkdirSync(path.join(artifactDir, 'agent-game'), { recursive: true });
  fs.mkdirSync(path.join(artifactDir, 'js'), { recursive: true });
  for (const rel of ['agent-game/adapter.js', 'js/notation.js', 'js/rules.js']) {
    fs.copyFileSync(path.join(FIXTURE_ADAPTER_DIR, rel), path.join(artifactDir, rel));
  }
  fs.writeFileSync(path.join(artifactDir, 'package.json'), JSON.stringify({ type: 'module' }));
  const manifest = {
    protocol: 'agent-game/1', gameId: GAME_ID, rulesVersion: '1.0.0',
    adapter: './agent-game/adapter.js', adapterHash: `sha256:${JUDGE_ADAPTER_SHA256}`,
    turnModel: 'sequential', informationModel: 'public', maxPlayers: 2,
  };
  fs.writeFileSync(path.join(artifactDir, 'game-manifest.json'), JSON.stringify(manifest));
  return {
    artifactDir,
    manifestFetch: async () => JSON.parse(fs.readFileSync(path.join(artifactDir, 'game-manifest.json'), 'utf8')),
    adapterPathFor: async (_manifestUri, mf) => path.join(artifactDir, mf.adapter),
  };
}

async function loadJudgeAdapter(artifactDir) {
  return import(pathToFileURL(path.join(artifactDir, 'agent-game', 'adapter.js')).href);
}

/**
 * 造一条哈希链正确的真局史（5 行）：match.created → 红占座 → 黑占座 →
 * 红动作 seq1 h2e2 → 黑动作 seq2 h9g7。折叠方式与第三方重放逐字节一致
 * （行 meta: index/senderMetaId/timestamp）。返回真盘（plies=2，红行棋）的
 * 状态对象与 canonical 序列化。
 */
async function insertTrueHistory(db, artifactDir) {
  const adapter = await loadJudgeAdapter(artifactDir);
  let state = adapter.initialState({ gameId: GAME_ID, seat: 'red' });
  const ts = Date.now();
  let idx = 0;

  const fold = async (env, sender) => {
    idx += 1;
    const content = JSON.stringify(env);
    db.run(
      `INSERT INTO group_chat_messages (pin_id, group_id, sender_metaid, sender_global_metaid, protocol, content, encryption, chain_timestamp, msg_index)
       VALUES (?, ?, 'legacy-metaid', ?, 'simplegroupchat', ?, 'aes', ?, ?)`,
      [`heal-row-${idx}`, GROUP_ID, sender, content, ts + idx, idx],
    );
    state = await adapter.reduce(state, { ...env, meta: { index: idx, senderMetaId: sender, timestamp: ts + idx } });
    return env;
  };

  const base = (type, extra = {}) => ({
    protocol: 'agent-game/1', gameId: GAME_ID, matchId: GROUP_ID, rulesHash: RULES_HASH,
    type, eventId: `heal:${type}:${Math.random().toString(36).slice(2)}`, ...extra,
  });

  await fold(base('match.created', { payload: { title: 'cursor heal regression' } }), RED_AGENT);
  await fold(base('seat.claimed', { payload: { requestedRole: 'red' } }), RED_AGENT);
  await fold(base('seat.claimed', { payload: { requestedRole: 'black' } }), BLACK_AGENT);

  // 红动作 seq1：prevStateHash=折前哈希，stateHash=折后哈希（与 runtime 落子同构）。
  const pre1 = await adapter.serializeState(state);
  const env1 = base('action', {
    actionSeq: 1,
    prevStateHash: shaOf(pre1),
    stateHash: '',
    payload: { move: 'h2e2' },
  });
  const post1 = await adapter.serializeState(await adapter.reduce(state, { ...env1, meta: { index: idx + 1, senderMetaId: RED_AGENT, timestamp: ts } }));
  env1.stateHash = post1;
  await fold(env1, RED_AGENT);

  // 黑动作 seq2。
  const pre2 = await adapter.serializeState(state);
  const env2 = base('action', {
    actionSeq: 2,
    prevStateHash: shaOf(pre2),
    stateHash: '',
    payload: { move: 'h9g7' },
  });
  const finalState = await adapter.reduce(state, { ...env2, meta: { index: idx + 1, senderMetaId: BLACK_AGENT, timestamp: ts } });
  env2.stateHash = await adapter.serializeState(finalState);
  await fold(env2, BLACK_AGENT);

  return {
    lastIndex: idx,
    trueFinalState: finalState,
    trueFinalSerialized: await adapter.serializeState(finalState),
    bareInitialState: adapter.initialState({ gameId: GAME_ID, seat: 'red' }),
  };
}

function buildHost({ llm }) {
  const db = new TestSqliteDb();
  createAgentGameTables(db);
  const judge = materializeJudgeAdapter();
  const recorder = makeRecorder(db);
  const host = createAgentGameHost({
    db,
    saveDb: () => {},
    llmComplete: llm,
    chainWrite: recorder.chainWrite,
    manifestFetch: judge.manifestFetch,
    adapterPathFor: judge.adapterPathFor,
    resolveActor: () => RED_AGENT,
    actorNameFor: () => '',
    log: (m) => { if (process.env.HEAL_DEBUG) console.error('[runtime]', m); },
  });
  return { host, db, recorder, artifactDir: judge.artifactDir, cleanup: () => fs.rmSync(judge.artifactDir, { recursive: true, force: true }) };
}

function makeRecorder(db) {
  const calls = [];
  let rowSeq = 0;
  return {
    calls,
    async chainWrite(gid, plaintext, opts) {
      calls.push({ groupId: gid, plaintext, opts: opts ?? null });
      rowSeq += 1;
      const maxRow = db.exec('SELECT COALESCE(MAX(msg_index), 0) FROM group_chat_messages WHERE group_id = ?', [gid]);
      const nextIndex = Number(maxRow[0]?.values?.[0]?.[0] ?? 0) + 1;
      db.run(
        `INSERT INTO group_chat_messages
          (pin_id, group_id, sender_metaid, sender_global_metaid, protocol, content, encryption, chain_timestamp, msg_index)
         VALUES (?, ?, ?, ?, 'simplegroupchat', ?, '', ?, ?)`,
        [`heal-pin-${rowSeq}`, gid, opts?.asAgentId ?? 'unknown', opts?.asAgentId ?? null, plaintext, Date.now(), nextIndex],
      );
      return { pinId: `heal-pin-${calls.length}` };
    },
  };
}

/** 直插一条会话行（G2 黑席形态的注入面）。 */
function insertSessionRow(db, { sessionId, lastIndex, lastActionSeq, serializedState, status = 'running' }) {
  const now = Date.now();
  db.run(
    `INSERT INTO agent_game_sessions (
      session_id, status, app_id, group_id, game_id, agent_id, seat, rules_hash,
      adapter_hash, manifest_uri, protocol_paths, budget_llm_calls, budget_llm_calls_used,
      budget_writes, budget_writes_used, last_index, last_action_seq, last_error, expires_at,
      consent, lease_id, lease_expires_at, serialized_state, created_at, updated_at
    ) VALUES (?, ?, 'heal.v1', ?, ?, ?, 'red', ?, ?, 'metaapp://judge-fixture-pin-i0', '[]', 20, 0, 20, 0, ?, ?, NULL, ?, NULL, NULL, NULL, ?, ?, ?)`,
    [sessionId, status, GROUP_ID, GAME_ID, RED_AGENT, RULES_HASH, `sha256:${JUDGE_ADAPTER_SHA256}`, lastIndex, lastActionSeq, now + 3_600_000, serializedState, now, now],
  );
  return sessionId;
}

async function waitFor(predicate, { timeoutMs = 15_000, stepMs = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

const storedOf = (db, sessionId) => {
  const res = db.exec('SELECT serialized_state, last_index FROM agent_game_sessions WHERE session_id = ?', [sessionId]);
  const row = res[0]?.values?.[0];
  return { serializedState: row?.[0] ?? null, lastIndex: row?.[1] ?? null };
};

test('缺口二①: 裸板+已推进游标重启恢复——状态必须全量重放自愈，宿主从真盘出子', { timeout: 60_000 }, async () => {
  let host = null;
  let cleanup = () => {};
  try {
    const judgeProbe = materializeJudgeAdapter();
    const built = buildHost({ llm: async () => ({ content: 'h0g2' }) });
    host = built.host;
    cleanup = built.cleanup;
    const truth = await insertTrueHistory(built.db, judgeProbe.artifactDir);
    fs.rmSync(judgeProbe.artifactDir, { recursive: true, force: true });

    // G2 黑席原形：游标已消费全史（lastIndex=5），库态=裸初始板。
    const sessionId = insertSessionRow(built.db, {
      sessionId: 'heal-bare-initial',
      lastIndex: truth.lastIndex,
      lastActionSeq: 2,
      serializedState: JSON.stringify(truth.bareInitialState),
    });

    await host.runtime.recover();
    const view = await host.handleSessionMethod('status', { sessionId }, RED_AGENT, {});
    assert.equal(view.status, 'running', `恢复后应回到 running（实际 ${view.status}: ${JSON.stringify(view.lastError)}）`);

    // 恢复推进循环：真盘 red 行棋 → 出子。prevStateHash 必须等于真盘哈希。
    host.onGroupMessage(GROUP_ID);
    await waitFor(
      () => built.recorder.calls.some((c) => JSON.parse(c.plaintext).type === 'action'),
      { timeoutMs: 12_000, label: 'action from healed true board (RED on main: bare initial board stays waiting, no move ever)' },
    );
    const action = JSON.parse(built.recorder.calls.find((c) => JSON.parse(c.plaintext).type === 'action').plaintext);
    assert.equal(action.payload.move, 'h0g2');
    assert.equal(action.prevStateHash, shaOf(truth.trueFinalSerialized), 'prevStateHash 必须等于第三方对全史重放的真盘哈希');
    assert.equal(action.actionSeq, 3, '自愈后续手 actionSeq 必须从重放重算（3）');
  } finally {
    if (host) await host.runtime.dispose().catch(() => {});
    cleanup();
  }
});

test('缺口二②: 无 sandbox 不得空推进游标——消息留待恢复后折叠', { timeout: 60_000 }, async () => {
  let host = null;
  let cleanup = () => {};
  try {
    const judgeProbe = materializeJudgeAdapter();
    const built = buildHost({ llm: async () => ({ content: 'h0g2' }) });
    host = built.host;
    cleanup = built.cleanup;
    const truth = await insertTrueHistory(built.db, judgeProbe.artifactDir);
    fs.rmSync(judgeProbe.artifactDir, { recursive: true, force: true });

    const sessionId = insertSessionRow(built.db, {
      sessionId: 'heal-defer-no-sandbox',
      lastIndex: 2,
      lastActionSeq: 0,
      serializedState: null,
    });

    // recover 之前群消息到达（sandbox 未载）：静默空推进即脱钩根源。
    const savedLoop = host.runtime.scheduleLoop;
    host.runtime.scheduleLoop = () => {}; // 只验 catchUp 消费面，不让循环抢跑
    try {
      host.onGroupMessage(GROUP_ID);
      await new Promise((r) => setTimeout(r, 300));
      const { lastIndex } = storedOf(built.db, sessionId);
      assert.equal(lastIndex, 2, `无 sandbox 时游标不得推进（实际 ${lastIndex}；RED on main: 被空推进到 ${truth.lastIndex}）`);
    } finally {
      host.runtime.scheduleLoop = savedLoop;
    }

    // 恢复后自愈：全史折叠 → 真盘出子。
    await host.runtime.recover();
    host.onGroupMessage(GROUP_ID);
    await waitFor(
      () => built.recorder.calls.some((c) => JSON.parse(c.plaintext).type === 'action'),
      { timeoutMs: 12_000, label: 'action after deferred catch-up heals (RED on main)' },
    );
    const action = JSON.parse(built.recorder.calls.find((c) => JSON.parse(c.plaintext).type === 'action').plaintext);
    assert.equal(action.prevStateHash, shaOf(truth.trueFinalSerialized), '延迟折叠后 prevStateHash 必须收敛到真盘');
  } finally {
    if (host) await host.runtime.dispose().catch(() => {});
    cleanup();
  }
});

test('缺口二③: 库态损坏维持 state_corrupt 拒绝——自愈不吞并 GAP-5 拒绝语义', { timeout: 30_000 }, async () => {
  let host = null;
  let cleanup = () => {};
  try {
    const judgeProbe = materializeJudgeAdapter();
    const built = buildHost({ llm: async () => ({ content: 'h0g2' }) });
    host = built.host;
    cleanup = built.cleanup;
    const truth = await insertTrueHistory(built.db, judgeProbe.artifactDir);
    fs.rmSync(judgeProbe.artifactDir, { recursive: true, force: true });

    const sessionId = insertSessionRow(built.db, {
      sessionId: 'heal-corrupt-stored',
      lastIndex: truth.lastIndex,
      lastActionSeq: 2,
      serializedState: '{"corrupt": not-json',
    });

    await host.runtime.recover();
    const view = await host.handleSessionMethod('status', { sessionId }, RED_AGENT, {});
    assert.equal(view.status, 'paused', '损坏库态必须暂停');
    assert.equal(view.lastError?.code, 'state_corrupt', '必须保留结构化 state_corrupt 拒绝');
    // 损坏 blob 原样保留。
    const { serializedState } = storedOf(built.db, sessionId);
    assert.equal(serializedState, '{"corrupt": not-json', '损坏 blob 不得被改写');
    assert.equal(built.recorder.calls.some((c) => JSON.parse(c.plaintext).type === 'action'), false, '损坏态绝不出子');
  } finally {
    if (host) await host.runtime.dispose().catch(() => {});
    cleanup();
  }
});

test('缺口二④: 健康库态重启不受自愈扰动——prevStateHash 与真盘一致（回归护栏）', { timeout: 60_000 }, async () => {
  let host = null;
  let cleanup = () => {};
  try {
    const judgeProbe = materializeJudgeAdapter();
    const built = buildHost({ llm: async () => ({ content: 'h0g2' }) });
    host = built.host;
    cleanup = built.cleanup;
    const truth = await insertTrueHistory(built.db, judgeProbe.artifactDir);
    fs.rmSync(judgeProbe.artifactDir, { recursive: true, force: true });

    insertSessionRow(built.db, {
      sessionId: 'heal-healthy-stored',
      lastIndex: truth.lastIndex,
      lastActionSeq: 2,
      serializedState: JSON.stringify(truth.trueFinalState),
    });

    await host.runtime.recover();
    host.onGroupMessage(GROUP_ID);
    await waitFor(
      () => built.recorder.calls.some((c) => JSON.parse(c.plaintext).type === 'action'),
      { timeoutMs: 12_000, label: 'action after healthy recovery' },
    );
    const action = JSON.parse(built.recorder.calls.find((c) => JSON.parse(c.plaintext).type === 'action').plaintext);
    assert.equal(action.prevStateHash, shaOf(truth.trueFinalSerialized), '健康路径 prevStateHash 必须等于真盘哈希');
    assert.equal(action.actionSeq, 3);
  } finally {
    if (host) await host.runtime.dispose().catch(() => {});
    cleanup();
  }
});
