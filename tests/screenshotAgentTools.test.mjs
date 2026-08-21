import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { buildScreenshotAgentTools, formatWindowList } = require('../dist-electron/main/libs/screenshotAgentTools.js');

const PNG_BYTES = Buffer.from('fake-png-bytes');
const CROPPED_BYTES = Buffer.from('cropped-png');

const SAMPLE_WINDOWS = [
  { id: 'window:101:0', app: '', title: 'Bot Browser' },
  { id: 'window:102:0', app: '', title: '' },
];

const SAMPLE_DISPLAYS = [
  { id: 7001, width: 3024, height: 1964, scaleFactor: 2 },
  { id: 7002, width: 1920, height: 1080, scaleFactor: 1 },
];

function makeHarness(overrides = {}) {
  const calls = { listWindows: 0, captureScreen: [], captureWindow: [], cropPng: [] };
  const host = {
    platform: overrides.platform ?? 'darwin',
    listWindows: async () => {
      calls.listWindows += 1;
      if (overrides.listWindowsError) throw overrides.listWindowsError;
      return overrides.windows ?? SAMPLE_WINDOWS;
    },
    listDisplays: () => overrides.displays ?? SAMPLE_DISPLAYS,
    captureScreen: async (input) => {
      calls.captureScreen.push(input);
      if (overrides.captureError) throw overrides.captureError;
      return overrides.screenPng ?? PNG_BYTES;
    },
    captureWindow: async (input) => {
      calls.captureWindow.push(input);
      if (overrides.captureError) throw overrides.captureError;
      return overrides.windowPng ?? PNG_BYTES;
    },
    cropPng: async (input) => {
      calls.cropPng.push(input);
      if (overrides.cropError) throw overrides.cropError;
      return overrides.croppedPng ?? CROPPED_BYTES;
    },
  };
  const tools = buildScreenshotAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    host,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

function tempSavePath(name) {
  return path.join(os.tmpdir(), name);
}

async function cleanup(file) {
  await fs.promises.unlink(file).catch(() => {});
}

test('builds a single screenshot tool', () => {
  const { byName } = makeHarness();
  assert.ok(byName.screenshot);
  assert.equal(Object.keys(byName).length, 1);
});

test('list_windows formats the host window list with usable ids', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.screenshot.handler({ action: 'list_windows' });
  assert.equal(result.isError, undefined);
  assert.equal(calls.listWindows, 1);
  const text = result.content[0].text;
  assert.match(text, /Capturable windows \(2\):/);
  assert.match(text, /- \[window:101:0\] Bot Browser/);
  assert.match(text, /- \[window:102:0\] \(untitled\)/);
  assert.match(text, /window_id/);
});

test('formatWindowList handles an empty list', () => {
  assert.equal(formatWindowList([]), 'No capturable windows found.');
});

test('list_windows surfaces host failures as an error result', async () => {
  const { byName } = makeHarness({ listWindowsError: new Error('capturer down') });
  const result = await byName.screenshot.handler({ action: 'list_windows' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Screenshot failed: capturer down/);
});

test('fullscreen capture writes a temp PNG and returns an inline image', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.screenshot.handler({});
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.captureScreen, [{ displayId: undefined }]);
  assert.equal(result.content.length, 2);
  assert.equal(result.content[0].type, 'text');
  const match = /Screenshot saved to (\S+\/idbots-screenshot-\d+\.png) \(\d+ bytes\)/.exec(result.content[0].text);
  assert.ok(match, `unexpected text: ${result.content[0].text}`);
  await cleanup(match[1]);
  assert.equal(result.content[1].type, 'image');
  assert.equal(result.content[1].mimeType, 'image/png');
  assert.equal(Buffer.from(result.content[1].data, 'base64').toString(), PNG_BYTES.toString());
});

test('fullscreen selects the display by 1-based index and forwards its id', async () => {
  const savePath = tempSavePath('idbots-shot-test-display.png');
  const { calls, byName } = makeHarness();
  const result = await byName.screenshot.handler({ display: 2, save_path: savePath });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.captureScreen, [{ displayId: 7002 }]);
  const written = await fs.promises.readFile(savePath);
  assert.equal(written.toString(), PNG_BYTES.toString());
  await cleanup(savePath);
});

