import assert from 'node:assert/strict';
import test from 'node:test';
import { createMobileMockBridge, MOCK_CANNED_REPLIES } from '../src/mobile/bridge/mockBridge.ts';
import { CoworkStreamReassembler } from '../src/renderer/services/coworkStreamReassembly.ts';
import type { MockBridgeOptions } from '../src/mobile/bridge/types.ts';

/**
 * REQ-E-25 (mock part): the mock bridge must faithfully back every scenario
 * the T1 demo page and the T3 Playwright suite rely on. All delays are
 * shrunk so the suite finishes in milliseconds.
 */

function makeBridge(overrides: MockBridgeOptions = {}) {
  return createMobileMockBridge({
    streamTokenIntervalMs: 1,
    orderCompleteDelayMs: 60,
    reconnectBlackoutMs: 30,
    scheduledRunDelayMs: 40,
    systemLocale: 'en-US',
    ...overrides,
  });
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for: ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test('streaming reply accumulates through the real reassembler and completes once', async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.destroy());
  const api = bridge.electron;

  const reassembler = new CoworkStreamReassembler();
  let accumulated: string | null = null;
  const completes: Array<{ sessionId: string; claudeSessionId: string | null }> = [];
  let messageEvents = 0;
  const offs = [
    api.cowork.onStreamMessage(() => {
      messageEvents += 1;
    }),
    api.cowork.onStreamMessageUpdate((payload) => {
      const result = reassembler.apply(payload);
      if (result.kind === 'full' || result.kind === 'append') {
        accumulated = result.text;
      }
    }),
    api.cowork.onStreamComplete((payload) => completes.push(payload)),
  ];

  const started = await api.cowork.startSession({ prompt: 'hello there' });
  assert.equal(started.success, true);
  assert.ok(started.session);
  const sessionId = started.session.id;

  await waitFor(() => completes.length === 1, 'stream completion');
  assert.equal(completes.length, 1);
  assert.equal(completes[0].sessionId, sessionId);
  assert.equal(accumulated, MOCK_CANNED_REPLIES.normal);
  assert.equal(messageEvents, 1);

  // The persisted session also carries the accumulated assistant text.
  const fetched = await api.cowork.getSession(sessionId);
  assert.equal(fetched.success, true);
  const assistant = fetched.session.messages.find((m) => m.type === 'assistant');
  assert.equal(assistant?.content, MOCK_CANNED_REPLIES.normal);

  for (const off of offs) off();

  // After unsubscribing, a second turn produces no events for this listener set.
  await api.cowork.submitInput({ sessionId, submissionId: 's2', text: 'again' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(messageEvents, 1);
  assert.equal(completes.length, 1);
});

test('permission request arrives, resolves via respond, and empties the pending list', async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.destroy());
  const api = bridge.electron;

  const requests: Array<{ sessionId: string; request: { requestId: string; toolName: string } }> = [];
  const resolved: Array<{ requestId: string }> = [];
  const completes: unknown[] = [];
  const offs = [
    api.cowork.onStreamPermission((payload) => requests.push(payload)),
    api.cowork.onStreamPermissionResolved((payload) => resolved.push(payload)),
    api.cowork.onStreamComplete(() => completes.push({})),
  ];

  // Aligned with the real contract: mobile.listPendingPermissions resolves
  // with a bare array on success (no { success, pending } envelope).
  const before = await api.mobile.listPendingPermissions();
  assert.ok(Array.isArray(before));
  assert.deepEqual(before, []);

  const started = await api.cowork.startSession({ prompt: 'please run the permission demo' });
  assert.equal(started.success, true);
  await waitFor(() => requests.length === 1, 'permission request');

  assert.equal(requests[0].sessionId, started.session.id);
  assert.equal(requests[0].request.toolName, 'write_file');

  const during = await api.mobile.listPendingPermissions();
  assert.ok(Array.isArray(during));
  assert.equal(during.length, 1);
  assert.equal(during[0].request.requestId, requests[0].request.requestId);
  assert.equal(typeof during[0].createdAt, 'number');

  const response = await api.cowork.respondToPermission({
    requestId: requests[0].request.requestId,
    result: { behavior: 'allow' },
  });
  assert.equal(response.success, true);

  await waitFor(() => resolved.length === 1 && completes.length === 1, 'permission resolution and completion');
  assert.equal(resolved[0].requestId, requests[0].request.requestId);

  const after = await api.mobile.listPendingPermissions();
  assert.deepEqual(after, []);

  // A second response to the same requestId is an unknown request.
  const again = await api.cowork.respondToPermission({
    requestId: requests[0].request.requestId,
    result: { behavior: 'deny' },
  });
  assert.equal(again.success, false);

  for (const off of offs) off();
});

