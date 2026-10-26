import { test, expect } from './fixtures';

type PermissionWindow = Window & {
  electron: { cowork: Record<string, (...args: unknown[]) => unknown> };
  idbotsMobile: {
    mock: {
      simulateReconnect: () => void;
      emitCoworkStream: (channel: 'permission' | 'permissionResolved', payload: unknown) => void;
    };
  };
  __sessionId: string | null;
  __permissionResults: Array<{
    requestId: string;
    result: {
      behavior: string;
      message?: string;
      updatedInput?: { answers?: Record<string, string>; autoAnswered?: string[] };
    };
  }>;
};

async function startSession(page: import('@playwright/test').Page): Promise<string> {
  await page.goto('/app/');
  await page.evaluate(() => {
    const w = window as unknown as PermissionWindow;
    w.__sessionId = null;
    w.__permissionResults = [];
    const cowork = w.electron.cowork;
    const originalStart = cowork.startSession;
    cowork.startSession = async (options: unknown) => {
      const result = await originalStart(options);
      w.__sessionId = (result as { session?: { id?: string } }).session?.id ?? null;
      return result;
    };
    const originalRespond = cowork.respondToPermission;
    cowork.respondToPermission = async (input: unknown) => {
      w.__permissionResults.push(input as PermissionWindow['__permissionResults'][number]);
      return originalRespond(input);
    };
  });
  await page.getByRole('button', { name: 'Sessions' }).click();
  await page.getByRole('button', { name: 'New chat' }).click();
  await page.getByPlaceholder('Type a message…').fill('start the permission test');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.waitForFunction(() => Boolean((window as unknown as PermissionWindow).__sessionId));
  return (await page.evaluate(() => (window as unknown as PermissionWindow).__sessionId))!;
}

async function emitPermission(
  page: import('@playwright/test').Page,
  sessionId: string,
  requestId: string,
  toolInput: Record<string, unknown>,
  perQuestionTimeoutMs: number | null = null,
): Promise<void> {
  await page.evaluate(({ sessionId: sid, requestId: rid, toolInput: input, perQuestionTimeoutMs: timeout }) => {
    const w = window as unknown as PermissionWindow;
    w.idbotsMobile.mock.emitCoworkStream('permission', {
      sessionId: sid,
      request: {
        sessionId: sid,
        requestId: rid,
        toolName: 'AskUserQuestion',
        toolInput: input,
        perQuestionTimeoutMs: timeout,
      },
    });
  }, { sessionId, requestId, toolInput, perQuestionTimeoutMs });
}

async function results(page: import('@playwright/test').Page): Promise<PermissionWindow['__permissionResults']> {
  return page.evaluate(() => (window as unknown as PermissionWindow).__permissionResults);
}

test('multi-step clarification preserves single/multi/Other/skip answers and plan detail', async ({ page }) => {
  const sessionId = await startSession(page);
  await emitPermission(page, sessionId, 'multi-step', {
    questions: [
      {
        question: 'Which approach?',
        header: 'Plan',
        detail: 'Full plan detail text',
        options: [{ label: 'Use plan A' }, { label: 'Use plan B' }],
      },
      {
        question: 'Which outputs?',
        options: [{ label: 'Report' }, { label: 'Slides' }, { label: 'Data' }],
        multiSelect: true,
      },
      {
        question: 'Custom constraint?',
        options: [{ label: 'Default constraint' }],
      },
      {
        question: 'Optional extra?',
        options: [{ label: 'Include extra' }],
      },
    ],
  });
  const dialog = page.getByRole('dialog', { name: 'Tool permission requested' });
  await expect(dialog).toBeVisible();
  await expect(page.getByText('Full plan detail text')).toBeVisible();
  await page.getByRole('radio', { name: /Use plan A/ }).click();
  await expect(page.getByText('Which outputs?')).toBeVisible();
  await page.getByRole('checkbox', { name: /Report/ }).click();
  await page.getByRole('checkbox', { name: /Data/ }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).last().click();
  await dialog.locator('input[type="text"]').fill('My custom constraint');
  await page.getByRole('button', { name: 'Next', exact: true }).last().click();
  await page.getByRole('button', { name: 'Skip this question' }).click();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  const answered = await results(page);
  expect(answered.length).toBe(1);
  expect(answered[0].result.behavior).toBe('allow');
  expect(answered[0].result.updatedInput?.answers).toEqual({
    'Which approach?': 'Use plan A',
    'Which outputs?': 'Report|||Data',
    'Custom constraint?': 'My custom constraint',
  });
  expect(answered[0].result.updatedInput?.autoAnswered).toEqual([]);
});

