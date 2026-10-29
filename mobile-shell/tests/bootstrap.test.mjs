import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';

const template = readFileSync(new URL('../native/idbots-native-bootstrap.js', import.meta.url), 'utf8');

function bootstrap(origin, platform = 'android', remoteOrigin = 'https://staging.idbots.world') {
  const script = template
    .replace('__IDBOTS_REMOTE_ORIGIN_JSON__', JSON.stringify(remoteOrigin))
    .replace('__IDBOTS_PLATFORM_JSON__', JSON.stringify(platform));
  const listeners = new Map();
  const window = {
    location: {
      origin,
      assign(url) { window.assigned.push(url); },
    },
    history: { back() { window.historyBacks += 1; } },
    assigned: [],
    historyBacks: 0,
    exits: 0,
    nativeExits: 0,
    listeners,
    Capacitor: {
      Plugins: {
        App: {
          async addListener(eventName, callback) {
            listeners.set(eventName, callback);
            return { remove: async () => listeners.delete(eventName) };
          },
          async exitApp() { window.exits += 1; },
        },
      },
    },
  };
  window.top = window;
  runInContext(script, createContext({ window, URL }));
  return window;
}

test('Android installs the versioned bridge at document start on the exact origin', () => {
  const window = bootstrap('https://staging.idbots.world');
  assert.equal(window.idbotsNative.nativeBridgeVersion, 1);
  assert.deepEqual({ ...window.idbotsMobile }, { isMobile: true, os: 'android', shell: 'capacitor' });
  assert.deepEqual({ ...window.idbotsNative.bootstrap }, {
    phase: 'document-start',
    origin: 'https://staging.idbots.world',
    platform: 'android',
  });
  assert.deepEqual({ ...window.idbotsNative.getCapabilities() }, {
    camera: false,
    photos: false,
    files: false,
    share: false,
    appState: true,
    backButton: true,
    externalUrls: true,
    secureScreen: false,
  });
});

test('iOS reports its own platform and no Android back capability', () => {
  const window = bootstrap('https://app.idbots.world', 'ios', 'https://app.idbots.world');
  assert.equal(window.idbotsNative.bootstrap.platform, 'ios');
  assert.equal(window.idbotsNative.getCapabilities().backButton, false);
  assert.equal(window.idbotsNative.getCapabilities().externalUrls, true);
});

test('an external page never receives the privileged native surface', () => {
  const window = bootstrap('https://evil.example');
  assert.equal(window.idbotsNative, undefined);
  const lookalike = bootstrap('https://staging.idbots.world.evil.example');
  assert.equal(lookalike.idbotsNative, undefined);
});

test('the bridge is non-writable and capabilities cannot be mutated globally', () => {
  const window = bootstrap('https://staging.idbots.world');
  const descriptor = Object.getOwnPropertyDescriptor(window, 'idbotsNative');
  assert.equal(descriptor.writable, false);
  assert.equal(descriptor.configurable, false);
  const first = window.idbotsNative.getCapabilities();
  first.camera = true;
  assert.equal(window.idbotsNative.getCapabilities().camera, false);
});

test('capabilities reflect an unavailable App plugin instead of claiming lifecycle support', () => {
  const window = bootstrap('https://staging.idbots.world');
  delete window.Capacitor.Plugins.App;
  assert.equal(window.idbotsNative.getCapabilities().appState, false);
  assert.equal(window.idbotsNative.getCapabilities().backButton, false);
  assert.equal(window.idbotsNative.onAppStateChange(() => {})(), undefined);
  assert.equal(window.idbotsNative.onBackButton(() => false)(), undefined);
});

test('app-state subscriptions forward booleans and remove asynchronous listeners', async () => {
  const window = bootstrap('https://staging.idbots.world');
  const states = [];
  const unsubscribe = window.idbotsNative.onAppStateChange((active) => states.push(active));
  window.listeners.get('appStateChange')({ isActive: false });
  window.listeners.get('appStateChange')({ isActive: true });
  assert.deepEqual(states, [false, true]);
  await new Promise((resolve) => setImmediate(resolve));
  unsubscribe();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(window.listeners.has('appStateChange'), false);
});

test('Android back consumes current UI handlers before history or app exit', () => {
  const window = bootstrap('https://staging.idbots.world');
  let handled = true;
  window.idbotsNative.onBackButton(() => handled);
  window.listeners.get('backButton')({ canGoBack: true });
  assert.equal(window.historyBacks, 0);
  assert.equal(window.exits, 0);

  handled = false;
  window.listeners.get('backButton')({ canGoBack: true });
  assert.equal(window.historyBacks, 1);
  assert.equal(window.exits, 0);
  window.listeners.get('backButton')({ canGoBack: false });
  assert.equal(window.exits, 1);
});

test('Android Back exits at product roots instead of returning to login history', () => {
  for (const pathname of ['/app/', '/login']) {
    const window = bootstrap('https://staging.idbots.world');
    window.location.pathname = pathname;
    window.idbotsNative.onBackButton(() => false);
    window.listeners.get('backButton')({ canGoBack: true });
    assert.equal(window.historyBacks, 0, pathname);
    assert.equal(window.exits, 1, pathname);
  }
});

test('Android root Back prefers the deterministic NativeBack plugin', () => {
  const window = bootstrap('https://staging.idbots.world');
  window.location.pathname = '/app/';
  window.Capacitor.Plugins.NativeBack = {
    exitApp: async () => { window.nativeExits += 1; },
  };
  window.idbotsNative.onBackButton(() => false);
  window.listeners.get('backButton')({ canGoBack: true });
  assert.equal(window.nativeExits, 1);
  assert.equal(window.exits, 0, 'App exitApp must not be used when NativeBack exists');
});

test('native external opening uses main-frame navigation only for approved URLs', async () => {
  const window = bootstrap('https://staging.idbots.world');
  await window.idbotsNative.openExternal(' https://example.com/path ');
  await window.idbotsNative.openExternal('alipays://platformapi/startapp?saId=10000007');
  assert.deepEqual(window.assigned, [
    'https://example.com/path',
    'alipays://platformapi/startapp?saId=10000007',
  ]);
  await assert.rejects(async () => window.idbotsNative.openExternal('javascript:alert(1)'));
  await assert.rejects(async () => window.idbotsNative.openExternal('https://user@example.com/'));
  assert.equal(window.assigned.length, 2);
});
