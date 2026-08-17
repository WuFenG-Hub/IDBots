import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { CoworkCrossSessionService } = require('../dist-electron/main/services/coworkCrossSession.js');
const {
  notifySourceSessionReview,
  setGroupTaskAcceptanceNotifier,
  setGroupTaskServiceKvStoreGetter,
  setGroupTaskServiceGroupTaskStoreGetter,
  setGroupTaskServiceMetabotStoreGetter,
} = require('../dist-electron/main/services/groupTaskService.js');
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { GroupTaskStore } = require('../dist-electron/main/groupTaskStore.js');
const { MetabotStore } = require('../dist-electron/main/metabotStore.js');
const {
  buildAcceptanceSummary,
  buildAcceptanceSummaryMessageText,
} = require('../dist-electron/main/services/groupTaskAcceptanceSummary.js');

// ---------------------------------------------------------------------------
// §1a P4: the host pseudo-source `group-task:<id>` passes the cross-session seam
// ---------------------------------------------------------------------------

class FakeSessionStore {
  constructor() {
    this.sessions = new Map();
  }
  getSession(id) { return this.sessions.get(id) ?? null; }
  getSessionMetadata(id) { return this.sessions.get(id) ?? null; }
  getSessionLatestMessage(id) {
    const s = this.sessions.get(id);
    return s ? s.messages[s.messages.length - 1] ?? null : null;
  }
  getSessionLatestVisibleMessage(id) { return this.getSessionLatestMessage(id); }
  addMessage(id, message) {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Session ${id} not found`);
    const stored = { id: `m-${s.messages.length + 1}`, timestamp: 1, ...message };
    s.messages.push(stored);
    return stored;
  }
}

test('P4: a group-task:<id> pseudo-source inserts without a session row; a missing real source still fails', () => {
  const store = new FakeSessionStore();
  store.sessions.set('origin-session', { id: 'origin-session', messages: [], sessionType: 'standard' });
  const service = new CoworkCrossSessionService(store);

  const ok = service.insertUserMessage({
    sourceSessionId: 'group-task:23',
    targetSessionId: 'origin-session',
    message: '[GROUP_TASK_ACCEPTANCE] 任务「T」已完成验收：结果：done',
  });
  assert.equal(ok.ok, true, 'pseudo source passes (task #23 regression: SESSION_NOT_FOUND)');
  assert.match(ok.message.content, /来自group-task:23 的信息/);

  const missing = service.insertUserMessage({
    sourceSessionId: 'not-a-real-session',
    targetSessionId: 'origin-session',
    message: 'x',
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'SESSION_NOT_FOUND');
});

// ---------------------------------------------------------------------------
// §1b P4: notifySourceSessionReview (service side)
// ---------------------------------------------------------------------------

test('P4: review report reaches the origin session once, prefixed and capped, kv-guarded', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-v12-'));
  const store = await SqliteStore.create(tempDir);
  try {
    const db = store.getDatabase();
    const metabotStore = new MetabotStore(db, store.getSaveFunction());
    const groupTaskStore = new GroupTaskStore(db, store.getSaveFunction());
    setGroupTaskServiceKvStoreGetter(() => store);
    setGroupTaskServiceGroupTaskStoreGetter(() => groupTaskStore);
    setGroupTaskServiceMetabotStoreGetter(() => metabotStore);

    const task = groupTaskStore.createTask({
      groupId: 'g1', title: 'T', goal: 'G', acceptanceCriteria: null,
      chairMetabotId: 1, createdBy: 'user', createPinId: 'pc', sourceSessionId: 'origin-session',
    });

    const delivered = [];
    setGroupTaskAcceptanceNotifier(({ targetSessionId, message }) => {
      delivered.push({ targetSessionId, message });
      return { ok: true };
    });

    const longBody = 'X'.repeat(1800);
    notifySourceSessionReview(task, longBody);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].targetSessionId, 'origin-session');
    assert.match(delivered[0].message, /^\[GROUP_TASK_REVIEW\] 任务「T」已进入验收，chair 报告如下：/);
    assert.ok(delivered[0].message.length < 1800, 'body capped (concise, not a dump)');
    assert.match(delivered[0].message, /报告过长已截断/);

    // kv guard: a second call within the same review entry does not re-deliver.
    notifySourceSessionReview(task, 'again');
    assert.equal(delivered.length, 1);

    // Guard key exists; a task without sourceSessionId never notifies.
    const panelTask = groupTaskStore.createTask({
      groupId: 'g2', title: 'P', goal: 'G', acceptanceCriteria: null,
      chairMetabotId: 1, createdBy: 'user', createPinId: 'pc2',
    });
    notifySourceSessionReview(panelTask, 'nope');
    assert.equal(delivered.length, 1, 'panel-created task (no source) silently skips');
  } finally {
    setGroupTaskAcceptanceNotifier(null);
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §3 P12: concise group summary message
// ---------------------------------------------------------------------------

test('P12: long goal/criteria render as truncated previews in the group message', () => {
  const longGoal = 'G'.repeat(313);
  const longCriteria = 'C'.repeat(162);
  const result = buildAcceptanceSummary({
    task: { title: 'T', goal: longGoal, acceptanceCriteria: longCriteria },
    deliverables: [],
    members: [],
  });
  assert.match(result.messageText, /目标：G{160}…/);
  assert.match(result.messageText, /验收标准：C{160}…/);
  assert.ok(!result.messageText.includes(longGoal), 'full 313-char goal not dumped');
  // Short texts render in full.
  const short = buildAcceptanceSummaryMessageText(
    { goal: 'short goal', acceptanceCriteria: 'short criteria', deliverables: [], members: [], guidance: 'g' },
    'T',
  );
  assert.match(short, /目标：short goal/);
  assert.match(short, /验收标准：short criteria/);
});

// ---------------------------------------------------------------------------
// Static: daemon wiring — review entry calls the source-session dep once per
// review; the rework hatch clears the guard so the next review re-reports.
// ---------------------------------------------------------------------------

test('daemon wiring: maybeSendOwnerReport also notifies the source session; rework hatch clears the guard', async () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'src', 'main', 'services', 'groupTaskDaemon.ts'),
    'utf8',
  );
  assert.ok(
    source.includes('deps.sendReviewReportToSourceSession({ taskId: task.id, report })'),
    'maybeSendOwnerReport delivers the same report body to the source session',
  );
  assert.match(source, /sendReviewReportToSourceSession\?: \(input: \{ taskId: number; report: string \}\) => void/);
  assert.ok(
    source.includes('getStore().delete(`${GROUP_TASK_REVIEW_NOTIFIED_KV_PREFIX}${task.id}`)'),
    'rework hatch clears the review guard',
  );
  assert.ok(
    fs.readFileSync(path.join(projectRoot, 'src', 'main', 'main.ts'), 'utf8')
      .includes('sendReviewReportToSourceSession: ({ taskId, report }) =>'),
    'main wires the dep',
  );
});
