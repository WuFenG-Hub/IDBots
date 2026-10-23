import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildElectronFromContract,
  installShim,
  type GatewayInvoker,
  type IpcContractFile,
  type ShimDeps,
} from '../src/mobile/bridge/installShim.ts';

/**
 * REQ-E-25 (shim part): contract coverage for the real bridge (REQ-E-3) and
 * the S-tier local answers (REQ-E-4). Runs without a DOM: window/document
 * fakes are installed on globalThis per test and removed afterwards (the
 * shim only touches them at call time), and the gateway client is a fake
 * invoker.
 */

const CONTRACT_URL = new URL('../src/mobile/generated/ipc-contract.json', import.meta.url);
const CONTRACT = JSON.parse(readFileSync(CONTRACT_URL, 'utf8')) as IpcContractFile;

interface RecordedCall {
  channel: string;
  args: unknown[];
}

function makeFakeGateway() {
  const calls: RecordedCall[] = [];
  const listeners = new Map<string, Set<(args: unknown[]) => void>>();
  const channels = new Map<string, (args: unknown[]) => unknown>();
  const gateway: GatewayInvoker = {
    async invoke(channel, ...args) {
      calls.push({ channel, args });
      const handler = channels.get(channel);
      if (handler) return handler(args);
      return { success: true };
    },
    onEvent(channel, cb) {
      let set = listeners.get(channel);
      if (!set) listeners.set(channel, (set = new Set()));
      set.add(cb);
      return () => {
        set.delete(cb);
      };
    },
  };
  return {
    calls,
    gateway,
    /** Route invokes for one channel to a handler (or a rejection thrower). */
    handle(channel: string, handler: (args: unknown[]) => unknown) {
      channels.set(channel, handler);
    },
    emit(channel: string, args: unknown[]) {
      listeners.get(channel)?.forEach((cb) => cb(args));
    },
  };
}

type Listener = (event?: unknown) => void;

class FakeInput {
  type = '';
  accept = '';
  files: File[] = [];
  clicked = false;
  private listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener) {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  click() {
    this.clicked = true;
  }

  remove() {
    // No-op for the fake; real DOM detaches the picker node.
  }

  dispatch(type: string) {
    this.listeners.get(type)?.forEach((listener) => listener());
  }
}

function makeFakeDom() {
  const created: FakeInput[] = [];
  const opened: Array<{ url: string; target: string; features: string }> = [];
  const fakeDocument = {
    createElement(tag: string) {
      assert.equal(tag, 'input');
      const input = new FakeInput();
      created.push(input);
      return input;
    },
    body: {
      appendChild() {
        // The picker node only needs to exist in the DOM for input.click().
      },
    },
  };
  const fakeWindow = {
    open(url: string, target: string, features: string) {
      opened.push({ url, target, features });
    },
  };
  return { created, opened, fakeDocument, fakeWindow };
}

function installGlobals(fake: ReturnType<typeof makeFakeDom>) {
  const g = globalThis as Record<string, unknown>;
  g.window = fake.fakeWindow;
  g.document = fake.fakeDocument;
}

function clearGlobals() {
  const g = globalThis as Record<string, unknown>;
  delete g.window;
  delete g.document;
}

function makeDeps(overrides: Partial<ShimDeps> = {}) {
  const fake = makeFakeGateway();
  const deps: ShimDeps = { gateway: fake.gateway, ...overrides };
  return { fake, deps };
}

test('contract coverage: every entry in ipc-contract.json exists on the built electron surface', () => {
  // The exact count changes whenever WS-A regenerates the contract on main
  // (tiering governance lives in tests/ipcContract.test.mjs); the coverage
  // loop below is what must hold for every entry.
  assert.ok(CONTRACT.methods.length >= 415, `unexpected contract shrink (${CONTRACT.methods.length})`);
  const { deps } = makeDeps();
  const electron = buildElectronFromContract(CONTRACT, deps);

  for (const entry of CONTRACT.methods) {
    let node: unknown = electron;
    const segments = entry.path.split('.');
    for (const segment of segments.slice(0, -1)) {
      node = (node as Record<string, unknown> | null | undefined)?.[segment];
    }
    const value = (node as Record<string, unknown> | null | undefined)?.[segments[segments.length - 1]];
    if (entry.kind === 'value') {
      if (entry.path === 'platform') assert.equal(value, 'linux', entry.path);
      else if (entry.path === 'arch') assert.equal(value, 'x64', entry.path);
      else assert.fail(`unexpected value entry: ${entry.path}`);
    } else {
      assert.equal(typeof value, 'function', `${entry.kind} entry ${entry.path} is missing`);
    }
  }
});

