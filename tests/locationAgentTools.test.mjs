import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { buildLocationAgentTools } = require('../dist-electron/main/libs/locationAgentTools.js');

const COARSE = {
  granularity: 'coarse',
  source: 'ip',
  provider: 'bigdatacloud',
  country: '中国',
  region: '广东省',
  city: '中山市',
  district: '东区街道',
  latitude: 22.517,
  longitude: 113.392,
  timezone: 'Asia/Shanghai',
  accuracyNote: 'City-level estimate based on the host\'s public IP address.',
  fetchedAt: '2026-09-28T00:00:00.000Z',
};

const PRECISE = {
  ...COARSE,
  granularity: 'precise',
  source: 'system',
  accuracyMeters: 35,
  accuracyNote: 'OS-reported device location (±35 m), reverse-geocoded by BigDataCloud.',
};

function makeHarness(overrides = {}) {
  const calls = { coarse: 0, precise: 0, consent: 0 };
  const locationHost = {
    getCoarseLocation: async () => {
      calls.coarse += 1;
      if (overrides.coarseError) throw overrides.coarseError;
      return overrides.coarse ?? COARSE;
    },
    getPreciseLocation: async () => {
      calls.precise += 1;
      if (overrides.preciseError) throw overrides.preciseError;
      return overrides.precise ?? PRECISE;
    },
  };
  const requestPreciseConsent = async () => {
    calls.consent += 1;
    return overrides.consent ?? 'granted';
  };
  const tools = buildLocationAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    locationHost,
    requestPreciseConsent,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

function parseResult(result) {
  assert.equal(result.isError, undefined, `expected a success result, got: ${result.content[0].text}`);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  return JSON.parse(result.content[0].text);
}

test('builds a single get_host_location tool', () => {
  const { byName } = makeHarness();
  assert.ok(byName.get_host_location);
  assert.equal(Object.keys(byName).length, 1);
});

test('the description documents both granularities, consent, and the delivery-address rule', () => {
  const { byName } = makeHarness();
  const description = byName.get_host_location.description;
  assert.match(description, /IP-based/);
  assert.match(description, /OS geolocation/);
  assert.match(description, /consent/);
  assert.match(description, /unattended sessions/i);
  assert.match(description, /delivery address/);
  assert.ok(byName.get_host_location.schema.granularity, 'schema must expose the optional granularity param');
});

test('default granularity is coarse and never asks for consent', async () => {
  const { calls, byName } = makeHarness();
  const data = parseResult(await byName.get_host_location.handler({}));
  assert.equal(data.granularity, 'coarse');
  assert.equal(data.source, 'ip');
  assert.equal(data.city, '中山市');
  assert.equal(data.requestedGranularity, undefined);
  assert.equal(calls.coarse, 1);
  assert.equal(calls.precise, 0);
  assert.equal(calls.consent, 0);
});

test('explicit coarse behaves like the default', async () => {
  const { calls, byName } = makeHarness();
  const data = parseResult(await byName.get_host_location.handler({ granularity: 'coarse' }));
  assert.equal(data.granularity, 'coarse');
  assert.equal(calls.consent, 0);
});

test('coarse provider failure is an error result with guidance', async () => {
  const { byName } = makeHarness({ coarseError: new Error('both providers down') });
  const result = await byName.get_host_location.handler({});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /both providers down/);
  assert.match(result.content[0].text, /offline|type their city/);
});

test('precise with granted consent returns the OS fix', async () => {
  const { calls, byName } = makeHarness({ consent: 'granted' });
  const data = parseResult(await byName.get_host_location.handler({ granularity: 'precise' }));
  assert.equal(data.granularity, 'precise');
  assert.equal(data.source, 'system');
  assert.equal(data.accuracyMeters, 35);
  assert.equal(calls.consent, 1);
  assert.equal(calls.precise, 1);
  assert.equal(calls.coarse, 0);
});

