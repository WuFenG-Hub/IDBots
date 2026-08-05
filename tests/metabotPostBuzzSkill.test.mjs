import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const postBuzzScript = path.join(repoRoot, 'SKILLs/metabot-post-buzz/scripts/post-buzz.js');

async function createRpcServer() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'not found' }));
      return;
    }

    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    const parsed = JSON.parse(body);
    calls.push(parsed);

    if (req.url === '/api/idbots/files/upload-largefile') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        pinId: `file-pin-${calls.length}`,
        metafileUri: `metafile://file-pin-${calls.length}.png`,
        previewUrl: `https://file.metaid.io/metafile-indexer/api/v1/files/content/file-pin-${calls.length}`,
        downloadUrl: `https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/file-pin-${calls.length}`,
        metawebUrl: `https://openagentinternet.org/browser/metafile/file-pin-${calls.length}`,
        fileName: parsed.file_path ? path.basename(parsed.file_path) : 'file',
        size: 123,
        contentType: 'image/png;binary',
        uploadMode: 'direct',
        network: parsed.network || 'mvc',
        txids: [`file-tx-${calls.length}`],
      }));
      return;
    }

    if (req.url !== '/api/metaid/create-pin') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'not found' }));
      return;
    }

    const pathName = parsed?.metaidData?.path;
    const index = calls.length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      pinId: pathName === '/file' ? `file-pin-${index}` : `buzz-pin-${index}`,
      txid: pathName === '/file' ? `file-tx-${index}` : `buzz-tx-${index}`,
      totalCost: 100 + index,
    }));
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });

  return {
    calls,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function runPostBuzz(args, rpcUrl) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [postBuzzScript, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        IDBOTS_METABOT_ID: '1',
        IDBOTS_RPC_URL: rpcUrl,
      },
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
      resolve({ code, stdout, stderr });
    });
  });
}

test('post-buzz request file preserves shell-significant text content', async (t) => {
  const rpc = await createRpcServer();
  t.after(() => rpc.close());

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'idbots-post-buzz-request-'));
  const requestFile = path.join(tempDir, 'request.json');
  const content = 'quotes " double, single \', backtick `, dollar $HOME, newline\nunicode \u4e2d\u6587';
  await writeFile(requestFile, JSON.stringify({ content }, null, 2), 'utf8');

  const result = await runPostBuzz(['--request-file', requestFile], rpc.url);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(rpc.calls.length, 1);
  assert.equal(rpc.calls[0].metaidData.path, '/protocols/simplebuzz');
  const payload = JSON.parse(rpc.calls[0].metaidData.payload);
  assert.equal(payload.content, content);
  assert.deepEqual(payload.attachments, []);
});

test('post-buzz request file passes metafile attachments directly to simplebuzz', async (t) => {
  const rpc = await createRpcServer();
  t.after(() => rpc.close());

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'idbots-post-buzz-metafile-'));
  const requestFile = path.join(tempDir, 'request.json');
  await writeFile(requestFile, JSON.stringify({
    content: 'hello metafile',
    attachments: ['metafile://existing-pin-1.png'],
  }, null, 2), 'utf8');

  const result = await runPostBuzz(['--request-file', requestFile], rpc.url);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(rpc.calls.length, 1);
  assert.equal(rpc.calls[0].metaidData.path, '/protocols/simplebuzz');
  const payload = JSON.parse(rpc.calls[0].metaidData.payload);
  assert.deepEqual(payload.attachments, ['metafile://existing-pin-1.png']);
  const output = JSON.parse(result.stdout.trim());
  assert.deepEqual(output.attachments, ['metafile://existing-pin-1.png']);
});

test('post-buzz attachment flag accepts metafile URIs without uploading them', async (t) => {
  const rpc = await createRpcServer();
  t.after(() => rpc.close());

  const result = await runPostBuzz([
    '--content',
    'hello from argv',
    '--attachment',
    'metafile://existing-pin-2.jpg',
  ], rpc.url);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(rpc.calls.length, 1);
  assert.equal(rpc.calls[0].metaidData.path, '/protocols/simplebuzz');
  const payload = JSON.parse(rpc.calls[0].metaidData.payload);
  assert.deepEqual(payload.attachments, ['metafile://existing-pin-2.jpg']);
});

test('post-buzz uploads local attachments through the unified upload flow', async (t) => {
  const rpc = await createRpcServer();
  t.after(() => rpc.close());

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'idbots-post-buzz-upload-'));
  const attachmentPath = path.join(tempDir, 'photo.png');
  await writeFile(attachmentPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'utf8');

  const result = await runPostBuzz([
    '--content',
    'hello with local attachment',
    '--attachment',
    attachmentPath,
    '--network',
    'doge',
  ], rpc.url);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(rpc.calls.length, 2);

  const uploadCall = rpc.calls[0];
  assert.equal(uploadCall.file_path, attachmentPath);
  assert.equal(uploadCall.content_type, 'image/png');
  assert.equal(uploadCall.network, 'mvc');

  const buzzCall = rpc.calls[1];
  assert.equal(buzzCall.network, 'doge');
  assert.equal(buzzCall.metaidData.path, '/protocols/simplebuzz');
  const payload = JSON.parse(buzzCall.metaidData.payload);
  assert.deepEqual(payload.attachments, ['metafile://file-pin-1.png']);

  const output = JSON.parse(result.stdout.trim());
  assert.deepEqual(output.attachments, ['metafile://file-pin-1.png']);
});