test('invoke entries forward the channel and positional args to the gateway', async () => {
  const { fake, deps } = makeDeps();
  const electron = buildElectronFromContract(CONTRACT, deps);

  await electron.skills.list();
  assert.deepEqual(fake.calls[0], { channel: 'skills:list', args: [] });

  await electron.fs.readTextFile('/data/workspace/notes.txt', 42);
  assert.deepEqual(fake.calls[1], {
    channel: 'fs:readTextFile',
    args: ['/data/workspace/notes.txt', 42],
  });
});

test('on entries subscribe to the event channel and return an unsubscribe function', () => {
  const { fake, deps } = makeDeps();
  const electron = buildElectronFromContract(CONTRACT, deps);

  const payloads: unknown[] = [];
  const unsubscribe = electron.skills.onChanged((payload: unknown) => payloads.push(payload));
  assert.equal(typeof unsubscribe, 'function');

  // C2 event frames carry positional args; the payload is spread into the callback.
  fake.emit('skills:changed', [{ kind: 'enabled' }]);
  assert.deepEqual(payloads, [{ kind: 'enabled' }]);

  unsubscribe();
  fake.emit('skills:changed', [{ kind: 'disabled' }]);
  assert.equal(payloads.length, 1);
});

test('send entries are no-ops that never reach the gateway', () => {
  const { fake, deps } = makeDeps();
  const electron = buildElectronFromContract(CONTRACT, deps);

  assert.equal(electron.window.close(), undefined);
  assert.equal(electron.window.toggleMaximize(), undefined);
  assert.equal(electron.networkStatus.send('online'), undefined);
  assert.equal(fake.calls.length, 0);
});

test('S-tier local answers resolve the desktop shapes without any gateway call', async () => {
  const { fake, deps } = makeDeps();
  const electron = buildElectronFromContract(CONTRACT, deps);

  const initialized = await electron.startup.rendererInitialized();
  assert.equal(initialized.success, true);
  assert.equal(initialized.elapsedMs, 0);
  assert.equal(typeof initialized.startedAt, 'number');

  assert.deepEqual(await electron.getRecentCwds(), []);
  assert.equal(await electron.window.isMaximized(), false);

  // Cancelled dialog shapes mirror src/main/main.ts:17331/17343.
  assert.deepEqual(await electron.dialog.selectDirectory(), { success: true, path: null });
  assert.deepEqual(await electron.dialog.saveInlineFile({ dataBase64: 'AAAA' }), { success: true, path: null });

  assert.deepEqual(await electron.shell.getOpenWithApps('/data/workspace/a.txt'), { success: true, apps: [] });
  assert.deepEqual(await electron.shell.chooseOpenWithApp('/data/workspace/a.txt'), { success: false });

  assert.equal(fake.calls.length, 0, 'pure-local S-tier answers must not reach the gateway');
});

test('shell.openExternal opens only http(s) URLs in a new browsing context', async (t) => {
  const dom = makeFakeDom();
  installGlobals(dom);
  t.after(clearGlobals);
  const { deps } = makeDeps();
  const electron = buildElectronFromContract(CONTRACT, deps);

  const ok = await electron.shell.openExternal(' https://example.com/page ');
  assert.deepEqual(ok, { success: true });
  assert.deepEqual(dom.opened, [{ url: 'https://example.com/page', target: '_blank', features: 'noopener,noreferrer' }]);

  dom.opened.length = 0;
  const fileUrl = await electron.shell.openExternal('file:///etc/passwd');
  assert.deepEqual(fileUrl, { success: false, error: 'Only http and https URLs are allowed' });
  const empty = await electron.shell.openExternal('   ');
  assert.deepEqual(empty, { success: false, error: 'URL is empty' });
  const bad = await electron.shell.openExternal('not a url');
  assert.deepEqual(bad, { success: false, error: 'Invalid URL' });
  assert.equal(dom.opened.length, 0, 'non-http(s) URLs must never reach window.open');
});

test('shell.openPath signs the /data path and opens the signed URL', async (t) => {
  const dom = makeFakeDom();
  installGlobals(dom);
  t.after(clearGlobals);
  const { fake, deps } = makeDeps();
  fake.handle('gateway:file:sign', (args) => {
    assert.deepEqual(args, [{ path: '/data/workspace/report.pdf', disposition: 'inline' }]);
    return { url: 'https://files.example/signed/report.pdf?token=1', expiresAt: 1, size: 2, mime: 'application/pdf' };
  });
  const electron = buildElectronFromContract(CONTRACT, deps);

  const result = await electron.shell.openPath('/data/workspace/report.pdf');
  assert.deepEqual(result, { success: true });
  assert.deepEqual(dom.opened, [
    { url: 'https://files.example/signed/report.pdf?token=1', target: '_blank', features: 'noopener,noreferrer' },
  ]);
  assert.deepEqual(
    fake.calls.map((call) => call.channel),
    ['gateway:file:sign'],
    'shell:openPath must be answered locally; only the sign call may reach the gateway',
  );
});