test('quota trigger settles as a stream:error frame with LLM_QUOTA_EXHAUSTED metadata', async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.destroy());
  const api = bridge.electron;

  // Real contract (REQ-A-25, main.ts runner wiring): the quota death rides
  // the ERROR frame with metadata.errorCode; the completion frame never
  // carries quota metadata.
  const errors: Array<{ sessionId: string; error: string; metadata?: { errorCode?: string } }> = [];
  const completes: Array<{ sessionId: string; metadata?: { errorCode?: string } }> = [];
  const offErrors = api.cowork.onStreamError((payload) => errors.push(payload));
  const offCompletes = api.cowork.onStreamComplete((payload) => completes.push(payload));

  const started = await api.cowork.startSession({ prompt: 'what is my quota' });
  assert.equal(started.success, true);
  await waitFor(() => errors.length === 1, 'quota stream error');

  assert.equal(errors[0].sessionId, started.session.id);
  assert.equal(errors[0].metadata?.errorCode, 'LLM_QUOTA_EXHAUSTED');
  assert.match(errors[0].error, /free_quota_exhausted/);
  assert.equal(completes.length, 0);

  const fetched = await api.cowork.getSession(started.session.id);
  assert.equal(fetched.session.status, 'error');
  // The terminal error row is persisted exactly like the real runner's
  // handleError, so a reopened session still shows the failure.
  assert.ok(
    (fetched.session.messages as Array<{ type: string; content: string }>).some(
      (message) => message.type === 'system'
        && message.content.startsWith('Error:')
        && message.content.includes('free_quota_exhausted'),
    ),
  );
  offErrors();
  offCompletes();
});

test('scheduled-task run event arrives and the run shows up in history', async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.destroy());
  const api = bridge.electron;

  const runEvents: Array<{ run: { id: string; taskId: string; sessionId: string | null; status: string } }> = [];
  const off = api.scheduledTasks.onRunUpdate((payload) => runEvents.push(payload));

  const listed = await api.scheduledTasks.list();
  assert.equal(listed.success, true);
  assert.ok(Array.isArray(listed.tasks));
  assert.ok(listed.tasks.length >= 2);
  assert.ok(listed.tasks.some((task) => task.id === 'mock-task-1'));

  await waitFor(() => runEvents.length >= 1, 'scheduled run event');
  const run = runEvents[0].run;
  assert.equal(run.taskId, 'mock-task-1');
  assert.equal(run.status, 'success');
  assert.ok(run.sessionId);

  const history = await api.scheduledTasks.listRuns('mock-task-1');
  assert.equal(history.success, true);
  assert.ok(history.runs.some((r) => r.id === run.id));

  const allRuns = await api.scheduledTasks.listAllRuns();
  assert.ok(allRuns.runs.some((r) => r.id === run.id));

  // The run created an auto-origin cowork session, like a real scheduled run.
  const session = await api.cowork.getSession(run.sessionId ?? '');
  assert.equal(session.success, true);
  assert.equal(session.session.autoOrigin, 'schedule');

  const paged = await api.cowork.getSessionMessagesPage({ sessionId: run.sessionId ?? '', limit: 10 });
  assert.equal(paged.success, true);
  assert.ok(Array.isArray(paged.page.messages));
  off();
});

test('bundle order: created -> credited after the delay, meters rise', async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.destroy());
  const api = bridge.electron;

  const plans = await api.bundle.getPlans();
  assert.equal(plans.success, true);
  assert.equal(plans.plans.length, 2);
  const basic = plans.plans.find((p) => p.planId === 'bundle_basic_cny');
  assert.ok(basic);
  assert.equal(basic.payAmount, '129.00');
  assert.equal(basic.payCurrency, 'CNY');
  const pro = plans.plans.find((p) => p.planId === 'bundle_pro_cny');
  assert.equal(pro.payAmount, '179.00');

  const before = await api.bundle.getMeters();
  assert.equal(before.success, true);
  const trafficBefore = before.meters.traffic.balanceBytes;
  const llmTotalBefore = before.meters.llm.quotaTotal;

  const created = await api.bundle.createOrder({ planId: 'bundle_basic_cny' });
  assert.equal(created.success, true);
  assert.ok(created.order.gatewayParams.qrCode.startsWith('https://qr.alipay.com/mock'));
  assert.ok(created.order.expiresAt > Math.floor(Date.now() / 1000));

  const early = await api.bundle.getOrder({ orderId: created.order.orderId });
  assert.equal(early.order.status, 1);
  assert.equal('gatewayParams' in early.order, false);
  assert.equal('expiresAt' in early.order, false);

  let late = early;
  const deadline = Date.now() + 3000;
  while (late.order.status !== 3) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for the order to credit');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    const latest = await api.bundle.getOrder({ orderId: created.order.orderId });
    late = latest;
  }
  assert.equal(late.order.status, 3);
  assert.ok(late.order.paidAt <= Math.floor(Date.now() / 1000));
  assert.ok(late.order.creditedAt <= Math.floor(Date.now() / 1000));

  const after = await api.bundle.getMeters();
  assert.equal(after.meters.traffic.balanceBytes, trafficBefore + basic.trafficBytes);
  assert.equal(after.meters.llm.quotaTotal, llmTotalBefore + basic.llmQuota);
  assert.equal(after.meters.llm.quotaRemaining, after.meters.llm.quotaTotal - after.meters.llm.quotaUsed);
  assert.ok(after.meters.llm.quotaPurchased > 0);
});

