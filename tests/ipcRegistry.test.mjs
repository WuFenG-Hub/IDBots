import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * REQ-A-12: every main-process invoke channel must be registered through
 * registerIpcHandler (src/main/ipc/registry.ts) so the gateway can dispatch
 * to it without a renderer. A bare `ipcMain.handle(` outside the registry
 * module fails this test.
 *
 * REQ-A-14: renderer broadcasts go through broadcastToRenderers
 * (src/main/ipc/broadcast.ts). A `BrowserWindow.getAllWindows()` loop that
 * sends to windows outside the broadcast module fails this test (single
 * specific-window sends and non-send lookups are fine).
 */

const srcMainDir = path.join(process.cwd(), 'src', 'main');

const listTsFiles = (dir) => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
};

const registryModulePath = path.join(srcMainDir, 'ipc', 'registry.ts');
const broadcastModulePath = path.join(srcMainDir, 'ipc', 'broadcast.ts');

test('no ipcMain.handle outside src/main/ipc/registry.ts', () => {
  const offenders = [];
  for (const file of listTsFiles(srcMainDir)) {
    if (file === registryModulePath) continue;
    const source = fs.readFileSync(file, 'utf8');
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      if (line.includes('ipcMain.handle(') || line.includes('ipcMain.handle<')) {
        offenders.push(`${path.relative(process.cwd(), file)}:${index + 1}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `bare ipcMain.handle registrations found outside the registry:\n${offenders.join('\n')}`,
  );
});

test('no getAllWindows broadcast loop outside src/main/ipc/broadcast.ts', () => {
  const offenders = [];
  for (const file of listTsFiles(srcMainDir)) {
    if (file === broadcastModulePath) continue;
    const source = fs.readFileSync(file, 'utf8');
    // A getAllWindows() site whose surrounding loop body still performs a
    // webContents.send is an un-migrated broadcast. Specific-window lookups
    // (.find / .filter without a send) are allowed.
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      if (!line.includes('getAllWindows()')) return;
      const window = lines.slice(index, index + 8).join('\n');
      if (/webContents\.send\(/.test(window)) {
        offenders.push(`${path.relative(process.cwd(), file)}:${index + 1}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `un-migrated broadcast loops found outside the broadcast module:\n${offenders.join('\n')}`,
  );
});

test('registry and broadcast modules expose the gateway seams', () => {
  const registrySource = fs.readFileSync(registryModulePath, 'utf8');
  assert.match(registrySource, /export function registerIpcHandler\(/);
  assert.match(registrySource, /export function getRegisteredIpcHandler\(/);
  assert.match(registrySource, /export async function invokeRegisteredHandler\(/);
  assert.match(registrySource, /ipcMain\.handle\(channel, handler\)/);

  const broadcastSource = fs.readFileSync(broadcastModulePath, 'utf8');
  assert.match(broadcastSource, /export function broadcastToRenderers\(/);
  assert.match(broadcastSource, /export function addBroadcastListener\(/);
});
