import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';

const template = readFileSync(new URL('../native/idbots-native-bootstrap.js', import.meta.url), 'utf8');

function bootstrap(origin, platform = 'android', remoteOrigin = 'https://staging.idbots.world') {
  const script = template
    .replace('__IDBOTS_REMOTE_ORIGIN_JSON__', JSON.stringify(remoteOrigin))
    .replace('__IDBOTS_PLATFORM_JSON__', JSON.stringify(platform));
  const window = { location: { origin } };
  window.top = window;
  runInContext(script, createContext({ window }));
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
