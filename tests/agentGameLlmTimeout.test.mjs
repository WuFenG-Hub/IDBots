/**
 * GAP-4 回归：agent-game LLM 挂死的两条规则出口（G1 首局 2026-09-24 实证）。
 *
 * 缺口来源：G1 对局（群 1fbaed75…d1i0）红方 seq7 / 黑方 seq8 LLM 调用挂死
 * 18–45+ 分钟无任何超时出口（GAP4-evidence.md）：
 *  - 接线丢参：main.ts 的 llmComplete 只收 messages，丢弃 runtime 合同的
 *    opts.timeoutMs → llmFallback 的 attemptTimeoutMs 无人传参 → 120s 故障
 *    判据（架构决策②）在宿主合同里存在、在接线上失效。
 *  - 超时判负无人触发：adapter 有 timeout.claimed（900s/手，链上时间戳
 *    裁决），runtime 全文无写入路径 → 挂死方只能等外部 resume。
 *
 * 本套件逐项锁定：
 *  - 合同   runtime → llmComplete 必须携带 { timeoutMs: 120000 }；
 *           main.ts 接线必须把它透传为 attemptTimeoutMs（源码级合同断言）。
 *  - 出口   llmComplete 抛 TimeoutError / BrowserLlmTimeout → paused
 *           llm_timeout；普通错误 → llm_unavailable（挂死必须按规则落盘）。
 *  - 判负   等待方在窗口(900s)+margin(60s) 后自动写 timeout.claimed，真实
 *           裁判 adapter（v1.0.2 字节级 fixture）按链上时间戳判超时负；
 *           窗口未满不得写（省 pin 费）；每个进度纪元至多一次申诉。
 *
 * 真实用例与裁判：
 *  - tests/fixtures/xiangqi-adapter/ = 字节级裁判 adapter（sha256 锁定，
 *    同 agentGameConvergence），timeout.claimed 语义与线上游戏包逐字节一致。
 *  - 虚拟时钟：宿主不透传 now，直接接管 Date.now（runtime/store/lease 全部
 *    走 Date.now），跨 990s 虚拟时间驱动申诉窗口；lease TTL=1h 不受干扰。
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

/** 陈旧产物守卫（同 agentGame* 系列）：探针标识符取自 GAP-4 修复新引入的
 *  代码（considerTimeoutClaim = 超时申诉触发器方法名），旧产物缺失特征 →
 *  显式红灯 + 重编译指引。 */
const DIST_RUNTIME_JS = path.join(projectRoot, 'dist-electron', 'main', 'agentGame', 'runtime.js');
(function assertFreshAgentGameDist() {
  let src;
  try {
    src = fs.readFileSync(DIST_RUNTIME_JS, 'utf8');
  } catch {
    throw new Error(`[stale-dist-guard] ${DIST_RUNTIME_JS} 不存在：先编译 electron 主进程（pnpm run compile:electron）再跑本套件`);
  }
  if (!src.includes('considerTimeoutClaim')) {
    throw new Error('[stale-dist-guard] dist-electron/main/agentGame/runtime.js 缺 GAP-4 修复特征（considerTimeoutClaim，旧产物）：请重编译（pnpm run compile:electron）后重跑');
  }
})();

setTimeout(() => {
  console.error('[suite-watchdog] 套件 120s 未结束：静默挂起（疑似 dist-electron 陈旧或资源竞争），强制 exit 1');
  process.exit(1);
}, 120_000).unref();

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
/* 合成对局常量 + 字节级裁判 adapter fixture                           */
/* ------------------------------------------------------------------ */

const GAME_ID = 'xiangqi';
const GROUP_ID = '1fbaed756685856042fba718a22ff2fa6ce57e59a481e4d850e577fd768456d1i0';
const RED_AGENT = 'idq1gap4red0000000000000000000000000000000000000000000000red00';
const BLACK_AGENT = 'idq1gap4black0000000000000000000000000000000000000000000black0';
const RULES_HASH = 'sha256:gap4-regression-rules-hash';

