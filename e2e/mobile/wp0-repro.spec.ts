import { test, expect } from './fixtures';

type Wp0Message = { id: string; type: string; content: string; timestamp: number; metadata?: Record<string, unknown> };

async function capture(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      electron: { cowork: Record<string, (...args: unknown[]) => unknown> };
      __wp0StartOptions: unknown[];
      __wp0Listeners: Record<string, (payload: unknown) => void>;
    };
    w.__wp0StartOptions = [];
    w.__wp0Listeners = {};
    const cowork = w.electron.cowork;
    const originalStart = cowork.startSession;
    cowork.startSession = async (options: unknown) => {
      w.__wp0StartOptions.push(options);
      return originalStart(options);
    };
    for (const method of ['onStreamMessage', 'onStreamComplete', 'onStreamPermission', 'onStreamPermissionResolved']) {
      const original = cowork[method];
      cowork[method] = (callback: (payload: unknown) => void) => {
        w.__wp0Listeners[method] = callback;
        return original(callback);
      };
    }
  });
}

async function emit(page: import('@playwright/test').Page, method: string, payload: unknown): Promise<void> {
  await page.evaluate(({ method: name, payload: data }) => {
    const w = window as unknown as { __wp0Listeners: Record<string, (payload: unknown) => void> };
    w.__wp0Listeners[name](data);
  }, { method, payload });
}

async function sendMessage(page: import('@playwright/test').Page, text: string): Promise<void> {
  await page.getByPlaceholder('Type a message…').fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
}

function message(id: string, type: string, content: string, metadata?: Record<string, unknown>): Wp0Message {
  return { id, type, content, timestamp: Date.now(), ...(metadata ? { metadata } : {}) };
}

test.fail('WP0 repro: first chat binds the actual Twin, not metabotId=null', async ({ page }) => {
  await page.goto('/app/');
  await capture(page);
  await sendMessage(page, 'bind my Twin');
  const options = await page.evaluate(() => {
    const w = window as unknown as { __wp0StartOptions: Array<{ metabotId?: number | null }> };
    return w.__wp0StartOptions[0];
  });
  expect(options?.metabotId).toBe(1);
});

test.fail('WP0 repro: another session cannot append into the open transcript', async ({ page }) => {
  await page.goto('/app/');
  await capture(page);
  await emit(page, 'onStreamMessage', {
    sessionId: 'background-session',
    message: message('bg-1', 'assistant', 'BACKGROUND_MUST_NOT_APPEAR'),
  });
  await expect(page.getByText('BACKGROUND_MUST_NOT_APPEAR')).toHaveCount(0, { timeout: 1200 });
});

test.fail('WP0 repro: another session cannot complete the visible turn', async ({ page }) => {
  await page.goto('/app/');
  await capture(page);
  await sendMessage(page, 'keep this turn running');
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  await emit(page, 'onStreamComplete', { sessionId: 'background-session', claudeSessionId: null });
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 1200 });
});

test.fail('WP0 repro: another session cannot raise a permission sheet', async ({ page }) => {
  await page.goto('/app/');
  await capture(page);
  await emit(page, 'onStreamPermission', {
    sessionId: 'background-session',
    request: {
      sessionId: 'background-session',
      requestId: 'bg-permission',
      toolName: 'write_file',
      toolInput: { path: '/data/workspace/background.txt' },
    },
  });
  await expect(page.getByText('Tool permission requested')).toHaveCount(0, { timeout: 1200 });
});

test.fail('WP0 repro: unknown remote resolution is not displayed as approval', async ({ page }) => {
  await page.goto('/app/');
  await capture(page);
  await emit(page, 'onStreamPermission', {
    sessionId: 'current-session',
    request: {
      sessionId: 'current-session',
      requestId: 'remote-resolution',
      toolName: 'write_file',
      toolInput: { path: '/data/workspace/result.txt' },
    },
  });
  await expect(page.getByText('Tool permission requested')).toBeVisible();
  await emit(page, 'onStreamPermissionResolved', { sessionId: 'current-session', requestId: 'remote-resolution' });
  await expect(page.getByText('Approved', { exact: true })).toHaveCount(0, { timeout: 1200 });
});

test.fail('WP0 repro: tool_use is not rendered as an ordinary Assistant answer', async ({ page }) => {
  await page.goto('/app/');
  await capture(page);
  await emit(page, 'onStreamMessage', {
    sessionId: 'current-session',
    message: message('tool-1', 'tool_use', 'RAW_TOOL_EVENT', { toolName: 'bash', toolUseId: 'tool-1' }),
  });
  await expect(page.getByText('RAW_TOOL_EVENT')).toHaveCount(0, { timeout: 1200 });
});

test.fail('WP0 repro: raw thinking is not rendered as an ordinary Assistant answer', async ({ page }) => {
  await page.goto('/app/');
  await capture(page);
  await emit(page, 'onStreamMessage', {
    sessionId: 'current-session',
    message: message('thinking-1', 'assistant', 'RAW_THINKING', { isThinking: true }),
  });
  await expect(page.getByText('RAW_THINKING')).toHaveCount(0, { timeout: 1200 });
});

test.fail('WP0 repro: AskUserQuestion renders real options, not only JSON allow/deny', async ({ page }) => {
  await page.goto('/app/');
  await capture(page);
  await emit(page, 'onStreamPermission', {
    sessionId: 'current-session',
    request: {
      sessionId: 'current-session',
      requestId: 'question-1',
      toolName: 'AskUserQuestion',
      toolInput: {
        questions: [
          {
            question: 'Which plan should we use?',
            header: 'Plan',
            options: [
              { label: 'Use plan A', description: 'Shared core' },
              { label: 'Use plan B', description: 'More patches' },
            ],
            multiSelect: false,
          },
        ],
      },
    },
  });
  await expect(page.getByRole('radio', { name: 'Use plan A' })).toHaveCount(0, { timeout: 1200 });
});

test.fail('WP0 repro: start failure has a visible recovery state', async ({ page }) => {
  await page.goto('/app/');
  await page.evaluate(() => {
    const w = window as unknown as { electron: { cowork: Record<string, (...args: unknown[]) => unknown> } };
    w.electron.cowork.startSession = async () => {
      throw new Error('WP0_START_FAILED');
    };
  });
  await sendMessage(page, 'trigger a start failure');
  await expect(page.getByText(/WP0_START_FAILED/)).toBeVisible({ timeout: 1200 });
});
