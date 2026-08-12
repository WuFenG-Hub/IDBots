import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { spawn } from 'node:child_process';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const runtimeScript = path.join(repoRoot, 'SKILLs/metabot-create-wiki/assets/metabot-llm-wiki-runtime/scripts/index.js');

async function runRuntime(payload, env) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [runtimeScript, '--payload', JSON.stringify(payload)], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
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
    child.on('close', (code) => {
      let json = null;
      try {
        json = JSON.parse(stdout.trim());
      } catch {
        json = null;
      }
      resolve({ code, stdout, stderr, json });
    });
  });
}

// Starts a stub IDBots RPC that answers the /api/idbots/files/upload-largefile
// call the wiki runtime now makes (instead of spawning the retired
// metabot-upload-file CLI script). Resolves with the base URL and the captured
// request bodies.
async function startUploadRpcStub() {
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      if (req.method === 'POST' && req.url.endsWith('/api/idbots/files/upload-largefile')) {
        received.push(parsed);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          pinId: 'wiki-zip-pin-i0',
          metafileUri: 'metafile://wiki-zip-pin-i0.zip',
          fileName: 'bundle.zip',
          size: 123,
          contentType: 'application/zip',
          uploadMode: 'direct',
          network: parsed && parsed.network ? parsed.network : 'mvc',
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, received, close: () => new Promise((r) => server.close(r)) };
}

test('publish_zip uses an extension-bearing metafile URI for uploaded wiki bundles', async () => {
  const rpc = await startUploadRpcStub();
  try {
    const rootDir = path.join(await mkdtemp(path.join(os.tmpdir(), 'idbots-wiki-metafile-')), 'kb');
    const zipPath = path.join(rootDir, 'manifests/wiki.zip');
    await mkdir(path.dirname(zipPath), { recursive: true });
    await writeFile(zipPath, 'zip bytes\n', 'utf8');

    const result = await runRuntime(
      {
        action: 'publish_zip',
        kbId: 'test-wiki',
        payload: {
          rootDir,
          zipPath,
          uploadZip: true,
        },
      },
      { IDBOTS_RPC_URL: rpc.base, IDBOTS_METABOT_ID: '7' },
    );

    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(result.json?.success, true);
    assert.equal(result.json?.data?.zipUri, 'metafile://wiki-zip-pin-i0.zip');
    // The runtime must have hit the RPC upload endpoint with the zip path and
    // the resolved metabot id, not spawned an external skill script.
    assert.equal(rpc.received.length, 1);
    assert.equal(rpc.received[0].metabot_id, 7);
    assert.equal(rpc.received[0].file_path, zipPath);
    assert.equal(rpc.received[0].content_type, 'application/zip');
    assert.equal(rpc.received[0].network, 'mvc');
  } finally {
    await rpc.close();
  }
});