test('shell sign-and-open failures resolve the desktop failure shape', async (t) => {
  const dom = makeFakeDom();
  installGlobals(dom);
  t.after(clearGlobals);

  // `{ success: false }` envelopes pass through from the gateway client.
  const denied = makeDeps();
  denied.fake.handle('gateway:file:sign', () => ({ success: false, error: 'ARG_RESTRICTED' }));
  const deniedElectron = buildElectronFromContract(CONTRACT, denied.deps);
  assert.deepEqual(await deniedElectron.shell.openPath('/etc/passwd'), { success: false, error: 'ARG_RESTRICTED' });
  assert.equal(dom.opened.length, 0);

  // Coded gateway errors reject from the client; the shim resolves the desktop shape.
  const rejected = makeDeps();
  rejected.fake.handle('gateway:file:sign', () => {
    throw new Error('socket lost');
  });
  const rejectedElectron = buildElectronFromContract(CONTRACT, rejected.deps);
  assert.deepEqual(await rejectedElectron.shell.showItemInFolder('/data/workspace/a.txt'), {
    success: false,
    error: 'socket lost',
  });
  assert.equal(dom.opened.length, 0);
});

test('dialog.selectFile uploads the picked file and returns the server paths', async (t) => {
  const dom = makeFakeDom();
  installGlobals(dom);
  t.after(clearGlobals);
  const { fake, deps } = makeDeps({
    uploadFile: async (file: File) => {
      assert.equal(file.name, 'note.txt');
      return { path: `/data/workspace/uploads/${file.name}`, size: file.size, mime: file.type };
    },
  });
  const electron = buildElectronFromContract(CONTRACT, deps);

  const picking = electron.dialog.selectFile({
    title: 'Add file',
    filters: [{ name: 'Text', extensions: ['txt'] }],
  });
  const input = dom.created[0];
  assert.equal(input.type, 'file');
  assert.equal(input.accept, '.txt');
  assert.equal(input.clicked, true);

  input.files = [new File(['hi'], 'note.txt', { type: 'text/plain' })];
  input.dispatch('change');
  const result = await picking;

  // Desktop success shape (main.ts:17345) with the uploaded server paths.
  assert.deepEqual(result, {
    success: true,
    path: '/data/workspace/uploads/note.txt',
    paths: ['/data/workspace/uploads/note.txt'],
  });
  assert.equal(fake.calls.length, 0, 'dialog:selectFile must never reach the gateway');
});

test('dialog.selectFile falls back to the cancelled shape on cancel, without an uploader, or without a DOM', async (t) => {
  const dom = makeFakeDom();
  installGlobals(dom);
  t.after(clearGlobals);

  const withUploader = makeDeps({ uploadFile: async () => ({ path: '/x', size: 1, mime: 'x/y' }) });
  const electron = buildElectronFromContract(CONTRACT, withUploader.deps);

  // The user dismisses the picker.
  const picking = electron.dialog.selectFile();
  dom.created[0].dispatch('cancel');
  assert.deepEqual(await picking, { success: true, path: null, paths: [] });

  // No uploadFile injected: usable app, cancelled result, one console warning.
  const withoutUploader = makeDeps();
  const noUploadElectron = buildElectronFromContract(CONTRACT, withoutUploader.deps);
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    assert.deepEqual(await noUploadElectron.dialog.selectFile(), { success: true, path: null, paths: [] });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);

  assert.equal(withUploader.fake.calls.length, 0);
  assert.equal(withoutUploader.fake.calls.length, 0);
});

test('installShim installs window.electron and the window.idbotsMobile client facts', (t) => {
  const g = globalThis as Record<string, unknown>;
  const fakeWindow: Record<string, unknown> = {};
  g.window = fakeWindow;
  t.after(clearGlobals);

  const { fake, deps } = makeDeps();
  const handle = installShim(deps);
  assert.equal(fakeWindow.electron, handle.electron);

  // Node's navigator userAgent is neither Android nor iOS; a bare window
  // fake has no Capacitor bridge or standalone display mode.
  assert.deepEqual(fakeWindow.idbotsMobile, { isMobile: true, os: 'web', shell: 'browser' });
  assert.equal(fake.calls.length, 0);
});