test('per-question timeout submits the recommended answer with autoAnswered metadata', async ({ page }) => {
  const sessionId = await startSession(page);
  await emitPermission(page, sessionId, 'timeout', {
    questions: [{
      question: 'Pick timeout',
      options: [{ label: 'Fast path (Recommended)' }, { label: 'Slow path' }],
    }],
  }, 50);
  await expect.poll(async () => (await results(page)).length).toBe(1);
  const [answered] = await results(page);
  expect(answered.result.behavior).toBe('allow');
  expect(answered.result.updatedInput?.answers).toEqual({ 'Pick timeout': 'Fast path (Recommended)' });
  expect(answered.result.updatedInput?.autoAnswered).toEqual(['Pick timeout']);
});

test('dismissed pending request reopens and survives reconnect without invented approval', async ({ page }) => {
  const sessionId = await startSession(page);
  await emitPermission(page, sessionId, 'recover', {
    questions: [{ question: 'Continue?', options: [{ label: 'Continue' }] }],
  });
  const dialog = page.getByRole('dialog', { name: 'Tool permission requested' });
  await expect(dialog).toBeVisible();
  await page.getByRole('button', { name: '✕' }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '1 requests need your attention' }).click();
  await expect(dialog).toBeVisible();
  await page.evaluate(() => (window as unknown as PermissionWindow).idbotsMobile.mock.simulateReconnect());
  await expect(page.locator('[data-connection-state]')).toHaveAttribute('data-connection-state', 'online', { timeout: 10_000 });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await page.evaluate((sessionId) => {
    const w = window as unknown as PermissionWindow;
    w.idbotsMobile.mock.emitCoworkStream('permissionResolved', { sessionId, requestId: 'recover' });
  }, sessionId);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Approved', { exact: true })).toHaveCount(0);
});

test('safety approval returns the first safety option', async ({ page }) => {
  const sessionId = await startSession(page);
  await emitPermission(page, sessionId, 'safety', {
    context: {
      requestedToolName: 'Bash',
      requestedToolInput: { command: 'rm -rf /data/workspace/demo' },
    },
    questions: [{
      question: 'Delete this directory?',
      options: [{ label: 'Delete once' }, { label: 'Cancel' }],
    }],
  });
  await expect(page.getByText('This action will delete files')).toBeVisible();
  await page.getByRole('button', { name: 'Allow deletion' }).click();
  await expect.poll(async () => (await results(page)).length).toBe(1);
  const [answered] = await results(page);
  expect(answered.result.behavior).toBe('allow');
  expect(answered.result.updatedInput?.answers).toEqual({ 'Delete this directory?': 'Delete once' });
});

test('malformed clarification fails closed with only denial available', async ({ page }) => {
  const sessionId = await startSession(page);
  await emitPermission(page, sessionId, 'malformed', { questions: [] });
  await expect(page.getByText('Request unavailable')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow once' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Deny', exact: true }).click();
  await expect.poll(async () => (await results(page)).length).toBe(1);
  const [answered] = await results(page);
  expect(answered.result.behavior).toBe('deny');
  expect(answered.result.message).toBe('Permission denied');
});