test('precise denied falls back to coarse with an explicit note', async () => {
  const { calls, byName } = makeHarness({ consent: 'denied' });
  const data = parseResult(await byName.get_host_location.handler({ granularity: 'precise' }));
  assert.equal(data.granularity, 'coarse');
  assert.equal(data.requestedGranularity, 'precise');
  assert.match(data.preciseFallbackReason, /declined/);
  assert.equal(calls.precise, 0);
  assert.equal(calls.coarse, 1);
});

test('precise on an unattended session falls back to coarse with an explicit note', async () => {
  const { calls, byName } = makeHarness({ consent: 'unattended' });
  const data = parseResult(await byName.get_host_location.handler({ granularity: 'precise' }));
  assert.equal(data.granularity, 'coarse');
  assert.equal(data.requestedGranularity, 'precise');
  assert.match(data.preciseFallbackReason, /unattended/);
  assert.equal(calls.precise, 0);
});

test('an OS fix failure falls back to coarse with the remediation hint', async () => {
  const { byName } = makeHarness({ consent: 'granted', preciseError: new Error('Location permission was denied by the OS.') });
  const data = parseResult(await byName.get_host_location.handler({ granularity: 'precise' }));
  assert.equal(data.granularity, 'coarse');
  assert.match(data.preciseFallbackReason, /Location permission was denied by the OS/);
  assert.match(data.preciseFallbackReason, /System Settings > Privacy & Security > Location Services/);
});

test('precise fallback still errors cleanly when coarse also fails', async () => {
  const { byName } = makeHarness({
    consent: 'denied',
    coarseError: new Error('offline'),
  });
  const result = await byName.get_host_location.handler({ granularity: 'precise' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /declined/);
  assert.match(result.content[0].text, /offline/);
});

// --- coworkRunner wiring anchors (surf-wiring regression precedent) ---------

const coworkRunnerSource = readFileSync(
  new URL('../src/main/libs/coworkRunner.ts', import.meta.url),
  'utf8',
);

test('CoworkRunner assigns options.locationHost and registers the tool next to the screenshot tools', () => {
  assert.match(coworkRunnerSource, /this\.locationHost = options\?\.locationHost;/);
  const screenshotIdx = coworkRunnerSource.indexOf('buildScreenshotAgentTools({ tool, host: this.screenshotHost })');
  const locationIdx = coworkRunnerSource.indexOf('buildLocationAgentTools({');
  assert.ok(screenshotIdx !== -1 && locationIdx !== -1);
  assert.ok(
    locationIdx > screenshotIdx,
    'get_host_location should register right after the screenshot tools in buildSessionInlineTools',
  );
  assert.match(coworkRunnerSource, /requestPreciseConsent: \(\) => this\.requestPreciseLocationConsent\(sessionId\)/);
});

test('the consent gate fails closed for unattended permission modes (skill-install posture)', () => {
  assert.match(coworkRunnerSource, /preciseLocationConsentedSessions/);
  const gate = coworkRunnerSource.slice(
    coworkRunnerSource.indexOf('private async requestPreciseLocationConsent'),
  );
  assert.match(gate, /mode === 'acceptEdits'/);
  assert.match(gate, /mode === 'bypassPermissions'/);
  assert.match(gate, /activeSession\.autoApprove === true/);
  assert.match(gate, /'get_host_location'/);
});

test('runtime: a runner built with options.locationHost actually carries the host', async () => {
  const { CoworkRunner } = require('../dist-electron/main/libs/coworkRunner.js');
  // The constructor only touches the store lazily; a method-absorbing proxy
  // is enough for this wiring assertion.
  const fakeStore = new Proxy({}, { get: () => () => undefined });
  const locationHost = { getCoarseLocation: async () => COARSE, getPreciseLocation: async () => PRECISE };
  const runner = new CoworkRunner(fakeStore, { locationHost });
  assert.equal(runner.locationHost, locationHost);
});

test('main.ts passes locationHost into the CoworkRunner options', () => {
  const mainSource = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
  assert.match(mainSource, /locationHost: \{/);
  assert.match(mainSource, /getHostLocationService\(\)\.getCoarseLocation\(\)/);
  assert.match(mainSource, /getHostLocationService\(\)\.reverseGeocode\(fix\)/);
});
