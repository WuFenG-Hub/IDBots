// Layer 2 fix for "DSH sessions: SKILL RPC all 401": the DSH bash tool
// scrubs env names matching /KEY|PASSWORD|SECRET|TOKEN/i from model-visible
// subprocesses, so IDBOTS_RPC_TOKEN never reaches SKILL scripts there. The
// host mirrors the per-launch token into <userData>/metaid-rpc-token (0600)
// and skill RPC clients fall back to reading it via IDBOTS_RPC_AUTHFILE.
// Requires: npm run compile:electron.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const requireFromHere = Module.createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const endpoint = requireFromHere('../dist-electron/main/services/metaidRpcEndpoint.js');
const groupTaskScript = path.join(repoRoot, 'SKILLs/metabot-group-task/scripts/index.js');

test('getMetaidRpcTokenFilePath joins the userData dir with the fixed filename', () => {
  assert.equal(
    endpoint.getMetaidRpcTokenFilePath(path.join('/tmp', 'userdata')),
    path.join('/tmp', 'userdata', 'metaid-rpc-token'),
  );
  assert.equal(endpoint.METAID_RPC_AUTHFILE_ENV, 'IDBOTS_RPC_AUTHFILE');
});

test('writeMetaidRpcTokenFile mirrors the pinned token with 0600 perms and rewrites on relaunch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-rpctoken-'));
  const tokenPath = endpoint.getMetaidRpcTokenFilePath(dir);

  const first = endpoint.writeMetaidRpcTokenFile(dir, { IDBOTS_RPC_TOKEN: 'token-one' });
  assert.equal(first, tokenPath);
  assert.equal(fs.readFileSync(tokenPath, 'utf8').trim(), 'token-one');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
  }

  // Relaunch with a fresh token: the mirror must be overwritten in place.
  const second = endpoint.writeMetaidRpcTokenFile(dir, { IDBOTS_RPC_TOKEN: 'token-two' });
  assert.equal(second, tokenPath);
  assert.equal(fs.readFileSync(tokenPath, 'utf8').trim(), 'token-two');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
  }
});

test('writeMetaidRpcTokenFile returns null (no throw) when the directory is unwritable', () => {
  const missingDir = path.join(os.tmpdir(), `idbots-rpctoken-missing-${Date.now()}`);
  assert.equal(endpoint.writeMetaidRpcTokenFile(missingDir, { IDBOTS_RPC_TOKEN: 'x' }), null);
});

async function createCapturingServer() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, tasks: [] }));
  });
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  return {
    seen,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function runGroupTaskList(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [groupTaskScript, '--payload', JSON.stringify({ action: 'list' })], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('skill RPC client authenticates from the AUTHFILE mirror when the TOKEN env is scrubbed (DSH shape)', async (t) => {
  const rpc = await createCapturingServer();
  t.after(() => rpc.close());
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-rpcauthfile-'));
  const authFile = path.join(authDir, 'metaid-rpc-token');
  fs.writeFileSync(authFile, 'file-borne-token\n', 'utf8');

  // DSH bash shape: IDBOTS_RPC_TOKEN erased, only the scrub-proof AUTHFILE name survives.
  const env = {
    ...process.env,
    IDBOTS_RPC_URL: rpc.url,
    IDBOTS_RPC_AUTHFILE: authFile,
  };
  delete env.IDBOTS_RPC_TOKEN;

  const result = await runGroupTaskList(env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(rpc.seen.length, 1);
  assert.equal(rpc.seen[0].authorization, 'Bearer file-borne-token');
});

test('skill RPC client still prefers the TOKEN env over the AUTHFILE mirror', async (t) => {
  const rpc = await createCapturingServer();
  t.after(() => rpc.close());
  const env = {
    ...process.env,
    IDBOTS_RPC_URL: rpc.url,
    IDBOTS_RPC_TOKEN: 'env-token',
    IDBOTS_RPC_AUTHFILE: '/nonexistent/metaid-rpc-token',
  };

  const result = await runGroupTaskList(env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(rpc.seen[0].authorization, 'Bearer env-token');
});