const FIXTURE_ADAPTER_DIR = path.join(projectRoot, 'tests', 'fixtures', 'xiangqi-adapter');
/** 字节级复制件的哈希必须始终等于首局 v1.0.2 裁判哈希（防 fixture 漂移）。 */
const JUDGE_ADAPTER_SHA256 = 'eabf1f423c869f91ef9c755e95d61e97ad32189e87a910b4bdfee4678c664a5e';
{
  const actual = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(FIXTURE_ADAPTER_DIR, 'agent-game', 'adapter.js')))
    .digest('hex');
  assert.equal(actual, JUDGE_ADAPTER_SHA256, '裁判 adapter fixture 漂移：agent-game/adapter.js sha256 不再等于 v1.0.2 游戏包哈希');
}

/* ------------------------------------------------------------------ */
/* Host harness（mirror agentGameConvergence）                        */
/* ------------------------------------------------------------------ */

const { createAgentGameHost } = require('../dist-electron/main/agentGame/index.js');

/** chainWrite 录制器：记录每次链写并同步落 group_chat_messages 行（模拟链上
 *  落定）。rowTs 可注入，供裁判重放用链上时间戳判 900s 窗口。 */
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
        [`gap4-pin-${rowSeq}`, gid, opts?.asAgentId ?? 'unknown', opts?.asAgentId ?? null, plaintext, rowTs, nextIndex],
      );
      return { pinId: `gap4-pin-${calls.length}` };
    },
  };
}