test('reconnect: state sequence online -> reconnecting -> online, invokes reject offline', async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.destroy());
  const api = bridge.electron;

  const states: string[] = [];
  bridge.connection.onChange((state) => states.push(state));
  assert.equal(bridge.connection.getState(), 'online');

  bridge.control.simulateReconnect();
  assert.equal(bridge.connection.getState(), 'reconnecting');

  let rejected: Error | null = null;
  try {
    await api.cowork.listSessions();
  } catch (error) {
    rejected = error as Error;
  }
  assert.ok(rejected instanceof Error);
  assert.ok(!(rejected instanceof TypeError));
  assert.equal((rejected as { code?: string }).code, 'OFFLINE');
  assert.equal((rejected as { retryable?: boolean }).retryable, true);

  await waitFor(() => bridge.connection.getState() === 'online', 'back online');
  assert.deepEqual(states, ['reconnecting', 'online']);

  // Invokes work again after the blackout.
  const listed = await api.cowork.listSessions();
  assert.equal(listed.success, true);
});

test('S-tier channels answer locally with the specified shapes', async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.destroy());
  const api = bridge.electron;

  const initialized = await api.startup.rendererInitialized();
  assert.equal(initialized.success, true);

  assert.deepEqual(await api.getRecentCwds(), []);
  assert.equal(await api.window.isMaximized(), false);

  // Cancelled dialog shapes mirror the desktop main-process handlers.
  assert.deepEqual(await api.dialog.selectDirectory(), { success: true, path: null });
  assert.deepEqual(await api.dialog.selectFile(), { success: true, path: null, paths: [] });
  assert.deepEqual(await api.dialog.saveInlineFile({ dataBase64: 'AAAA' }), { success: true, path: null });

  const opened = await api.shell.openExternal('https://example.com/page');
  assert.equal(opened.success, true);
  const ignored = await api.shell.openExternal('file:///etc/passwd');
  assert.equal(ignored.success, false);
  assert.deepEqual(bridge.control.getOpenedUrls(), ['https://example.com/page']);

  const apps = await api.shell.getOpenWithApps('/data/workspace/a.txt');
  assert.deepEqual(apps, { success: true, apps: [] });
  const chosen = await api.shell.chooseOpenWithApp('/data/workspace/a.txt');
  assert.equal(chosen.success, false);
});

test('core fixtures: metabots, identity, skills, store, appInfo, sessions', async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.destroy());
  const api = bridge.electron;

  const bots = await api.metabot.list();
  assert.equal(bots.success, true);
  assert.equal(bots.list.length, 2);
  assert.ok(bots.list.some((b) => b.metabot_type === 'twin'));

  const identity = await api.userIdentity.get();
  assert.equal(identity.success, true);
  assert.ok(identity.identity.metaid);

  const skills = await api.skills.list();
  assert.equal(skills.success, true);
  assert.ok(skills.skills.length >= 2);

  assert.equal(await api.appInfo.getVersion(), '1.0.2-mobile.mock');
  assert.equal(await api.appInfo.getSystemLocale(), 'en-US');

  const config = await api.store.get('app_config');
  assert.ok(config && typeof config === 'object');
  const changed: Array<{ key: string }> = [];
  const off = api.store.onChanged((payload) => changed.push(payload));
  await api.store.set('app_config', { ...config, theme: 'dark' });
  assert.deepEqual(changed, [{ key: 'app_config' }]);
  const reread = await api.store.get('app_config');
  assert.equal(reread.theme, 'dark');
  off();

  await assert.rejects(() => api.store.get('other_key'), /R-store/);
  await assert.rejects(() => api.store.set('other_key', {}), /R-store/);
  await assert.rejects(() => api.store.remove('app_config'), /R-store/);

  const sessions = await api.cowork.listSessions();
  assert.equal(sessions.success, true);
  assert.ok(Array.isArray(sessions.sessions));
});

