import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSqliteStore } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

function getModule() {
  return require('../dist-electron/main/sdkCronHostTrigger.js');
}

function getMirrorStoreModule() {
  return require('../dist-electron/main/sdkCronMirrorStore.js');
}

/** 分钟对齐的基准时刻（:40:00）。 */
const T0 = 1786218000000;
const MIN = 60_000;

// ---------------------------------------------------------------------------
// 纯函数：cron 到期计算
// ---------------------------------------------------------------------------

test('firstCronMatchAfter: one-shot fires at the first match strictly after createdAt', () => {
  const { firstCronMatchAfter } = getModule();
  // */10 → :00 :10 :20 :30 :40 :50；createdAt :37 → 首次匹配 :40
  const createdAt = T0 - 3 * MIN;
  const first = firstCronMatchAfter('*/10 * * * *', createdAt);
  assert.equal(first, T0);
  // createdAt 恰为匹配时刻（:40）→ 该时刻不算（严格之后），下次为 :50（+10min）
  assert.equal(firstCronMatchAfter('*/10 * * * *', T0), T0 + 10 * MIN);
  // 无效表达式
  assert.equal(firstCronMatchAfter('not a cron', T0), null);
});

test('lastCronMatchIn: recurring takes the latest due instance, strictly after lower bound', () => {
  const { lastCronMatchIn } = getModule();
  // (03:37, 03:40] → 03:40
  assert.equal(lastCronMatchIn('*/10 * * * *', T0 - 3 * MIN, T0), T0);
  // 窗口内无匹配（下一个是 03:50）
  assert.equal(lastCronMatchIn('*/10 * * * *', T0, T0 + 4 * MIN), null);
  // 与下界相等的匹配不算
  assert.equal(lastCronMatchIn('*/10 * * * *', T0, T0 + MIN), null);
  // 无效表达式
  assert.equal(lastCronMatchIn('bad', T0, T0 + MIN), null);
});

test('lastCronMatchBefore: previous match strictly before the reference', () => {
  const { lastCronMatchBefore } = getModule();
  // 03:47 之前最近一次 */10 匹配 = 03:40
  assert.equal(lastCronMatchBefore('*/10 * * * *', T0 + 7 * MIN), T0);
  // 恰在匹配时刻（:40）→ 严格之前 → 上一个为 :30（-10min）
  assert.equal(lastCronMatchBefore('*/10 * * * *', T0), T0 - 10 * MIN);
});

test('isSevenDayExpired: boundary at exactly 7 days', () => {
  const { isSevenDayExpired, SDK_CRON_SEVEN_DAY_MS } = getModule();
  assert.equal(isSevenDayExpired(T0 - 8 * 24 * 3600 * 1000, T0), true);
  assert.equal(isSevenDayExpired(T0 - SDK_CRON_SEVEN_DAY_MS, T0), true);
  assert.equal(isSevenDayExpired(T0 - SDK_CRON_SEVEN_DAY_MS + 60_000, T0), false);
  assert.equal(isSevenDayExpired(null, T0), false);
});

// ---------------------------------------------------------------------------
// 纯函数：文件改写 / lock 解析 / 进程探测 / 遍历 / 标题
// ---------------------------------------------------------------------------

test('removeTasksFromFile removes only the given ids and preserves the rest', () => {
  const { removeTasksFromFile } = getModule();
  const content = JSON.stringify({
    tasks: [
      { id: 'aaa', cron: '0 4 * * *', prompt: 'A', createdAt: 1, recurring: true, createdBySessionId: 's1' },
      { id: 'bbb', cron: '30 9 * * 1-5', prompt: 'B', createdAt: 2, recurring: false },
      { id: 'ccc', cron: '* * * * *', prompt: 'C', createdAt: 3, recurring: true },
    ],
  }, null, 2);
  const next = removeTasksFromFile(content, ['bbb']);
  assert.ok(next !== null);
  const parsed = JSON.parse(next);
  assert.deepEqual(parsed.tasks.map((t) => t.id), ['aaa', 'ccc']);
  // 保留字段原样（含 createdAt）
  assert.equal(parsed.tasks[1].createdAt, 3);
  // 无变化 → null；非法内容 → null
  assert.equal(removeTasksFromFile(content, ['nonexistent']), null);
  assert.equal(removeTasksFromFile('not json', ['aaa']), null);
  assert.equal(removeTasksFromFile('{"other": 1}', ['aaa']), null);
});