/** 把 fixture 裁判 adapter 复制进临时 artifact 目录（保持 ../js 相对布局）。 */
function materializeJudgeAdapter() {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-game-gap4-'));
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

/** buildMovePrompt 的 system 行带 `as seat "<seat>"` —— stub 按席位路由。 */
function seatRoutedLlm(handlers) {
  return async (messages, opts) => {
    const m = /as seat "([^"]+)"/.exec(messages?.[0]?.content ?? '');
    const seat = m ? m[1] : 'unknown';
    const h = handlers[seat];
    if (!h) throw new Error(`no llm stub for seat ${seat}`);
    return h(messages, opts);
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
    log: (m) => { if (process.env.GAP4_DEBUG) console.error('[runtime]', m); },
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
    appId: 'gap4.v1',
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

async function waitFor(predicate, { timeoutMs = 15_000, stepMs = 25, label = 'condition' } = {}) {
  // 真实时钟计时：Date.now 已被虚拟钟接管（常数），deadline 只能用真实时间。
  const deadline = realDateNow() + timeoutMs;
  while (realDateNow() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

/** 手工插入一条链上消息行（match.created 等非会话写入）。 */
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
  payload: { title: 'GAP-4 regression match' },
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

/** 第三方裁判重放：fresh adapter + 逐行 meta 折叠所有已落库行。 */
async function thirdPartyReplay(artifactDir, db) {
  const adapter = await import(pathToFileURL(path.join(artifactDir, 'agent-game', 'adapter.js')).href);
  let state = adapter.initialState({ gameId: GAME_ID, seat: 'red' });
  const rows = db.exec(
    'SELECT msg_index, sender_global_metaid, chain_timestamp, content FROM group_chat_messages WHERE group_id = ? ORDER BY msg_index',
    [GROUP_ID],
  )[0].values.map((v) => ({ msgIndex: v[0], senderGlobalMetaId: v[1], chainTimestamp: v[2], content: v[3] }));
  for (const row of rows) {
    if (!row.content) continue;
    let env;
    try {
      env = JSON.parse(row.content);
    } catch {
      continue;
    }
    if (env?.protocol !== 'agent-game/1') continue;
    state = adapter.reduce(state, {
      ...env,
      meta: { index: row.msgIndex, senderMetaId: row.senderGlobalMetaId, timestamp: row.chainTimestamp },
    });
  }
  return { state, rows };
}

/** 挂载/卸载虚拟时钟：runtime、store、lease 全走 Date.now。 */
const realDateNow = Date.now;
let fakeNow = 1_785_000_000_000;
function installFakeClock() {
  fakeNow = 1_785_000_000_000;
  Date.now = () => fakeNow;
}
function uninstallFakeClock() {
  Date.now = realDateNow;
}

/* ------------------------------------------------------------------ */
/* 用例                                                               */
/* ------------------------------------------------------------------ */

test('GAP-4 合同：runtime 调 llmComplete 必须携带 { timeoutMs: 120000 }（2 分钟故障判据）', { timeout: 30_000 }, async () => {
  installFakeClock();
  try {
    const seenOpts = [];
    const { host, db, recorder, cleanup } = buildHost({
      llm: seatRoutedLlm({
        red: async (_messages, opts) => {
          seenOpts.push(opts);
          return { content: 'h2e2' };
        },
      }),
    });
    insertRow(db, {
      pinId: 'gap4-mc-1',
      senderGlobalMetaId: RED_AGENT,
      msgIndex: 1,
      chainTimestamp: fakeNow,
      content: matchCreatedContent(),
    });
    try {
      const session = await startSession(host, startParams());
      // 合成黑方占座（无需黑会话）：双方座位落定 → playing → 红方被叫去走子。
      insertRow(db, {
        pinId: 'gap4-black-seat',
        senderGlobalMetaId: BLACK_AGENT,
        msgIndex: 2,
        chainTimestamp: fakeNow,
        content: seatClaimContent('black'),
      });
      host.onGroupMessage(GROUP_ID);
      // 红方走子（含 seat.claimed + action seq1 落链）。
      await waitFor(() => recorder.calls.some((c) => JSON.parse(c.plaintext).type === 'action'), { label: 'red action write' });
      assert.equal(seenOpts.length >= 1, true, 'llmComplete 至少被调用一次');
      for (const opts of seenOpts) {
        assert.equal(opts?.timeoutMs, 120_000, 'runtime 合同的 timeoutMs 必须逐次传给 llmComplete（丢弃即 GAP-4 复发）');
      }
      const view = await host.handleSessionMethod('status', { sessionId: session.sessionId }, RED_AGENT, {});
      assert.equal(view.status, 'running');
    } finally {
      await host.runtime.dispose().catch(() => {});
      cleanup();
    }
  } finally {
    uninstallFakeClock();
  }
});

test('GAP-4 源码合同：main.ts 接线必须把 opts.timeoutMs 透传为 attemptTimeoutMs', () => {
  const src = fs.readFileSync(path.join(projectRoot, 'src', 'main', 'main.ts'), 'utf8');
  const wiringStart = src.indexOf('llmComplete: (messages, opts)');
  assert.notEqual(wiringStart, -1, 'main.ts 的 agent-game llmComplete 接线必须声明 opts 参数（丢参即 GAP-4 复发）');
  const wiringEnd = src.indexOf('chainWrite:', wiringStart);
  assert.notEqual(wiringEnd, -1, 'host 接线块结构变化：找不到相邻 chainWrite 边界');
  const wiring = src.slice(wiringStart, wiringEnd);
  assert.match(
    wiring,
    /attemptTimeoutMs:\s*opts\.timeoutMs/,
    'llmComplete 接线必须透传 opts.timeoutMs → attemptTimeoutMs（恢复 120s 故障判据）',
  );
});

test('GAP-4 超时出口：llmComplete 抛超时类错误 → paused llm_timeout；普通错误 → llm_unavailable', { timeout: 60_000 }, async () => {
  const cases = [
    { name: 'TimeoutError', expected: 'llm_timeout', note: 'AbortSignal.timeout 的 WHATWG 错误名' },
    { name: 'BrowserLlmTimeout', expected: 'llm_timeout', note: '浏览器 LLM 桥的既存超时名' },
    { name: 'Error', expected: 'llm_unavailable', note: '普通故障' },
  ];
  for (const c of cases) {
    installFakeClock();
    let host;
    let db;
    let cleanup;
    try {
      ({ host, db, cleanup } = buildHost({
        llm: seatRoutedLlm({
          red: async () => {
            const err = new Error(`stub fault: ${c.name}`);
            err.name = c.name;
            throw err;
          },
        }),
      }));
      const session = await startSession(host, startParams());
      // 合成黑方占座（无需黑会话）：双方座位落定 → playing → 红方 llm 被调用即抛。
      insertRow(db, {
        pinId: 'gap4-black-seat',
        senderGlobalMetaId: BLACK_AGENT,
        msgIndex: 2,
        chainTimestamp: fakeNow,
        content: seatClaimContent('black'),
      });
      host.onGroupMessage(GROUP_ID);
      await waitFor(async () => {
        const view = await host.handleSessionMethod('status', { sessionId: session.sessionId }, RED_AGENT, {});
        return view.status !== 'running';
      }, { label: `session exit for ${c.name}` });
      const view = await host.handleSessionMethod('status', { sessionId: session.sessionId }, RED_AGENT, {});
      assert.equal(view.status, 'paused', `[${c.name}] 挂死必须按规则 paused 落盘`);
      assert.equal(view.lastError?.code, c.expected, `[${c.name}] ${c.note}`);
    } finally {
      if (host) await host.runtime.dispose().catch(() => {});
      if (cleanup) cleanup();
      uninstallFakeClock();
    }
  }
});

test('GAP-4 超时判负闭环：黑方挂死 → 红方 900s+margin 自动 timeout.claimed → 裁判判超时负', { timeout: 60_000 }, async () => {
  installFakeClock();
  const T0 = fakeNow;
  let resolveBlack;
  let host;
  let db;
  let recorder;
  let artifactDir;
  let cleanup;
  try {
    ({ host, db, recorder, artifactDir, cleanup } = buildHost({
      llm: seatRoutedLlm({
        red: async () => ({ content: 'h2e2' }),
        // 黑方挂死：GAP-4 场景本体 —— promise 永不 resolve（对齐 G1 的
        // in-flight 挂死；修复后由 attemptTimeoutMs 在真实宿主里打破）。
        black: () => new Promise((resolve) => { resolveBlack = resolve; }),
      }),
    }));
    insertRow(db, {
      pinId: 'gap4-mc-1',
      senderGlobalMetaId: RED_AGENT,
      msgIndex: 1,
      chainTimestamp: T0,
      content: matchCreatedContent(),
    });

    const red = await startSession(host, startParams({ seat: 'red', agentId: RED_AGENT }));
    const black = await startSession(host, startParams({ seat: 'black', agentId: BLACK_AGENT }));

    // 双方占座都落链后（写入走异步 loop tick，startSession 返回≠已写），
    // 再驱动一次 ingest hook：红方 catchUp 消费黑方占座 → playing。
    await waitFor(() => recorder.calls.length >= 2, { label: 'both seat claims committed' });
    host.onGroupMessage(GROUP_ID);
    try {
      await waitFor(() => recorder.calls.some((c) => JSON.parse(c.plaintext).type === 'action'), { label: 'red seq1 write' });
    } catch (err) {
      const rv = await host.handleSessionMethod('status', { sessionId: red.sessionId }, RED_AGENT, {});
      const bv = await host.handleSessionMethod('status', { sessionId: black.sessionId }, BLACK_AGENT, {});
      console.error('[diag] red:', JSON.stringify(rv));
      console.error('[diag] black:', JSON.stringify(bv));
      console.error('[diag] writes:', recorder.calls.map((c) => JSON.parse(c.plaintext).type).join(','));
      throw err;
    }
    const seq1 = recorder.calls.find((c) => JSON.parse(c.plaintext).type === 'action');
    assert.equal(JSON.parse(seq1.plaintext).payload.move, 'h2e2');
    assert.equal(seq1.opts.asAgentId, RED_AGENT, '走子方自付：action 必须以红方 agent 身份签署');
    const actionCountAfterSeq1 = recorder.calls.length;

    // 黑方进入挂死（llmComplete 被调用后永不返回）：轮询 stub 入口标志。
    host.onGroupMessage(GROUP_ID);
    await waitFor(() => resolveBlack !== undefined, { label: 'black llm entry (hang)' });
    const blackView = await host.handleSessionMethod('status', { sessionId: black.sessionId }, BLACK_AGENT, {});
    assert.equal(blackView.status, 'running', '挂死中的黑方会话 status 仍是 running（对齐 G1 观测）');

    // 窗口未满（900s+60s-30s）：不得写申诉 —— 过早申诉是纯 pin 费浪费，
    // 且会被裁判 adapter 原样拒绝（no-op）。
    fakeNow = T0 + 930_000;
    host.onGroupMessage(GROUP_ID);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(
      recorder.calls.slice(actionCountAfterSeq1).some((c) => JSON.parse(c.plaintext).type === 'timeout.claimed'),
      false,
      '窗口未满不得写 timeout.claimed',
    );
    const redMid = await host.handleSessionMethod('status', { sessionId: red.sessionId }, RED_AGENT, {});
    assert.equal(redMid.status, 'running', '窗口未满红方必须保持 running');

    // 窗口已满（T0+990s，锚点=seq1 链上时间戳）：红方自动申诉。
    fakeNow = T0 + 990_000;
    host.onGroupMessage(GROUP_ID);
    await waitFor(() => recorder.calls.some((c) => JSON.parse(c.plaintext).type === 'timeout.claimed'), { label: 'timeout.claimed write' });
    const claim = recorder.calls.find((c) => JSON.parse(c.plaintext).type === 'timeout.claimed');
    const claimEvent = JSON.parse(claim.plaintext);
    assert.equal(claimEvent.protocol, 'agent-game/1');
    assert.equal(claimEvent.gameId, GAME_ID);
    assert.equal(claimEvent.rulesHash, RULES_HASH);
    assert.deepEqual(claimEvent.payload, {}, '裁判只看发送者与行时间戳，payload 为空对象');
    assert.equal(claim.opts.asAgentId, RED_AGENT, '申诉必须以等待方（红）agent 身份签署');

    // 红方本地收敛为终局。
    await waitFor(async () => {
      const view = await host.handleSessionMethod('status', { sessionId: red.sessionId }, RED_AGENT, {});
      return view.status === 'finished';
    }, { label: 'red finished after claim' });

    // 第三方裁判重放全部链上行：超时判负必须独立可复算（1.h2e2 + timeout.claimed
    // → finished / winner=red / reason=timeout，plies 停在 1）。
    const { state } = await thirdPartyReplay(artifactDir, db);
    assert.equal(state.phase, 'finished', '第三方重放必须收敛到终局');
    assert.equal(state.plies, 1, '第三方重放的有效手数必须停在 1（黑方从未落子）');
    assert.deepEqual(state.result, { winner: 'red', reason: 'timeout' }, '裁判必须按 900s 链上判据判黑方超时负');

    // 纪元守卫：申诉后（即使假设被拒）同进度纪元不得再写 —— 防拒绝循环烧 pin。
    const writesAtClaim = recorder.calls.length;
    fakeNow = T0 + 1_500_000;
    host.onGroupMessage(GROUP_ID);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(recorder.calls.length, writesAtClaim, '同进度纪元至多一次 timeout.claimed');

    const blackFinal = await host.handleSessionMethod('status', { sessionId: black.sessionId }, BLACK_AGENT, {});
    assert.equal(blackFinal.status, 'running', '挂死方（黑）不被申诉路径误伤，仍等自身超时出口');
    void resolveBlack; // 挂死 promise 故意不 resolve（对齐真实挂死形态）
  } finally {
    if (host) await host.runtime.dispose().catch(() => {});
    if (cleanup) cleanup();
    uninstallFakeClock();
  }
});