test('unimplemented channels reject with a named Error, never a TypeError', async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.destroy());
  const api = bridge.electron;

  await assert.rejects(
    () => api.cowork.forkSession('mock-session-1', 'mock-msg-1'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof TypeError));
      assert.equal((error as Error).message, 'mock: cowork:forkSession not implemented');
      return true;
    },
  );

  await assert.rejects(() => api.powerGuard.getStatus(), /mock: powerGuard:getStatus not implemented/);
  await assert.rejects(() => api.mcp.list(), /mock: mcp:list not implemented/);
  await assert.rejects(() => api.getGitBranch('/data/workspace'), /mock: getGitBranch not implemented/);
  await assert.rejects(() => api.groupTask.list(), /mock: groupTask:list not implemented/);

  // Subscriptions on unimplemented event channels reject like any invoke.
  const pendingSub = api.dream.onStatusChanged(() => undefined);
  assert.ok(pendingSub instanceof Promise);
  await assert.rejects(pendingSub, /mock: dream:onStatusChanged not implemented/);
});

// ---------------------------------------------------------------- T2 additions

test('scheduledTasks.create validates input and computes nextRunAtMs', async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.destroy());
  const api = bridge.electron;

  const noName = await api.scheduledTasks.create({ prompt: 'p', schedule: { type: 'interval', intervalMs: 60_000, unit: 'minutes', value: 1 }, workingDirectory: '/data/workspace', systemPrompt: '', executionMode: 'auto', expiresAt: null, notifyPlatforms: [], enabled: true, name: '  ' });
  assert.equal(noName.success, false);

  const noPrompt = await api.scheduledTasks.create({ name: 'x', prompt: '', schedule: { type: 'interval', intervalMs: 60_000, unit: 'minutes', value: 1 }, workingDirectory: '/data/workspace', systemPrompt: '', executionMode: 'auto', expiresAt: null, notifyPlatforms: [], enabled: true });
  assert.equal(noPrompt.success, false);

  const badSchedule = await api.scheduledTasks.create({ name: 'x', prompt: 'p', schedule: { type: 'interval', intervalMs: 0, unit: 'minutes', value: 0 }, workingDirectory: '/data/workspace', systemPrompt: '', executionMode: 'auto', expiresAt: null, notifyPlatforms: [], enabled: true });
  assert.equal(badSchedule.success, false);

  const before = Date.now();
  const created = await api.scheduledTasks.create({
    name: 'Hourly check',
    description: '',
    prompt: 'Check things',
    schedule: { type: 'interval', intervalMs: 3_600_000, unit: 'hours', value: 1 },
    workingDirectory: '/data/workspace',
    systemPrompt: '',
    executionMode: 'auto',
    expiresAt: null,
    notifyPlatforms: [],
    enabled: true,
  });
  assert.equal(created.success, true);
  assert.ok(created.task.id);
  assert.ok(created.task.state.nextRunAtMs >= before + 3_600_000);

  const listed = await api.scheduledTasks.list();
  assert.ok(listed.tasks.some((task: { id: string }) => task.id === created.task.id));
});

test('scheduledTasks.toggle flips enabled and clears/sets nextRunAtMs', async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.destroy());
  const api = bridge.electron;

  const off = await api.scheduledTasks.toggle('mock-task-1', false);
  assert.equal(off.success, true);
  assert.equal(off.task.enabled, false);
  assert.equal(off.task.state.nextRunAtMs, null);

  const on = await api.scheduledTasks.toggle('mock-task-1', true);
  assert.equal(on.success, true);
  assert.equal(on.task.enabled, true);
  assert.ok(on.task.state.nextRunAtMs > Date.now());

  const missing = await api.scheduledTasks.toggle('mock-task-nope', true);
  assert.equal(missing.success, false);
});

