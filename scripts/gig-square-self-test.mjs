/**
 * Self-test for Gig Square step 2: transfer worker + broadcast.
 *
 * The worker broadcasts a REAL MVC transfer from the provided wallet and returns
 * the txId (there is no dry-run mode), so this script refuses to run unless
 * --broadcast is passed explicitly. Use a dedicated test wallet and a small amount.
 *
 * 1. Compile: npm run compile:electron
 * 2. Set env: IDBOTS_METABOT_MNEMONIC, IDBOTS_METABOT_PATH (optional, default m/44'/10001'/0'/0/0)
 * 3. Run: node scripts/gig-square-self-test.mjs [toAddress] [amountSPACE] --broadcast
 *    Example: node scripts/gig-square-self-test.mjs 1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za 0.001 --broadcast
 */

import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const positionals = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const toAddress = positionals[0] || '1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za';
const amountSpace = positionals[1] || '0.001';
const doBroadcast = process.argv.includes('--broadcast');

// 0.001 SPACE = 100000 sats (1 SPACE = 10^8 sats)
const amountSats = Math.floor(parseFloat(amountSpace) * 1e8);
if (!Number.isFinite(amountSats) || amountSats < 600) {
  console.error('Invalid amount (min 600 sats). Use e.g. 0.001');
  process.exit(1);
}

if (!doBroadcast) {
  console.error(
    '[GigSquare self-test] Refusing to run: the transfer worker broadcasts a REAL transaction from the provided wallet. Pass --broadcast to proceed.',
  );
  process.exit(1);
}

const mnemonic = process.env.IDBOTS_METABOT_MNEMONIC?.trim();
const pathStr = process.env.IDBOTS_METABOT_PATH?.trim() || "m/44'/10001'/0'/0/0";

if (!mnemonic) {
  console.error('Set IDBOTS_METABOT_MNEMONIC (e.g. from your first MetaBot wallet).');
  process.exit(1);
}

const workerPath = path.join(root, 'dist-electron', 'main', 'libs', 'transferMvcWorker.js');
if (!existsSync(workerPath)) {
  console.error('Worker not found. Run: npm run compile:electron');
  process.exit(1);
}

const payload = JSON.stringify({
  toAddress,
  amountSats,
  feeRate: 1,
});

console.log('[GigSquare self-test] Running MVC worker (REAL MVC broadcast)', { toAddress, amountSats, feeRate: 1 });
console.log('[GigSquare self-test] Worker path:', workerPath);

const electronPath = getElectronPath();
if (!electronPath) {
  console.error('Electron not found. Run from project root with npm install.');
  process.exit(1);
}

const env = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  IDBOTS_METABOT_MNEMONIC: mnemonic,
  IDBOTS_METABOT_PATH: pathStr,
};

const child = spawn(electronPath, [workerPath], {
  cwd: root,
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout?.on('data', (d) => { stdout += d.toString(); });
child.stderr?.on('data', (d) => { stderr += d.toString(); });
child.stdin?.write(payload, () => child.stdin?.end());
child.on('error', (err) => {
  console.error('[GigSquare self-test] spawn error:', err.message);
  process.exit(1);
});

child.on('close', (code) => {
  if (stderr.trim()) console.log('[GigSquare self-test] stderr:', stderr.trim());
  if (code !== 0) {
    console.error('[GigSquare self-test] worker exit code:', code);
    console.error(stdout.trim() || stderr.trim());
    process.exit(1);
  }
  try {
    const result = JSON.parse(stdout.trim());
    if (!result.success || !result.txId) {
      console.error('[GigSquare self-test] worker returned error:', result.error || 'no txId');
      process.exit(1);
    }
    console.log('[GigSquare self-test] OK — worker broadcast MVC transfer, txId:', result.txId);
  } catch (e) {
    console.error('[GigSquare self-test] parse error:', e.message);
    console.error(stdout);
    process.exit(1);
  }
});

function getElectronPath() {
  try {
    const p = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
    if (existsSync(p)) return p;
    const win = path.join(root, 'node_modules', '.bin', 'electron');
    if (existsSync(win)) return win;
    return require.resolve('electron');
  } catch {
    return null;
  }
}