test('parseLockFile and isPidAlive', () => {
  const { parseLockFile, isPidAlive } = getModule();
  assert.deepEqual(
    parseLockFile('{"sessionId":"sess-1","pid":12345,"procStart":"x","acquiredAt":1}'),
    { sessionId: 'sess-1', pid: 12345 }
  );
  assert.deepEqual(parseLockFile('{"pid":null}'), { sessionId: null, pid: null });
  assert.equal(parseLockFile('not json'), null);
  // 合法 JSON 对象但无 sessionId/pid 字段 → 结构化空结果（调用方据此视为未上锁）
  assert.deepEqual(parseLockFile('{"a":1}'), { sessionId: null, pid: null });
  // 自身进程存活；不存在的 pid 死亡
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(999999999), false);
  assert.equal(isPidAlive(0), false);
});

test('findScheduledTasksJsonFiles walks workspaces and skips node_modules/.git/hidden', () => {
  const { findScheduledTasksJsonFiles } = getModule();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-cron-find-'));
  try {
    const ws1 = path.join(root, 'bots', '15', '2026-08-09');
    const ws2 = path.join(root, 'bots', '1', '2026-08-09');
    const nodeMod = path.join(root, 'node_modules', 'x');
    const hidden = path.join(root, '.hidden');
    for (const dir of [ws1, ws2, nodeMod, hidden]) {
      fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.claude', 'scheduled_tasks.json'), '{"tasks":[]}');
    }
    // 深度限制：root 下 5 层之内才可达（bots/15/2026-08-09 = 4 层）
    const found = findScheduledTasksJsonFiles(root).sort();
    assert.deepEqual(found, [path.join(ws1, '.claude', 'scheduled_tasks.json'), path.join(ws2, '.claude', 'scheduled_tasks.json')].sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildSdkCronSessionTitle derives a recognizable title from the prompt', () => {
  const { buildSdkCronSessionTitle } = getModule();
  assert.ok(buildSdkCronSessionTitle('每日报告\nsecond line').startsWith('[SDK cron] 每日报告'));
  assert.ok(buildSdkCronSessionTitle('').includes('[SDK cron]'));
});

// ---------------------------------------------------------------------------
// 触发状态存储（sqlite）
// ---------------------------------------------------------------------------

test('log store: dispatch dedup by (cronId, fireMs)', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const { SdkCronHostTriggerLogStore } = getModule();
    const store = new SdkCronHostTriggerLogStore(db, () => undefined);
    assert.equal(store.getState('c1'), null);
    store.markDispatched('c1', T0, 'sess-9');
    const state = store.getState('c1');
    assert.equal(state.cronId, 'c1');
    assert.equal(state.fireMs, T0);
    assert.equal(state.status, 'dispatched');
    assert.equal(state.sessionId, 'sess-9');
    assert.equal(store.isHandled('c1', T0), true);
    assert.equal(store.isHandled('c1', T0 + MIN), false);
    // 同一点重新 dispatch（覆盖）：仍为已处理
    store.markDispatched('c1', T0, 'sess-10');
    assert.equal(store.isHandled('c1', T0), true);
    assert.equal(store.getState('c1').sessionId, 'sess-10');
    // failed 视为未处理（可重试）
    store.markFailed('c1', T0);
    assert.equal(store.getState('c1').status, 'failed');
    assert.equal(store.getState('c1').fireMs, T0);
    assert.equal(store.isHandled('c1', T0), false);
    // completed 视为已处理
    store.markDispatched('c1', T0, 'sess-11');
    store.markCompleted('c1');
    assert.equal(store.isHandled('c1', T0), true);
    assert.equal(store.getState('c1').status, 'completed');
  } finally {
    cleanup();
  }
});