test('scheduledTasks.runManually emits the run lifecycle and lands in history', async (t) => {
  const bridge = makeBridge({ manualRunDelayMs: 50 });
  t.after(() => bridge.destroy());
  const api = bridge.electron;

  const statuses: Array<{ taskId: string; state: { lastStatus: string | null } }> = [];
  const runs: Array<{ run: { id: string; status: string; taskId: string } }> = [];
  const offStatus = api.scheduledTasks.onStatusUpdate((payload) => statuses.push(payload));
  const offRun = api.scheduledTasks.onRunUpdate((payload) => runs.push(payload));

  const started = await api.scheduledTasks.runManually('mock-task-2');
  assert.equal(started.success, true);
  assert.equal(started.run.status, 'running');
  assert.equal(started.run.trigger, 'manual');

  await waitFor(
    () => runs.some((entry) => entry.run.status === 'success' && entry.run.id === started.run.id),
    'manual run success event',
  );
  assert.ok(statuses.some((entry) => entry.taskId === 'mock-task-2' && entry.state.lastStatus === 'running'));
  assert.ok(statuses.some((entry) => entry.taskId === 'mock-task-2' && entry.state.lastStatus === 'success'));

  const history = await api.scheduledTasks.listRuns('mock-task-2');
  const finished = history.runs.find((run: { id: string }) => run.id === started.run.id);
  assert.ok(finished);
  assert.equal(finished.status, 'success');
  assert.equal(finished.trigger, 'manual');
  assert.ok(finished.durationMs > 0);
  assert.ok(finished.sessionId);

  // Like a scheduled run, the manual run created an auto-origin session.
  const session = await api.cowork.getSession(finished.sessionId ?? '');
  assert.equal(session.session.autoOrigin, 'schedule');

  const missing = await api.scheduledTasks.runManually('mock-task-nope');
  assert.equal(missing.success, false);

  offStatus();
  offRun();
});

test('metabot create validates name and update edits persona fields', async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.destroy());
  const api = bridge.electron;

  const noName = await api.metabot.create({ name: '' });
  assert.equal(noName.success, false);

  const created = await api.metabot.create({
    name: 'Writer',
    metabot_type: 'worker',
    role: 'Drafts posts',
    soul: 'A careful writer',
    bio: 'Writes long-form content',
  });
  assert.equal(created.success, true);
  assert.ok(created.metabot.id > 2);
  assert.equal(created.metabot.name, 'Writer');
  assert.equal(created.metabot.metabot_type, 'worker');

  const listed = await api.metabot.list();
  assert.ok(listed.list.some((bot: { id: number }) => bot.id === created.metabot.id));

  const updated = await api.metabot.update(created.metabot.id, {
    name: 'Senior Writer',
    role: 'Drafts and edits posts',
    soul: 'A meticulous writer',
    bio: 'Writes and edits long-form content',
  });
  assert.equal(updated.success, true);
  assert.equal(updated.metabot.name, 'Senior Writer');
  assert.equal(updated.metabot.role, 'Drafts and edits posts');
  assert.equal(updated.metabot.soul, 'A meticulous writer');
  assert.equal(updated.metabot.bio, 'Writes and edits long-form content');

  const emptyName = await api.metabot.update(created.metabot.id, { name: '  ' });
  assert.equal(emptyName.success, false);

  const missing = await api.metabot.update(999, { name: 'Ghost' });
  assert.equal(missing.success, false);

  const twin = await api.metabot.get(1);
  assert.equal(twin.success, true);
  assert.equal(twin.metabot.metabot_type, 'twin');
});

test('skills.setEnabled flips the fixture and emits skills:changed', async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.destroy());
  const api = bridge.electron;

  const changes: unknown[] = [];
  const off = api.skills.onChanged((payload) => changes.push(payload));

  const result = await api.skills.setEnabled({ id: 'web-search', enabled: false });
  assert.equal(result.success, true);
  const webSearch = result.skills.find((skill: { id: string }) => skill.id === 'web-search');
  assert.equal(webSearch.enabled, false);

  const listed = await api.skills.list();
  assert.equal(listed.skills.find((skill: { id: string }) => skill.id === 'web-search').enabled, false);

  const missing = await api.skills.setEnabled({ id: 'nope', enabled: true });
  assert.equal(missing.success, false);

  assert.equal(changes.length, 1);
  off();
});

test('traffic.redeemCode credits the traffic meter; invalid codes fail', async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.destroy());
  const api = bridge.electron;

  const before = await api.traffic.getBalance();
  const balanceBefore = before.balance.balanceBytes;

  const empty = await api.traffic.redeemCode({ code: '   ' });
  assert.equal(empty.success, false);

  const bad = await api.traffic.redeemCode({ code: 'BAD' });
  assert.equal(bad.success, false);
  assert.equal(bad.errorCode, 'INVALID_CODE');

  const ok = await api.traffic.redeemCode({ code: 'MOCK-CODE-1234' });
  assert.equal(ok.success, true);
  assert.ok(ok.result.trafficBytes > 0);
  assert.equal(ok.result.balanceAfter, balanceBefore + ok.result.trafficBytes);

  const after = await api.traffic.getBalance();
  assert.equal(after.balance.balanceBytes, balanceBefore + ok.result.trafficBytes);
});
