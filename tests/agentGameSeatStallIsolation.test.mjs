/**
 * 缺口修复一回归：会话级 LLM 停摆不得粘滞（G2 作废局取证：红席 3 实例
 * ~50 连败 fetch failed，同期他席正常出子）。
 *
 * 根因链（2026-09-25 生产取证）：信号缺位（接线丢参，见 agentGameMoveWindow
 * 套件）→ 挂死调用以 undici 默认 300s headers 超时为唯一出口 → 劣化
 * keep-alive 连接被钉死在进程级连接池里，后续请求持续竞速到死插座上——
 * 单席失败自我强化成失败吸引子。本套件锁定修复后的三条性质：
 *  - 用例 1  同宿主双会话隔离：一席 LLM 挂死（接线劣化形态）在合同窗内被
 *            runtime 强断为 paused llm_timeout，另一席同期照常出子；
 *            宿主日志必须留下会话级关联的 LLM 故障行（取证要求）。
 *  - 用例 2  fetch 层 stall 级失败分类：半死插座上的挂死到点失败
 *            （ETIMEDOUT / UND_ERR_HEADERS_TIMEOUT / UND_ERR_BODY_TIMEOUT）
 *            与 reset 级同享「恰一次新连接立即重试」；abort/timeout 永不重试。
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

/** 陈旧产物守卫：探针 = fetch 层 stall 分类特征（本修复引入）。 */
const DIST_LLMFETCH_JS = path.join(projectRoot, 'dist-electron', 'main', 'services', 'llmFetch.js');
(function assertFreshDist() {
  let src;
  try {
    src = fs.readFileSync(DIST_LLMFETCH_JS, 'utf8');
  } catch {
    throw new Error(`[stale-dist-guard] ${DIST_LLMFETCH_JS} 不存在：先编译（pnpm run compile:electron）再跑本套件`);
  }
  if (!src.includes('UND_ERR_HEADERS_TIMEOUT')) {
    throw new Error('[stale-dist-guard] dist-electron/main/services/llmFetch.js 缺 stall 级重试分类特征（旧产物）：请重编译后重跑');
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
const GROUP_A = '1fbaed756685856042fba718a22ff2fa6ce57e59a481e4d850e577fd768456d1i0';
const GROUP_B = '2ded670e303afcdfd93de13930dbab485b76950aef07b6310d8ca92f318209bfi0';
const RED_AGENT = 'idq1winred000000000000000000000000000000000000000000000red000';
const BLACK_AGENT = 'idq1winblack000000000000000000000000000000000000000000black00';
const RULES_HASH = 'sha256:stall-isolation-rules-hash';

const FIXTURE_ADAPTER_DIR = path.join(projectRoot, 'tests', 'fixtures', 'xiangqi-adapter');
const JUDGE_ADAPTER_SHA256 = 'eabf1f423c869f91ef9c755e95d61e97ad32189e87a910b4bdfee4678c664a5e';
{
  const actual = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(FIXTURE_ADAPTER_DIR, 'agent-game', 'adapter.js')))
    .digest('hex');
  assert.equal(actual, JUDGE_ADAPTER_SHA256, '裁判 adapter fixture 漂移');
}

const { createAgentGameHost } = require('../dist-electron/main/agentGame/index.js');

function makeChainRecorder(db) {
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
        [`stall-pin-${rowSeq}`, gid, opts?.asAgentId ?? 'unknown', opts?.asAgentId ?? null, plaintext, Date.now(), nextIndex],
      );
      return { pinId: `stall-pin-${calls.length}` };
    },
  };
}