test('log store: advanceCoverage only moves forward and inserts sdk_covered rows', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const { SdkCronHostTriggerLogStore } = getModule();
    const store = new SdkCronHostTriggerLogStore(db, () => undefined);
    // 无既有行 → 插入 sdk_covered
    assert.equal(store.advanceCoverage('c1', T0), true);
    assert.equal(store.getState('c1').status, 'sdk_covered');
    assert.equal(store.isHandled('c1', T0), true);
    // 向前推进
    assert.equal(store.advanceCoverage('c1', T0 + 2 * MIN), true);
    assert.equal(store.getState('c1').fireMs, T0 + 2 * MIN);
    // 回退不生效
    assert.equal(store.advanceCoverage('c1', T0), false);
    assert.equal(store.getState('c1').fireMs, T0 + 2 * MIN);
    // dispatched 行被推进时保留 status
    store.markDispatched('c1', T0 + 5 * MIN, 'sess-1');
    store.advanceCoverage('c1', T0 + 6 * MIN);
    assert.equal(store.getState('c1').status, 'dispatched');
    assert.equal(store.getState('c1').fireMs, T0 + 6 * MIN);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 桥：端到端（真实临时目录 + 内存 sqlite，注入记录型 launcher）
// ---------------------------------------------------------------------------

const mkTask = (overrides = {}) => ({
  id: 'cron-1',
  cron: '*/10 * * * *',
  prompt: 'run report',
  createdAt: T0 - 3 * MIN,
  recurring: true,
  createdBySessionId: 'creator-sess',
  ...overrides,
});

function makeTaskFile(task) {
  return JSON.stringify({ tasks: [task] }, null, 2);
}

test('bridge: one-shot due fires once, entry removed, mirror marked deleted, state recorded', async () => {
  const harness = await createRealHarness();
  try {
    const { bridge, files, launches, mirrorDeleted, logStore } = harness;
    const task = mkTask({ recurring: false });
    const file = path.join(harness.root, '.claude', 'scheduled_tasks.json');
    files.set(file, makeTaskFile(task));

    const report = await bridge.scanAndTrigger(harness.root);

    assert.equal(report.triggered.length, 1);
    assert.equal(report.triggered[0].cronId, 'cron-1');
    assert.equal(report.triggered[0].fireMs, T0);
    assert.equal(report.triggered[0].recurring, false);
    assert.equal(launches.length, 1);
    assert.equal(launches[0].title, '[SDK cron] run report');
    assert.equal(launches[0].cwd, harness.root);
    assert.equal(launches[0].prompt, 'run report');
    // 一次性触发后从文件移除
    assert.deepEqual(JSON.parse(files.get(file)).tasks, []);
    // 镜像同步 deleted
    assert.deepEqual(mirrorDeleted, ['cron-1']);
    // 触发状态已记录（防重复）
    const state = logStore.getState('cron-1');
    assert.equal(state.fireMs, T0);
    assert.equal(state.status, 'dispatched');
    assert.equal(state.sessionId, 'sess-1');
    // 再次扫描同一点 → 不再触发（无双触发）
    const report2 = await bridge.scanAndTrigger(harness.root);
    assert.equal(report2.triggered.length, 0);
    assert.equal(launches.length, 1);
  } finally {
    harness.cleanup();
  }
});

test('bridge: recurring due fires and keeps the file entry; next instance fires later', async () => {
  const harness = await createRealHarness();
  try {
    const { bridge, files, launches } = harness;
    const file = path.join(harness.root, '.claude', 'scheduled_tasks.json');
    files.set(file, makeTaskFile(mkTask({ recurring: true })));

    // 03:40 到点触发
    const report1 = await bridge.scanAndTrigger(harness.root);
    assert.equal(report1.triggered.length, 1);
    assert.equal(launches.length, 1);
    // recurring 条目保留在文件中（SDK 继续按 cron 调度）
    assert.equal(JSON.parse(files.get(file)).tasks.length, 1);

    // 03:45 扫描：无新到点实例 → 不触发
    harness.setClock(T0 + 5 * MIN);
    const report2 = await bridge.scanAndTrigger(harness.root);
    assert.equal(report2.triggered.length, 0);
    assert.equal(launches.length, 1);

    // 03:50 扫描：下一个实例到点 → 再次触发（recurring 续排）
    harness.setClock(T0 + 10 * MIN);
    const report3 = await bridge.scanAndTrigger(harness.root);
    assert.equal(report3.triggered.length, 1);
    assert.equal(report3.triggered[0].fireMs, T0 + 10 * MIN);
    assert.equal(launches.length, 2);
    assert.equal(JSON.parse(files.get(file)).tasks.length, 1);
  } finally {
    harness.cleanup();
  }
});

test('bridge: file skipped entirely when a session is running in the cwd', async () => {
  const harness = await createRealHarness({ isSessionRunningInCwd: () => true });
  try {
    const { bridge, files, launches } = harness;
    const file = path.join(harness.root, '.claude', 'scheduled_tasks.json');
    files.set(file, makeTaskFile(mkTask({ recurring: false })));
    const report = await bridge.scanAndTrigger(harness.root);
    assert.equal(report.skippedFiles.length, 1);
    assert.ok(report.skippedFiles[0].reason.includes('session'));
    assert.equal(report.triggered.length, 0);
    assert.equal(launches.length, 0);
    // 文件未被改写
    assert.equal(JSON.parse(files.get(file)).tasks.length, 1);
  } finally {
    harness.cleanup();
  }
});

test('bridge: live lock holder blocks the file; dead lock pid does not', async () => {
  const { parseLockFile } = getModule();
  void parseLockFile;
  const lockContent = JSON.stringify({ sessionId: 'sess-x', pid: 999999999, procStart: 'x', acquiredAt: 1 });

  // 存活锁 → 跳过
  const harnessLive = await createRealHarness({ isPidAlive: () => true });
  try {
    const file = path.join(harnessLive.root, '.claude', 'scheduled_tasks.json');
    harnessLive.files.set(file, makeTaskFile(mkTask({ recurring: false })));
    harnessLive.files.set(path.join(harnessLive.root, '.claude', 'scheduled_tasks.lock'), lockContent);
    const report = await harnessLive.bridge.scanAndTrigger(harnessLive.root);
    assert.equal(report.skippedFiles.length, 1);
    assert.ok(report.skippedFiles[0].reason.includes('lock'));
    assert.equal(harnessLive.launches.length, 0);
  } finally {
    harnessLive.cleanup();
  }

  // 死锁 pid → 正常触发
  const harnessDead = await createRealHarness({ isPidAlive: () => false });
  try {
    const file = path.join(harnessDead.root, '.claude', 'scheduled_tasks.json');
    harnessDead.files.set(file, makeTaskFile(mkTask({ recurring: false })));
    harnessDead.files.set(path.join(harnessDead.root, '.claude', 'scheduled_tasks.lock'), lockContent);
    const report = await harnessDead.bridge.scanAndTrigger(harnessDead.root);
    assert.equal(report.skippedFiles.length, 0);
    assert.equal(report.triggered.length, 1);
    assert.equal(harnessDead.launches.length, 1);
  } finally {
    harnessDead.cleanup();
  }
});

test('bridge: 7-day-expired recurring task is removed without firing', async () => {
  const harness = await createRealHarness();
  try {
    const { bridge, files, launches, mirrorDeleted } = harness;
    const file = path.join(harness.root, '.claude', 'scheduled_tasks.json');
    const expired = mkTask({ createdAt: T0 - 8 * 24 * 3600 * 1000, recurring: true });
    files.set(file, makeTaskFile(expired));
    const report = await bridge.scanAndTrigger(harness.root);
    assert.equal(report.expired.length, 1);
    assert.equal(report.triggered.length, 0);
    assert.equal(launches.length, 0);
    assert.deepEqual(JSON.parse(files.get(file)).tasks, []);
    assert.deepEqual(mirrorDeleted, ['cron-1']);
  } finally {
    harness.cleanup();
  }
});

test('bridge: launch failure marks failed, one-shot entry kept, retried next scan', async () => {
  let fail = true;
  let retryLaunches = 0;
  const harness = await createRealHarness({
    launchSession: async () => {
      if (fail) throw new Error('spawn failed');
      retryLaunches += 1;
      return 'sess-ok';
    },
  });
  try {
    const { bridge, files, logStore } = harness;
    const file = path.join(harness.root, '.claude', 'scheduled_tasks.json');
    files.set(file, makeTaskFile(mkTask({ recurring: false })));

    const report1 = await bridge.scanAndTrigger(harness.root);
    assert.equal(report1.failed.length, 1);
    assert.equal(report1.triggered.length, 0);
    assert.equal(logStore.getState('cron-1').status, 'failed');
    assert.equal(logStore.getState('cron-1').fireMs, T0);
    // 失败时一次性条目保留（等待重试）
    assert.equal(JSON.parse(files.get(file)).tasks.length, 1);

    // 重试成功
    fail = false;
    const report2 = await bridge.scanAndTrigger(harness.root);
    assert.equal(report2.triggered.length, 1);
    assert.equal(report2.triggered[0].sessionId, 'sess-ok');
    assert.equal(retryLaunches, 1);
    assert.deepEqual(JSON.parse(files.get(file)).tasks, []);
  } finally {
    harness.cleanup();
  }
});

test('bridge: stale one-shot entry after successful dispatch is self-healed without relaunch', async () => {
  const harness = await createRealHarness();
  try {
    const { bridge, files, launches } = harness;
    const file = path.join(harness.root, '.claude', 'scheduled_tasks.json');
    files.set(file, makeTaskFile(mkTask({ recurring: false })));
    await bridge.scanAndTrigger(harness.root);
    assert.equal(launches.length, 1);
    // 模拟上次写盘失败：条目仍在文件中，但状态已 dispatched
    files.set(file, makeTaskFile(mkTask({ recurring: false })));
    const report = await bridge.scanAndTrigger(harness.root);
    assert.equal(report.cleaned.length, 1);
    assert.equal(report.triggered.length, 0);
    assert.equal(launches.length, 1); // 未重复拉起
    assert.deepEqual(JSON.parse(files.get(file)).tasks, []);
  } finally {
    harness.cleanup();
  }
});

test('bridge: session-end coverage advance prevents refiring an SDK-covered instance', async () => {
  const harness = await createRealHarness();
  try {
    const { bridge, files, launches, logStore } = harness;
    const file = path.join(harness.root, '.claude', 'scheduled_tasks.json');
    files.set(file, makeTaskFile(mkTask({ recurring: true })));
    // 宿主先触发 03:40 实例
    await bridge.scanAndTrigger(harness.root);
    assert.equal(launches.length, 1);

    // 会话运行至 03:52，SDK 覆盖 03:50 实例 → 会话结束推进
    bridge.advanceSessionCoverage([{ id: 'cron-1', schedule: '*/10 * * * *' }], T0 + 12 * MIN);
    assert.equal(logStore.getState('cron-1').fireMs, T0 + 10 * MIN);

    // 03:55 扫描：03:50 已被 SDK 覆盖 → 不触发（无双发）
    harness.setClock(T0 + 15 * MIN);
    const report = await bridge.scanAndTrigger(harness.root);
    assert.equal(report.triggered.length, 0);
    assert.equal(launches.length, 1);

    // 04:00 扫描：下一实例到点 → 正常触发（recurring 续排不受影响）
    harness.setClock(T0 + 20 * MIN);
    const report2 = await bridge.scanAndTrigger(harness.root);
    assert.equal(report2.triggered.length, 1);
    assert.equal(report2.triggered[0].fireMs, T0 + 20 * MIN);
    assert.equal(launches.length, 2);
  } finally {
    harness.cleanup();
  }
});

test('bridge: sdk-covered one-shot stale entry is removed without firing', async () => {
  const harness = await createRealHarness();
  try {
    const { bridge, files, launches } = harness;
    const file = path.join(harness.root, '.claude', 'scheduled_tasks.json');
    files.set(file, makeTaskFile(mkTask({ recurring: false })));
    // 会话在 03:40 实例后结束（SDK 已覆盖该实例，但文件条目残留）
    bridge.advanceSessionCoverage([{ id: 'cron-1', schedule: '*/10 * * * *' }], T0 + 3 * MIN);
    const report = await bridge.scanAndTrigger(harness.root);
    assert.equal(report.triggered.length, 0);
    assert.equal(report.cleaned.length, 1);
    assert.equal(launches.length, 0);
    assert.deepEqual(JSON.parse(files.get(file)).tasks, []);
  } finally {
    harness.cleanup();
  }
});

test('bridge: not-yet-due one-shot does nothing', async () => {
  const harness = await createRealHarness();
  try {
    const { bridge, files, launches } = harness;
    const file = path.join(harness.root, '.claude', 'scheduled_tasks.json');
    // 首次匹配 03:40，当前 03:35 → 未到点
    harness.setClock(T0 - 5 * MIN);
    files.set(file, makeTaskFile(mkTask({ recurring: false })));
    const report = await bridge.scanAndTrigger(harness.root);
    assert.equal(report.triggered.length, 0);
    assert.equal(report.cleaned.length, 0);
    assert.equal(launches.length, 0);
    assert.equal(JSON.parse(files.get(file)).tasks.length, 1);
  } finally {
    harness.cleanup();
  }
});

test('bridge + mirror store: file removal reconciles the mirror to deleted', async () => {
  const { SdkCronHostTriggerLogStore, SdkCronHostTriggerBridge } = getModule();
  const { SdkCronMirrorStore } = getMirrorStoreModule();
  const { db, cleanup } = await createSqliteStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-cron-mirror-reconcile-'));
  try {
    const mirror = new SdkCronMirrorStore(db, () => undefined);
    const logStore = new SdkCronHostTriggerLogStore(db, () => undefined);
    // markMirrorDeleted 接真实镜像 store（与 main.ts 接线一致）
    const bridge = new SdkCronHostTriggerBridge({
      logStore,
      getConfig: () => ({ systemPrompt: 'b', executionMode: 'auto' }),
      getSkillsPrompt: async () => null,
      getSession: () => null,
      isSessionRunningInCwd: () => false,
      launchSession: async () => 'sess-1',
      markMirrorDeleted: (cronId) => { mirror.markDeleted(cronId); },
      now: () => T0,
      fileExists: (p) => fs.existsSync(p),
      isPidAlive: () => false,
    });
    const file = path.join(root, '.claude', 'scheduled_tasks.json');
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(file, makeTaskFile(mkTask({ recurring: false })), 'utf8');
    // 先镜像（文件扫描语义）：active
    mirror.upsert({ id: 'cron-1', schedule: '*/10 * * * *', recurring: false, prompt: 'run report', durable: true }, 'creator-sess', 'file_scan');
    assert.equal(mirror.getById('cron-1').status, 'active');

    // 宿主触发 + 移除文件条目 + 镜像 markDeleted（接线中的 markMirrorDeleted）
    const report = await bridge.scanAndTrigger(root);
    assert.equal(report.triggered.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).tasks, []);
    assert.equal(mirror.getById('cron-1').status, 'deleted');

    // 下一次镜像对账（reconcileDurableFile 语义）：文件里已无该任务 → 保持 deleted，无反复
    const reconcile = mirror.reconcileDurableFile('creator-sess', []);
    assert.equal(reconcile.deleted, 0);
    assert.equal(mirror.getById('cron-1').status, 'deleted');
  } finally {
    cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 真实临时目录 + 内存 sqlite 的 harness（读取真实文件系统）
// ---------------------------------------------------------------------------

async function createRealHarness(overrides = {}) {
  const { createSqliteStore } = await import('./memoryTestUtils.mjs');
  const { SdkCronHostTriggerLogStore, SdkCronHostTriggerBridge } = getModule();
  const { db, cleanup } = await createSqliteStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-cron-trigger-'));
  const launches = [];
  const mirrorDeleted = [];
  const logs = [];
  let clock = T0;

  const logStore = new SdkCronHostTriggerLogStore(db, () => undefined);
  const bridge = new SdkCronHostTriggerBridge({
    logStore,
    getConfig: () => ({ systemPrompt: 'base system', executionMode: 'auto' }),
    getSkillsPrompt: async () => 'skills prompt',
    getSession: () => null,
    isSessionRunningInCwd: () => false,
    launchSession: async (spec) => {
      launches.push(spec);
      return `sess-${launches.length}`;
    },
    markMirrorDeleted: (cronId) => mirrorDeleted.push(cronId),
    now: () => clock,
    fileExists: (p) => fs.existsSync(p),
    isPidAlive: () => false,
    logger: (m) => logs.push(m),
    ...overrides,
  });

  // 真实文件系统接口：readFile/writeFile 用默认（fs）
  return {
    db,
    root,
    launches,
    mirrorDeleted,
    logs,
    logStore,
    bridge,
    files: {
      set: (p, content) => {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content, 'utf8');
      },
      get: (p) => fs.readFileSync(p, 'utf8'),
      has: (p) => fs.existsSync(p),
    },
    setClock: (ms) => { clock = ms; },
    cleanup: () => {
      cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

// 避免误用未使用的同步 harness（保留占位说明）
test('bridge: scanAndTrigger respects the rootDir walker (real files)', async () => {
  const harness = await createRealHarness();
  try {
    // 两个工作区：一个到点（无活跃会话）一个未到点
    const ws1 = path.join(harness.root, 'ws-a');
    const ws2 = path.join(harness.root, 'ws-b');
    fs.mkdirSync(path.join(ws1, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(ws2, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(ws1, '.claude', 'scheduled_tasks.json'), JSON.stringify({ tasks: [mkTask({ id: 'a1', recurring: false })] }, null, 2));
    fs.writeFileSync(path.join(ws2, '.claude', 'scheduled_tasks.json'), JSON.stringify({ tasks: [{ ...mkTask({ id: 'b1', recurring: true }), cron: '0 0 1 1 *' }] }, null, 2));

    const report = await harness.bridge.scanAndTrigger(harness.root);
    assert.equal(report.filesScanned, 2);
    assert.equal(report.triggered.length, 1);
    assert.equal(report.triggered[0].cronId, 'a1');
    // ws-a 条目已移除；ws-b 未到点条目保留
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ws1, '.claude', 'scheduled_tasks.json'), 'utf8')).tasks, []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(ws2, '.claude', 'scheduled_tasks.json'), 'utf8')).tasks.length, 1);
  } finally {
    harness.cleanup();
  }
});
