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

  const before = await api.mobile.permission.listPending();
  assert.equal(before.success, true);
  assert.deepEqual(before.pending, []);

  const started = await api.cowork.startSession({ prompt: 'please run the permission demo' });
  assert.equal(started.success, true);
  await waitFor(() => requests.length === 1, 'permission request');

  assert.equal(requests[0].sessionId, started.session.id);
  assert.equal(requests[0].request.toolName, 'write_file');

  const during = await api.mobile.permission.listPending();
  assert.equal(during.pending.length, 1);
  assert.equal(during.pending[0].request.requestId, requests[0].request.requestId);
  assert.equal(typeof during.pending[0].createdAt, 'number');

  const response = await api.cowork.respondToPermission({
    requestId: requests[0].request.requestId,
    result: { behavior: 'allow' },
  });
  assert.equal(response.success, true);

  await waitFor(() => resolved.length === 1 && completes.length === 1, 'permission resolution and completion');
  assert.equal(resolved[0].requestId, requests[0].request.requestId);

  const after = await api.mobile.permission.listPending();
  assert.deepEqual(after.pending, []);

  // A second response to the same requestId is an unknown request.
  const again = await api.cowork.respondToPermission({
    requestId: requests[0].request.requestId,
    result: { behavior: 'deny' },
  });
  assert.equal(again.success, false);

  for (const off of offs) off();
});

test('quota trigger ends the stream with LLM_QUOTA_EXHAUSTED metadata', async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.destroy());
  const api = bridge.electron;

  const completes: Array<{ sessionId: string; metadata?: { errorCode?: string } }> = [];
  const off = api.cowork.onStreamComplete((payload) => completes.push(payload));

  const started = await api.cowork.startSession({ prompt: 'what is my quota' });
  assert.equal(started.success, true);
  await waitFor(() => completes.length === 1, 'quota completion');

  assert.equal(completes[0].metadata?.errorCode, 'LLM_QUOTA_EXHAUSTED');
  const fetched = await api.cowork.getSession(started.session.id);
  assert.equal(fetched.session.status, 'error');
  off();
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
  assert.ok(created.order.expiresAt > Date.now());

  const early = await api.bundle.getOrder({ orderId: created.order.orderId });
  assert.equal(early.order.status, 1);

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
  assert.ok(late.order.paidAt);
  assert.ok(late.order.creditedAt);

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
