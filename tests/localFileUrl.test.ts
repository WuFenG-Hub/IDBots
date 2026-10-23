/**
 * REQ-E-7 localFileUrl tests: desktop mode must reproduce, byte for byte,
 * the `file://` strings the renderer components built before the refactor;
 * mobile mode signs through `gateway:file:sign`, caches, refreshes, and
 * surfaces errors.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLocalFileDirBaseHref,
  buildLocalFileUrl,
  clearLocalFileUrlCache,
  resolveLocalFileUrl,
  subscribeLocalFileUrl,
} from '../src/renderer/services/localFileUrl';
import {
  buildInlineHtmlSrcDoc,
} from '../src/renderer/components/cowork/InlineHtmlReportBlock';
import {
  injectHtmlBaseHref,
} from '../src/renderer/components/cowork/MarkdownViewerPanel';

// Reference implementations copied from the pre-REQ-E-7 component code —
// the desktop contract is that the shared builders match these exactly.
const referenceToFileHref = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(filePath)) {
    return `file:///${normalized}`;
  }
  if (normalized.startsWith('/')) {
    return `file://${normalized}`;
  }
  return `file://${normalized}`;
};

const referenceInjectBaseHref = (filePath: string): string => {
  const dirName = filePath.match(/^(.*)[\\/][^\\/]*$/)?.[1] ?? filePath;
  const normalized = dirName.replace(/\\/g, '/');
  return `file://${/^[A-Za-z]:/.test(normalized) ? '/' : ''}${encodeURI(normalized)}/`;
};

const DESKTOP_PATHS = [
  'C:\\Users\\bot\\Documents\\report.html',
  'C:\\a\\b',
  '/tmp/out/report.html',
  '/data/workspace/uploads/x.png',
  'relative/dir/report.md',
  '\\\\server\\share\\doc.md',
  '/with space/photo.png',
];

// ---------------------------------------------------------------------------
// Desktop mode: no `window.idbotsMobile` (including SSR-style window stubs).
// ---------------------------------------------------------------------------

test('desktop buildLocalFileUrl matches the former component construction exactly', () => {
  assert.equal(typeof window, 'undefined');
  for (const path of DESKTOP_PATHS) {
    assert.equal(buildLocalFileUrl(path), referenceToFileHref(path), path);
  }
});

test('desktop resolveLocalFileUrl returns the same file:// string without signing', async () => {
  for (const path of DESKTOP_PATHS) {
    assert.equal(await resolveLocalFileUrl(path), referenceToFileHref(path), path);
  }
  assert.equal(await resolveLocalFileUrl('/tmp/a.png', { disposition: 'attachment' }), 'file:///tmp/a.png');
});

test('an SSR-style window stub without idbotsMobile stays on the desktop path', async () => {
  globalThis.window = { electron: { platform: 'darwin' } } as never;
  try {
    assert.equal(await resolveLocalFileUrl('/tmp/a.png'), 'file:///tmp/a.png');
  } finally {
    delete (globalThis as Record<string, unknown>).window;
  }
});

test('desktop buildLocalFileDirBaseHref matches the former MarkdownViewerPanel construction', () => {
  const dirs = [
    'C:\\repo\\my docs',
    'C:\\repo',
    '/data/workspace/reports',
    '/data/workspace',
    '\\\\nas\\exports',
  ];
  for (const dir of dirs) {
    assert.equal(buildLocalFileDirBaseHref(dir), referenceInjectBaseHref(`${dir}/index.html`), dir);
  }
});

test('injectHtmlBaseHref still produces the dir-based base href on desktop', () => {
  const html = '<html><head><title>t</title></head><body></body></html>';
  const out = injectHtmlBaseHref(html, '/data/workspace/reports/index.html');
  assert.ok(out.includes('<base href="file:///data/workspace/reports/">'), out);

  const win = injectHtmlBaseHref(html, 'C:\\repo\\my docs\\report.html');
  assert.ok(win.includes(`<base href="${referenceInjectBaseHref('C:\\repo\\my docs\\report.html')}">`), win);
});

test('buildInlineHtmlSrcDoc keeps injecting the same desktop base href', () => {
  const srcDoc = buildInlineHtmlSrcDoc('<html><body>report</body></html>', '/data/x/report.html');
  assert.ok(
    srcDoc.includes('<base href="file:///data/x/">'),
    srcDoc.slice(0, 200),
  );
});

test('desktop subscribeLocalFileUrl is a no-op unsubscribe', async () => {
  let called = 0;
  const unsubscribe = subscribeLocalFileUrl('/tmp/a.png', undefined, () => {
    called += 1;
  });
  await resolveLocalFileUrl('/tmp/a.png');
  unsubscribe();
  assert.equal(called, 0);
});

// ---------------------------------------------------------------------------
// Mobile mode: window.idbotsMobile + a stubbed gateway fileSign.
// ---------------------------------------------------------------------------

type FileSignStub = (input: { path: string; disposition?: string }) => Promise<unknown>;

const installMobileWindow = (fileSign: FileSignStub): { calls: Array<Record<string, unknown>> } => {
  const calls: Array<Record<string, unknown>> = [];
  globalThis.window = {
    idbotsMobile: { isMobile: true, os: 'ios', shell: 'pwa' },
    electron: {
      gateway: {
        fileSign: (input: { path: string; disposition?: string }) => {
          calls.push(input as Record<string, unknown>);
          return fileSign(input);
        },
      },
    },
  } as never;
  return { calls };
};

const TEN_MINUTES_MS = 10 * 60 * 1000;

const signOk = (url: string, expiresAt: number): FileSignStub => () =>
  Promise.resolve({ url, expiresAt, size: 3, mime: 'image/png' });

const uninstallMobileWindow = (): void => {
  clearLocalFileUrlCache();
  delete (globalThis as Record<string, unknown>).window;
};

const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test('mobile resolveLocalFileUrl signs through the gateway and returns the relative url', async (t) => {
  const { calls } = installMobileWindow(signOk('/files/token-1', Date.now() + TEN_MINUTES_MS));
  t.after(uninstallMobileWindow);
  const url = await resolveLocalFileUrl('/data/a.png');
  assert.equal(url, '/files/token-1');
  assert.deepEqual(calls, [{ path: '/data/a.png', disposition: undefined }]);
});

test('mobile resolveLocalFileUrl passes the disposition through', async (t) => {
  const { calls } = installMobileWindow(signOk('/files/token-1', Date.now() + TEN_MINUTES_MS));
  t.after(uninstallMobileWindow);
  await resolveLocalFileUrl('/data/a.png', { disposition: 'attachment' });
  assert.deepEqual(calls, [{ path: '/data/a.png', disposition: 'attachment' }]);
});

test('mobile second resolve within validity reuses the cache (no re-sign)', async (t) => {
  const { calls } = installMobileWindow(signOk('/files/token-1', Date.now() + TEN_MINUTES_MS));
  t.after(uninstallMobileWindow);
  const first = await resolveLocalFileUrl('/data/a.png');
  const second = await resolveLocalFileUrl('/data/a.png');
  assert.equal(first, '/files/token-1');
  assert.equal(second, '/files/token-1');
  assert.equal(calls.length, 1);
});

test('mobile distinct dispositions are cached separately', async (t) => {
  const { calls } = installMobileWindow(signOk('/files/token-1', Date.now() + TEN_MINUTES_MS));
  t.after(uninstallMobileWindow);
  await resolveLocalFileUrl('/data/a.png');
  await resolveLocalFileUrl('/data/a.png', { disposition: 'attachment' });
  assert.equal(calls.length, 2);
});

test('mobile resolve re-signs when the cached url is within 60s of expiry', async (t) => {
  let call = 0;
  const stub: FileSignStub = () => {
    call += 1;
    // First token is already inside the 60s leeway; rotated tokens are
    // comfortably valid. The 0ms background-refresh timer may race the
    // second resolve — both interleavings end with token-2 and two calls.
    const expiresAt = call === 1 ? Date.now() + 30_000 : Date.now() + TEN_MINUTES_MS;
    return Promise.resolve({ url: `/files/token-${call}`, expiresAt, size: 3, mime: 'image/png' });
  };
  const { calls } = installMobileWindow(stub);
  t.after(uninstallMobileWindow);

  const first = await resolveLocalFileUrl('/data/a.png');
  const second = await resolveLocalFileUrl('/data/a.png');
  assert.equal(first, '/files/token-1');
  assert.equal(second, '/files/token-2');
  assert.equal(calls.length, 2);
});

test('mobile background refresh rotates the token one minute before expiry', async (t) => {
  let call = 0;
  const stub: FileSignStub = () => {
    call += 1;
    // First token expires ~100ms after the sign → refresh is due almost
    // immediately; the rotated token stays valid for ten minutes.
    const expiresAt = call === 1 ? Date.now() + 60_100 : Date.now() + TEN_MINUTES_MS;
    return Promise.resolve({ url: `/files/token-${call}`, expiresAt, size: 3, mime: 'image/png' });
  };
  installMobileWindow(stub);
  t.after(uninstallMobileWindow);

  const first = await resolveLocalFileUrl('/data/a.png');
  assert.equal(first, '/files/token-1');
  await waitFor(() => call >= 2);

  const refreshed = await resolveLocalFileUrl('/data/a.png');
  assert.equal(refreshed, '/files/token-2');
  assert.equal(call, 2);
});

test('mobile notifies subscribers when the background refresh rotates the url', async (t) => {
  let call = 0;
  const stub: FileSignStub = () => {
    call += 1;
    const expiresAt = call === 1 ? Date.now() + 60_100 : Date.now() + TEN_MINUTES_MS;
    return Promise.resolve({ url: `/files/token-${call}`, expiresAt, size: 3, mime: 'image/png' });
  };
  installMobileWindow(stub);
  t.after(uninstallMobileWindow);

  const seen: string[] = [];
  const unsubscribe = subscribeLocalFileUrl('/data/a.png', undefined, (url) => seen.push(url));
  await resolveLocalFileUrl('/data/a.png');
  await waitFor(() => call >= 2);
  await waitFor(() => seen.includes('/files/token-2'));
  unsubscribe();
  // The initial sign also notifies pre-existing subscribers; the refresh
  // notification carries the rotated token.
  assert.deepEqual(seen, ['/files/token-1', '/files/token-2']);
});

test('mobile {success:false} results reject with an Error carrying the server message', async (t) => {
  installMobileWindow(() => Promise.resolve({ success: false, error: 'ARG_RESTRICTED' }));
  t.after(uninstallMobileWindow);
  await assert.rejects(resolveLocalFileUrl('/etc/passwd'), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes('ARG_RESTRICTED'));
    return true;
  });
});

test('mobile a rejected fileSign invoke rejects resolveLocalFileUrl with that error', async (t) => {
  installMobileWindow(() => Promise.reject(new Error('gateway offline')));
  t.after(uninstallMobileWindow);
  await assert.rejects(resolveLocalFileUrl('/data/a.png'), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes('gateway offline'));
    return true;
  });
});

test('mobile a missing fileSign bridge rejects with a clear error', async (t) => {
  globalThis.window = { idbotsMobile: { isMobile: true, os: 'ios', shell: 'pwa' } } as never;
  t.after(uninstallMobileWindow);
  await assert.rejects(resolveLocalFileUrl('/data/a.png'), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes('fileSign'));
    return true;
  });
});
