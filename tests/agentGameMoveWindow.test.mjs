/**
 * GAP-4 回归（第二层）：移动 LLM 两分钟故障窗必须由 runtime 自己持有，
 * 不信任 llmComplete 接线把 timeoutMs 传下去。
 *
 * 缺口来源（2026-09-25 生产取证）：13:03:05→13:08:01→13:13:05 每 attempt
 * 挂满 ~5 分钟——解包生产 asar 实锤其 main.js 的 llmComplete 为
 * `(messages) => chatCompletionWithTools(messages, {...})`：不收 opts、
 * 不传 attemptTimeoutMs（构建早于 130d7bef 的接线）。合同值在 runtime
 * 存在（LLM_CALL_TIMEOUT_MS=120_000）、在 llmFallback 存在
 * （withPerAttemptSignal），但在唯一的接线点被丢——挂死调用没有任何
 * 出口，直到 undici 默认 300s headers 超时才以 "fetch failed" 落败
 * （架构决策②字面失效；同一挂死还把劣化 keep-alive 连接钉死在连接池里，
 * 形成「单席连败粘滞」的失败吸引子）。
 *
 * 本套件锁定：
 *  - 用例 1  接线劣化形态（llmComplete 无视 timeoutMs/signal 且永不返回）：
 *            runtime 必须在合同窗（120s，假钟推进）内强断并 pause
 *            llm_timeout——恢复架构决策②字面，接线漂移不再致命。
 *  - 用例 2  llmComplete 尊重 signal 时：runtime 传入的 AbortSignal 必须
 *            在窗到点时真正触发（opts.timeoutMs 仍须 === 120000）。
 *  - 用例 3  健康快返调用不受窗口误伤（对局照常推进）。
 *  - 用例 4  main.ts 接线合同（源码级断言）：attemptTimeoutMs 与
 *            runtime 信号（signal: opts.signal）双通道都在——任何一路
 *            回退都还有另一路兜底。
 *
 * 虚拟时钟：接管 Date.now（runtime/store/lease 全走 Date.now）；sweeper
 * 是真实 1s interval、判定用 this.now()——测试推进假钟后等真实 tick。
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

/** 陈旧产物守卫：探针标识符取自本修复新引入的代码（sweepLlmWindows），
 *  旧产物缺失特征 → 显式红灯 + 重编译指引。 */
const DIST_RUNTIME_JS = path.join(projectRoot, 'dist-electron', 'main', 'agentGame', 'runtime.js');
(function assertFreshAgentGameDist() {
  let src;
  try {
    src = fs.readFileSync(DIST_RUNTIME_JS, 'utf8');
  } catch {
    throw new Error(`[stale-dist-guard] ${DIST_RUNTIME_JS} 不存在：先编译 electron 主进程（pnpm run compile:electron）再跑本套件`);
  }
  if (!src.includes('sweepLlmWindows')) {
    throw new Error('[stale-dist-guard] dist-electron/main/agentGame/runtime.js 缺移动窗强制特征（sweepLlmWindows，旧产物）：请重编译后重跑');
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
const GROUP_ID = '1fbaed756685856042fba718a22ff2fa6ce57e59a481e4d850e577fd768456d1i0';
const RED_AGENT = 'idq1winred000000000000000000000000000000000000000000000red000';
const BLACK_AGENT = 'idq1winblack000000000000000000000000000000000000000000black00';
const RULES_HASH = 'sha256:move-window-regression-rules-hash';

const FIXTURE_ADAPTER_DIR = path.join(projectRoot, 'tests', 'fixtures', 'xiangqi-adapter');
const JUDGE_ADAPTER_SHA256 = 'eabf1f423c869f91ef9c755e95d61e97ad32189e87a910b4bdfee4678c664a5e';
{
  const actual = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(FIXTURE_ADAPTER_DIR, 'agent-game', 'adapter.js')))
    .digest('hex');
  assert.equal(actual, JUDGE_ADAPTER_SHA256, '裁判 adapter fixture 漂移：agent-game/adapter.js sha256 不再等于 v1.0.2 游戏包哈希');
}

/* ------------------------------------------------------------------ */
/* Host harness                                                        */
/* ------------------------------------------------------------------ */

const { createAgentGameHost } = require('../dist-electron/main/agentGame/index.js');

/** chainWrite 录制器：记录每次链写并同步落 group_chat_messages 行。 */
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
        [`mwin-pin-${rowSeq}`, gid, opts?.asAgentId ?? 'unknown', opts?.asAgentId ?? null, plaintext, rowTs, nextIndex],
      );
      return { pinId: `mwin-pin-${calls.length}` };
    },
  };
}

