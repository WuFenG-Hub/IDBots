#!/usr/bin/env node
/**
 * Minimal Electron harness for the drag-region click-through bug (owner
 * 2026-09-18 feedback ①: the long-task drawer's top-right X swallowed clicks).
 *
 * Geometry mirrors the failing drawer: a frameless window with a 48px
 * `-webkit-app-region: drag` header (ScheduledTasksView header), plus a fixed
 * full-window overlay carrying a close button at the TOP-RIGHT — inside the
 * 48px strip. A second control button sits in the LOWER half, outside any
 * drag region, as the positive control: a probe that cannot see clicks at all
 * must fail here first, never report a false "click lost".
 *
 * Modes (argv):
 *   --overlay no-drag|with-drag   without non-draggable (the bug) vs with it (the fix)
 *   --input inject|real
 *     inject = webContents.sendInputEvent, in-process. NOTE: injected events
 *     enter BELOW the native drag-region interception, so this probe is blind
 *     to the bug (it records pass even on the buggy overlay) — kept only as a
 *     documented negative control for the probe itself.
 *     real   = the harness positions a frameless window, writes the buttons'
 *              SCREEN coordinates to --coords-file, then polls; the DRIVER
 *              (run-drag-harness.mjs) performs the OS-level System Events
 *              clicks from OUTSIDE Electron. osascript must not be spawned by
 *              the Electron process: TCC attributes the assistive-access
 *              decision to the (unsigned, unlisted) app and the click hangs.
 *
 * Exit code 0 = the mode's expectation held; 1 = it did not. Read the RESULT
 * JSON before judging: probeHealthy=false invalidates the run.
 *
 * Usage (see run-drag-harness.mjs for the real-input driver):
 *   node_modules/.bin/electron tests/manual/electron-drag-region-harness.mjs -- \
 *     --overlay no-drag --input inject
 * userData is pointed at a fresh /tmp dir; this harness never touches the
 * real app profile.
 */

import electron from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { app, BrowserWindow } = electron;

const args = process.argv.slice(process.argv.indexOf('--') + 1);
const overlayMode = args.includes('--overlay') ? args[args.indexOf('--overlay') + 1] : null;
const inputMode = args.includes('--input') ? args[args.indexOf('--input') + 1] : null;
const coordsFile = args.includes('--coords-file') ? args[args.indexOf('--coords-file') + 1] : null;
const useNoDrag = overlayMode === 'no-drag';
const overlayClass = useNoDrag ? '' : ' non-draggable';

if (!['no-drag', 'with-drag'].includes(overlayMode) || !['inject', 'real'].includes(inputMode)
  || (inputMode === 'real' && !coordsFile)) {
  console.error('usage: electron tests/manual/electron-drag-region-harness.mjs -- '
    + '--overlay no-drag|with-drag --input inject|real [--coords-file <path>]');
  process.exit(2);
}

// Isolated userData: /tmp only, never the real profile.
app.setPath('userData', path.join(os.tmpdir(), `idbots-drag-harness-${Date.now()}`));

const HTML = `<!doctype html>
<html><head><style>
  body { margin: 0; font-family: sans-serif; }
  .draggable-strip {
    position: absolute; top: 0; left: 0; right: 0; height: 48px;
    -webkit-app-region: drag; background: #dcd6f7;
  }
  .draggable-strip * { -webkit-app-region: no-drag; }
  .overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.15);
  }
  .non-draggable, .non-draggable * { -webkit-app-region: no-drag; }
  #target {
    position: absolute; top: 12px; right: 12px; width: 28px; height: 28px;
    background: #ff5d5d; border: 0; cursor: pointer;
  }
  #control {
    position: absolute; top: 200px; right: 12px; width: 28px; height: 28px;
    background: #4cc38a; border: 0; cursor: pointer;
  }
</style></head>
<body>
  <div class="draggable-strip"></div>
  <div class="overlay${overlayClass}">
    <button id="target" aria-label="close"></button>
    <button id="control" aria-label="control"></button>
  </div>
  <script>
    window.__targetClicked = false;
    window.__controlClicked = false;
    document.getElementById('target').addEventListener('click', () => { window.__targetClicked = true; });
    document.getElementById('control').addEventListener('click', () => { window.__controlClicked = true; });
  </script>
</body></html>`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollClicked(win, key, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const hit = await win.webContents.executeJavaScript(`window.${key} === true`);
    if (hit) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(50);
  }
  return false;
}

async function centerOf(win, selector) {
  return win.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector('${selector}').getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 420,
    height: 300,
    frame: false,
    show: inputMode === 'real',
    x: 60,
    y: 60,
  });
  win.setAlwaysOnTop(true);
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`);

  const target = await centerOf(win, '#target');
  const control = await centerOf(win, '#control');

  let targetTimeoutMs = 1500;
  if (inputMode === 'inject') {
    for (const point of [control, target]) {
      win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    }
  } else {
    // Real window-server input, driven OUTSIDE this process. getBounds() and
    // System Events both work in top-left-origin points, so the mapping is 1:1.
    await sleep(800); // let the shown window paint before anything clicks it
    const bounds = win.getBounds();
    const screen = {
      window: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      control: { x: Math.round(bounds.x + control.x), y: Math.round(bounds.y + control.y) },
      target: { x: Math.round(bounds.x + target.x), y: Math.round(bounds.y + target.y) },
    };
    fs.writeFileSync(coordsFile, JSON.stringify(screen));
    // The driver clicks as soon as the coords file lands; give it time.
    targetTimeoutMs = 15000;
  }

  // Control first: the probe must see a click OUTSIDE any drag region before
  // a negative result about the target can mean anything.
  const controlHit = await pollClicked(win, '__controlClicked', targetTimeoutMs);
  const targetHit = await pollClicked(win, '__targetClicked', targetTimeoutMs);

  const expectedTargetHit = !useNoDrag; // with-drag = the fix, the click must land
  const probeHealthy = controlHit === true; // positive control: the probe sees clicks
  const verdict = probeHealthy && targetHit === expectedTargetHit;

  console.log(JSON.stringify({
    harness: 'drag-region',
    overlay: overlayMode,
    input: inputMode,
    controlClicked: controlHit,
    targetClicked: targetHit,
    probeHealthy,
    verdict,
  }));

  app.exit(verdict ? 0 : 1);
});