function materializeJudgeAdapter() {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-game-stall-'));
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

function buildHost({ llm }) {
  const db = new TestSqliteDb();
  createAgentGameTables(db);
  const judge = materializeJudgeAdapter();
  const recorder = makeChainRecorder(db);
  const logSink = [];
  const host = createAgentGameHost({
    db,
    saveDb: () => {},
    llmComplete: llm,
    chainWrite: recorder.chainWrite,
    manifestFetch: judge.manifestFetch,
    adapterPathFor: judge.adapterPathFor,
    resolveActor: () => RED_AGENT,
    actorNameFor: () => '',
    log: (m) => { logSink.push(m); if (process.env.STALL_DEBUG) console.error('[runtime]', m); },
  });
  return { host, db, recorder, logSink, historyArtifactDir: judge.artifactDir, cleanup: () => fs.rmSync(judge.artifactDir, { recursive: true, force: true }) };
}

const shaOf = (serialized) => `sha256:${crypto.createHash('sha256').update(serialized).digest('hex')}`;

/**
 * 造 B 组的开局真史（4 行，哈希链正确）：match.created → 红占座 → 黑占座 →
 * 红首手 h2e2（phase 必须先到 playing，动作才被裁判接受）。折叠方式与第三方
 * 重放一致（行 meta: index/senderMetaId/timestamp），使黑方行棋为当前回合。
 * B 席（黑）start 时自己的占座与其 metaId 重复，被 adapter 幂等吸收。
 */
async function insertRedOpeningMove(db, artifactDir, groupId) {
  const adapter = await import(pathToFileURL(path.join(artifactDir, 'agent-game', 'adapter.js')).href);
  let state = adapter.initialState({ gameId: GAME_ID, seat: 'red' });
  const ts = Date.now();
  let idx = 0;

  const fold = async (env, sender) => {
    idx += 1;
    db.run(
      `INSERT INTO group_chat_messages (pin_id, group_id, sender_metaid, sender_global_metaid, protocol, content, encryption, chain_timestamp, msg_index)
       VALUES (?, ?, 'legacy-metaid', ?, 'simplegroupchat', ?, 'aes', ?, ?)`,
      [`stall-open-${groupId.slice(0, 6)}-${idx}`, groupId, sender, JSON.stringify(env), ts + idx, idx],
    );
    state = await adapter.reduce(state, { ...env, meta: { index: idx, senderMetaId: sender, timestamp: ts + idx } });
  };

  const base = (type, extra = {}) => ({
    protocol: 'agent-game/1', gameId: GAME_ID, matchId: groupId, rulesHash: RULES_HASH,
    type, eventId: `stall:${type}:${Math.random().toString(36).slice(2)}`, ...extra,
  });

  await fold(base('match.created', { payload: { title: 'stall isolation match' } }), RED_AGENT);
  await fold(base('seat.claimed', { payload: { requestedRole: 'red' } }), RED_AGENT);
  await fold(base('seat.claimed', { payload: { requestedRole: 'black' } }), BLACK_AGENT);

  const pre = await adapter.serializeState(state);
  const action = base('action', { actionSeq: 1, prevStateHash: shaOf(pre), stateHash: '', payload: { move: 'h2e2' } });
  const post = await adapter.serializeState(await adapter.reduce(state, { ...action, meta: { index: idx + 1, senderMetaId: RED_AGENT, timestamp: ts } }));
  action.stateHash = post;
  await fold(action, RED_AGENT);
}

function startParams(groupId, overrides = {}) {
  return {
    appId: 'stall.v1',
    sessionType: 'agent-game',
    groupId,
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
  const deadline = realDateNow() + timeoutMs; // fake-clock-proof: waitFor must run on the real clock
  while (realDateNow() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

function insertPrefixRows(db, groupId) {
  const mk = (type, extra = {}) => JSON.stringify({
    protocol: 'agent-game/1', gameId: GAME_ID, matchId: groupId, rulesHash: RULES_HASH,
    type, eventId: `row:${type}:${Math.random().toString(36).slice(2)}`, ...extra,
  });
  db.run(
    `INSERT INTO group_chat_messages (pin_id, group_id, sender_metaid, sender_global_metaid, protocol, content, encryption, chain_timestamp, msg_index)
     VALUES (?, ?, 'legacy-metaid', ?, 'simplegroupchat', ?, 'aes', ?, 1)`,
    [`stall-row-${groupId.slice(0, 6)}-1`, groupId, RED_AGENT, mk('match.created'), Date.now()],
  );
  db.run(
    `INSERT INTO group_chat_messages (pin_id, group_id, sender_metaid, sender_global_metaid, protocol, content, encryption, chain_timestamp, msg_index)
     VALUES (?, ?, 'legacy-metaid', ?, 'simplegroupchat', ?, 'aes', ?, 2)`,
    [`stall-row-${groupId.slice(0, 6)}-2`, groupId, BLACK_AGENT, mk('seat.claimed', { payload: { requestedRole: 'black' } }), Date.now()],
  );
}

const realDateNow = Date.now;
let fakeNow = 1_785_000_000_000;

test('缺口一: 一席 LLM 挂死被合同窗强断为 llm_timeout，他席同期照常出子，日志留会话级故障行', { timeout: 60_000 }, async () => {
  // 本用例走假钟（强断判定），真实计时用 realDateNow。
  Date.now = () => fakeNow;
  let host = null;
  let cleanup = () => {};
  try {
    // 接线劣化形态按 seat 路由（buildMovePrompt 带 `as seat "<seat>"`）：
    // A 组红席挂死永不返回，B 组黑席健康快返。
    let aEntered = false;
    const routedLlm = (messages, opts) => {
      const seat = /as seat "([^"]+)"/.exec(messages?.[0]?.content ?? '')?.[1] ?? 'unknown';
      if (seat === 'red') {
        aEntered = true;
        void opts;
        return new Promise(() => {});
      }
      return Promise.resolve({ content: 'h9g7' });
    };
    const built = buildHost({ llm: routedLlm });
    host = built.host;
    cleanup = built.cleanup;

    // A 组：match.created + 黑占座 → 红方行棋（挂死点）。
    insertPrefixRows(built.db, GROUP_A);
    // B 组：match.created + 红占座 + 红首手 h2e2（真哈希链）→ 黑方行棋。
    await insertRedOpeningMove(built.db, built.historyArtifactDir, GROUP_B);
    const sessionA = await startSession(host, startParams(GROUP_A));
    const sessionB = await startSession(host, startParams(GROUP_B, { seat: 'black', agentId: BLACK_AGENT }));
    host.runtime.startBackground();

    // 他席（B）照常出子——单席故障不外溢（此半边在 main 上也成立，防回归）。
    host.onGroupMessage(GROUP_B);
    await waitFor(() => built.recorder.calls.some((c) => c.groupId === GROUP_B && JSON.parse(c.plaintext).type === 'action'), { label: 'seat B action committed' });

    // 挂死席（A）进入 LLM 调用后，跨过合同窗必须被强断为 llm_timeout。
    host.onGroupMessage(GROUP_A);
    await waitFor(() => aEntered, { label: 'seat A llm entry (hang)' });
    fakeNow += 121_000;
    host.runtime.sweepLlmWindows(); // deterministic primary cut (real 1s interval stays as backup)
    host.onGroupMessage(GROUP_A);
    await waitFor(async () => {
      const view = await host.handleSessionMethod('status', { sessionId: sessionA.sessionId }, RED_AGENT, {});
      return view.status === 'paused' && view.lastError?.code === 'llm_timeout';
    }, { timeoutMs: 20_000, label: 'seat A window-cut to llm_timeout (red on main: hangs forever)' });

    // 宿主日志必须留下会话级关联的故障行（取证要求：能定位是哪一席哪类故障）。
    const correlated = built.logSink.find((line) => line.includes(sessionA.sessionId) && /move-LLM failed|llm_timeout/i.test(line));
    assert.ok(correlated, `日志缺会话级 LLM 故障行: ${JSON.stringify(built.logSink.slice(-5))}`);

    // 他席不受牵连：B 仍 running 无错误。
    const viewB = await host.handleSessionMethod('status', { sessionId: sessionB.sessionId }, BLACK_AGENT, {});
    assert.equal(viewB.status, 'running');
    assert.equal(viewB.lastError, null);
  } finally {
    if (host) await host.runtime.dispose().catch(() => {});
    cleanup();
    Date.now = realDateNow;
  }
});

test('缺口一: fetch 层 stall 级失败与 reset 级同享恰一次新连接重试；abort/timeout 永不重试', async () => {
  const { connectionFailureCauseCode } = require('../dist-electron/main/services/llmFetch.js');
  const typeErrWith = (code) => Object.assign(new TypeError('fetch failed'), { cause: { code } });

  // stall 级（半死插座挂满窗口后到点失败）必须可重试（红基线：main 上返回 null）。
  for (const code of ['ETIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) {
    assert.equal(connectionFailureCauseCode(typeErrWith(code)), code, `stall 级 ${code} 必须分类为可重试`);
  }
  // reset 级维持既有行为。
  for (const code of ['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE']) {
    assert.equal(connectionFailureCauseCode(typeErrWith(code)), code, `reset 级 ${code} 保持可重试`);
  }
  // 死端点与 abort/timeout 永不重试。
  assert.equal(connectionFailureCauseCode(typeErrWith('ECONNREFUSED')), null, 'ECONNREFUSED 保持不可重试');
  const abortErr = new Error('operation was aborted');
  abortErr.name = 'TimeoutError';
  assert.equal(connectionFailureCauseCode(abortErr), null, 'abort/timeout 永不重试');
  assert.equal(connectionFailureCauseCode(new Error('plain')), null, '非 fetch 层错误不重试');

  // 源码级：stall 码在重试集合内。
  const src = fs.readFileSync(path.join(projectRoot, 'src', 'main', 'services', 'llmFetch.ts'), 'utf8');
  for (const code of ['ETIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) {
    assert.ok(src.includes(`'${code}'`), `src/main/services/llmFetch.ts 重试集合缺 ${code}`);
  }
});