function materializeJudgeAdapter() {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-game-mwin-'));
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

function buildHost({ llm, logSink }) {
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
    log: (m) => { if (logSink) logSink.push(m); else if (process.env.MWIN_DEBUG) console.error('[runtime]', m); },
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
    appId: 'mwin.v1',
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

const realDateNow = Date.now;
async function waitFor(predicate, { timeoutMs = 15_000, stepMs = 25, label = 'condition' } = {}) {
  const deadline = realDateNow() + timeoutMs;
  while (realDateNow() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

/** 手工插入一条链上消息行（match.created / 对方 seat.claimed）。 */
function insertRow(db, { pinId, senderGlobalMetaId, msgIndex, chainTimestamp, content }) {
  db.run(
    `INSERT INTO group_chat_messages
      (pin_id, group_id, sender_metaid, sender_global_metaid, protocol, content, encryption, chain_timestamp, msg_index)
     VALUES (?, ?, ?, ?, 'simplegroupchat', ?, 'aes', ?, ?)`,
    [pinId, GROUP_ID, 'legacy-metaid', senderGlobalMetaId, content, chainTimestamp, msgIndex],
  );
}

const matchCreatedContent = () => JSON.stringify({
  protocol: 'agent-game/1',
  gameId: GAME_ID,
  matchId: GROUP_ID,
  rulesHash: RULES_HASH,
  type: 'match.created',
  eventId: `row:match.created:${Math.random().toString(36).slice(2)}`,
  payload: { title: 'move-window regression match' },
});

const seatClaimContent = (seat) => JSON.stringify({
  protocol: 'agent-game/1',
  gameId: GAME_ID,
  matchId: GROUP_ID,
  rulesHash: RULES_HASH,
  type: 'seat.claimed',
  eventId: `row:seat.claimed.${seat}:${Math.random().toString(36).slice(2)}`,
  payload: { requestedRole: seat },
});

/** 虚拟时钟：宿主不透传 now，直接接管 Date.now；真实计时走 realDateNow。 */
let fakeNow = 1_785_000_000_000;
function installFakeClock() {
  fakeNow = 1_785_000_000_000;
  Date.now = () => fakeNow;
}
function uninstallFakeClock() {
  Date.now = realDateNow;
}

async function seatRedToMove(db, host) {
  // 前缀流：match.created → 红方占座（宿主 start 自动链写）→ 黑方占座。
  insertRow(db, { pinId: 'mwin-row-1', senderGlobalMetaId: RED_AGENT, msgIndex: 1, chainTimestamp: fakeNow, content: matchCreatedContent() });
  await startSession(host, startParams());
  insertRow(db, { pinId: 'mwin-row-3', senderGlobalMetaId: BLACK_AGENT, msgIndex: 3, chainTimestamp: fakeNow, content: seatClaimContent('black') });
  host.onGroupMessage(GROUP_ID);
}

test('GAP-4②: 接线劣化形态（无视 timeoutMs/signal 的挂死 llmComplete）被 runtime 合同窗强断 → paused llm_timeout', { timeout: 40_000 }, async () => {
  installFakeClock();
  let host = null;
  let cleanup = () => {};
  try {
    // 生产 13:03 实锤形态：llmComplete 不收 opts、永不返回。
    let entered = false;
    const hungLlm = async () => {
      entered = true;
      return new Promise(() => {});
    };
    const built = buildHost({ llm: hungLlm });
    host = built.host;
    cleanup = built.cleanup;

    await seatRedToMove(built.db, host);
    await waitFor(() => entered, { label: 'red llm entry (hang)' });
    const sessionId = host.runtime.deps.store.listRecoverableSessions()[0]?.sessionId;
    assert.ok(sessionId, '会话必须已建立');

    const runningView = await host.handleSessionMethod('status', { sessionId }, RED_AGENT, {});
    assert.equal(runningView.status, 'running', '挂死中会话保持 running（对齐 G1/G2 观测）');

    // 推进假钟跨过 120s 合同窗（+ 余量），等真实 sweeper tick。
    fakeNow += 121_000;
    host.onGroupMessage(GROUP_ID);
    await waitFor(async () => {
      const view = await host.handleSessionMethod('status', { sessionId }, RED_AGENT, {});
      return view.status === 'paused' && view.lastError?.code === 'llm_timeout';
    }, { timeoutMs: 8_000, label: 'runtime-enforced llm_timeout pause (red on main: session hangs forever)' });

    const view = await host.handleSessionMethod('status', { sessionId }, RED_AGENT, {});
    assert.equal(view.lastError.code, 'llm_timeout', '分类必须是 llm_timeout（isAbort 认 BrowserLlmTimeout）');
    assert.match(view.lastError.message, /120000ms|window/i, '错误信息必须点名合同窗');
  } finally {
    if (host) await host.runtime.dispose().catch(() => {});
    cleanup();
    uninstallFakeClock();
  }
});

test('GAP-4②: runtime 传入的 AbortSignal 在窗到点时真正触发（尊重 signal 的挂死被链路取消）', { timeout: 40_000 }, async () => {
  installFakeClock();
  let host = null;
  let cleanup = () => {};
  try {
    const seen = { timeoutMs: null, signal: null, entered: false };
    const signalAwareHungLlm = (messages, opts) => {
      seen.timeoutMs = opts?.timeoutMs ?? null;
      seen.signal = opts?.signal ?? null;
      seen.entered = true;
      return new Promise((_, reject) => {
        if (opts?.signal) {
          opts.signal.addEventListener('abort', () => reject(opts.signal.reason ?? new Error('aborted')));
        }
      });
    };
    const built = buildHost({ llm: signalAwareHungLlm });
    host = built.host;
    cleanup = built.cleanup;

    await seatRedToMove(built.db, host);
    await waitFor(() => seen.entered, { label: 'red llm entry' });
    assert.equal(seen.timeoutMs, 120_000, '合同值 timeoutMs 必须随调用传入');
    assert.ok(seen.signal instanceof AbortSignal, 'runtime 必须传入 AbortSignal（信号通道；RED on main: opts 无 signal）');

    fakeNow += 121_000;
    host.onGroupMessage(GROUP_ID);
    await waitFor(() => seen.signal?.aborted === true, { timeoutMs: 8_000, label: 'signal aborted at window' });
    await waitFor(async () => {
      const s = host.runtime.deps.store.listRecoverableSessions()[0];
      return s && s.status === 'paused' && s.lastError?.code === 'llm_timeout';
    }, { timeoutMs: 8_000, label: 'paused llm_timeout after signal abort' });
  } finally {
    if (host) await host.runtime.dispose().catch(() => {});
    cleanup();
    uninstallFakeClock();
  }
});

test('GAP-4②: 健康快返调用不受窗口误伤——对局照常出子', { timeout: 40_000 }, async () => {
  installFakeClock();
  let host = null;
  let cleanup = () => {};
  try {
    const built = buildHost({ llm: async () => ({ content: 'h2e2' }) });
    host = built.host;
    cleanup = built.cleanup;

    await seatRedToMove(built.db, host);
    await waitFor(() => built.recorder.calls.some((c) => JSON.parse(c.plaintext).type === 'action'), { label: 'red action committed' });
    const action = built.recorder.calls.find((c) => JSON.parse(c.plaintext).type === 'action');
    assert.equal(JSON.parse(action.plaintext).payload.move, 'h2e2', '健康路径必须照常出子');

    // 无 lastError、仍 running（等待黑方）。
    const s = host.runtime.deps.store.listRecoverableSessions()[0];
    assert.equal(s.status, 'running');
    assert.equal(s.lastError, null);
  } finally {
    if (host) await host.runtime.dispose().catch(() => {});
    cleanup();
    uninstallFakeClock();
  }
});

test('GAP-4②: main.ts 接线合同——attemptTimeoutMs 与 runtime 信号双通道必须在位（源码级断言）', () => {
  const src = fs.readFileSync(path.join(projectRoot, 'src', 'main', 'main.ts'), 'utf8');
  const wiringAt = src.indexOf('llmComplete: (messages, opts) =>');
  assert.ok(wiringAt >= 0, 'main.ts 必须保留 agent-game llmComplete 接线');
  const wiring = src.slice(wiringAt, wiringAt + 2400);
  assert.match(wiring, /attemptTimeoutMs:\s*opts\.timeoutMs/, '接线必须透传 attemptTimeoutMs（130d7bef 合同）');
  assert.match(wiring, /signal:\s*opts\.signal/, '接线必须透传 runtime 信号 signal: opts.signal（接线漂移兜底通道）');
});