test('an out-of-range display index errors before capturing', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.screenshot.handler({ display: 5 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /display 5 is out of range.*2 display\(s\)/);
  assert.equal(calls.captureScreen.length, 0);
});

test('window mode requires window_id and captures by source id', async () => {
  const savePath = tempSavePath('idbots-shot-test-window.png');
  const { calls, byName } = makeHarness();

  const missing = await byName.screenshot.handler({ mode: 'window' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /requires window_id/);
  assert.equal(calls.captureWindow.length, 0);

  const result = await byName.screenshot.handler({ mode: 'window', window_id: 'window:101:0', save_path: savePath });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.captureWindow, [{ sourceId: 'window:101:0' }]);
  assert.equal(calls.captureScreen.length, 0);
  await cleanup(savePath);
});

test('region mode scales points to pixels by the display scaleFactor before cropping', async () => {
  const savePath = tempSavePath('idbots-shot-test-region.png');
  const { calls, byName } = makeHarness();

  const missing = await byName.screenshot.handler({ mode: 'region' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /requires region/);
  assert.equal(calls.cropPng.length, 0);

  const result = await byName.screenshot.handler({
    mode: 'region',
    region: { x: 1, y: 2, width: 3, height: 4 },
    save_path: savePath,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.captureScreen, [{ displayId: undefined }]);
  // Primary display has scaleFactor 2: points double to pixels.
  assert.equal(calls.cropPng.length, 1);
  assert.deepEqual(calls.cropPng[0].rect, { x: 2, y: 4, width: 6, height: 8 });
  assert.equal(calls.cropPng[0].png.toString(), PNG_BYTES.toString());
  assert.equal(Buffer.from(result.content[1].data, 'base64').toString(), CROPPED_BYTES.toString());
  await cleanup(savePath);
});

test('region mode on a secondary display uses that display scaleFactor', async () => {
  const savePath = tempSavePath('idbots-shot-test-region2.png');
  const { calls, byName } = makeHarness();
  await byName.screenshot.handler({
    mode: 'region',
    display: 2,
    region: { x: 10, y: 20, width: 30, height: 40 },
    save_path: savePath,
  });
  assert.deepEqual(calls.captureScreen, [{ displayId: 7002 }]);
  // Second display has scaleFactor 1: points pass through unchanged.
  assert.deepEqual(calls.cropPng[0].rect, { x: 10, y: 20, width: 30, height: 40 });
  await cleanup(savePath);
});

test('rejects a relative save_path and does not capture', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.screenshot.handler({ save_path: 'relative/out.png' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /save_path must be an absolute path/);
  // Validation runs before any capture.
  assert.equal(calls.captureScreen.length + calls.captureWindow.length, 0);
});

test('host capture failures (e.g. missing macOS permission) surface as error text', async () => {
  const permError = new Error(
    'Screen capture returned no image for display 7001. macOS Screen Recording access status: denied. Grant it under System Settings > Privacy & Security > Screen Recording, then restart the app.',
  );
  const { byName } = makeHarness({ captureError: permError });
  const result = await byName.screenshot.handler({});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Screenshot failed: Screen capture returned no image/);
  assert.match(result.content[0].text, /Screen Recording access status: denied/);
});

test('files larger than 8 MiB return text-only with the path', async () => {
  const savePath = tempSavePath('idbots-shot-test-big.png');
  const big = Buffer.alloc(8 * 1024 * 1024 + 1);
  const { byName } = makeHarness({ screenPng: big });
  const result = await byName.screenshot.handler({ save_path: savePath });
  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.match(result.content[0].text, new RegExp(`Screenshot saved to ${savePath.replace(/[/.]/g, '\\$&')} \\(\\d+ bytes\\)`));
  assert.match(result.content[0].text, /not inlined/);
  const written = await fs.promises.stat(savePath);
  assert.equal(written.size, big.length);
  await cleanup(savePath);
});

test('a failing disk write reports an error instead of throwing', async () => {
  const { byName } = makeHarness();
  const result = await byName.screenshot.handler({ save_path: '/nonexistent-dir-xyz/out.png' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /failed to save to \/nonexistent-dir-xyz\/out\.png/);
});
