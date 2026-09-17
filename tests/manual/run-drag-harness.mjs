#!/usr/bin/env node
/**
 * Driver for the REAL-input leg of tests/manual/electron-drag-region-harness.mjs.
 *
 * Why a driver at all: the OS-level click must NOT be spawned by the Electron
 * process — macOS TCC attributes the assistive-access decision to the
 * responsible process, and the unsigned dev Electron is not in the
 * Accessibility list, so event synthesis from inside the app hangs on a prompt.
 *
 * Click mechanism: `osascript -l JavaScript` (JXA) driving the ObjC bridge to
 * CoreGraphics — CGEventCreateMouseEvent + CGEventPost on the HID event tap.
 * This is a REAL window-server input event, the same path a physical mouse
 * takes, so native drag-region interception applies to it. (System Events'
 * `click at` was tried first and hangs forever on this setup even over a live
 * window; JXA/CGEvent is instant. `key code` synthesis works, so the calling
 * context holds the needed Accessibility grant.)
 *
 * Sequence:
 *   1. spawn the harness (`--input real --coords-file <tmp>`);
 *   2. wait for the coords file, then CGEvent-click control + target;
 *   3. wait for the harness to exit and print its RESULT JSON.
 *
 * Usage:
 *   node tests/manual/run-drag-harness.mjs no-drag|with-drag
 * The script prints the harness JSON on stdout and exits with the harness
 * exit code (0 = the mode's expectation held).
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const overlayMode = process.argv[2];
if (!['no-drag', 'with-drag'].includes(overlayMode)) {
  console.error('usage: node tests/manual/run-drag-harness.mjs no-drag|with-drag');
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');
const electronBin = path.join(projectRoot, 'node_modules', '.bin', 'electron');
const harness = path.join(here, 'electron-drag-region-harness.mjs');

const coordsFile = path.join(os.tmpdir(), `idbots-drag-coords-${Date.now()}.json`);

// ELECTRON_RUN_AS_NODE may leak into this shell from the host app; it turns
// the electron binary into a plain node and breaks the harness.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const JXA_CLICK = `
ObjC.import('CoreGraphics');
function run(argv) {
  var pt = $.CGPointMake(parseFloat(argv[0]), parseFloat(argv[1]));
  var down = $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseDown, pt, $.kCGMouseButtonLeft);
  $.CGEventPost($.kCGHIDEventTap, down);
  delay(0.08);
  var up = $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseUp, pt, $.kCGMouseButtonLeft);
  $.CGEventPost($.kCGHIDEventTap, up);
  return 'posted';
}
`;

const clickAt = (point) => {
  execFileSync('osascript', ['-l', 'JavaScript', '-e', JXA_CLICK, String(point.x), String(point.y)], {
    timeout: 8000,
  });
};

const child = spawn(electronBin, [harness, '--', '--overlay', overlayMode, '--input', 'real', '--coords-file', coordsFile], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += String(chunk); });
child.stderr.on('data', (chunk) => { output += String(chunk); });
// Attach at spawn time: the harness exits promptly after its clicks, and an
// exit listener attached later would miss the event entirely.
const exitPromise = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate, timeoutMs, what) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    // eslint-disable-next-line no-await-in-loop
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
};

let driverFailed = false;
try {
  await waitFor(() => fs.existsSync(coordsFile), 20000, 'the coords file');
  await sleep(300); // window is shown + painted (harness sleeps 800ms before writing coords)
  const coords = JSON.parse(fs.readFileSync(coordsFile, 'utf8'));
  clickAt(coords.control); // positive control first: proves the probe can see clicks
  await sleep(400);
  clickAt(coords.target);
  // The harness prints its RESULT JSON and exits on its own (its poll window
  // is 15s per button); give it room, never spuriously fail the driver.
  await sleep(8000);
} catch (error) {
  console.error(`[run-drag-harness] driver failed: ${error.message}`);
  driverFailed = true;
}

const exitCode = await Promise.race([
  exitPromise,
  (async () => {
    await sleep(10000);
    child.kill('SIGKILL');
    return 1;
  })(),
]);
const jsonLine = output.trim().split('\n').filter((line) => line.startsWith('{')).join('\n');
console.log(jsonLine || output.trim());
fs.rmSync(coordsFile, { force: true });
process.exit(driverFailed ? 3 : (exitCode ?? 1));
