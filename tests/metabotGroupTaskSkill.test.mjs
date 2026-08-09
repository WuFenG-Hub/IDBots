import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const groupTaskScript = path.join(repoRoot, 'SKILLs/metabot-group-task/scripts/index.js');

async function createRpcServer() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    requests.push({ url: req.url, body: body ? JSON.parse(body) : {} });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, members: [{ metabotId: 1, name: 'Builder', workStatus: 'working' }] }));
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });

  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function runSkill(payload, rpcUrl) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [groupTaskScript, '--payload', payload], {
      cwd: repoRoot,
      env: { ...process.env, IDBOTS_RPC_URL: rpcUrl },
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

test('F4: member_status forwards task_id to the member-status RPC endpoint and prints the result', async (t) => {
  const rpc = await createRpcServer();
  t.after(() => rpc.close());

  const result = await runSkill(JSON.stringify({ action: 'member_status', task_id: 42 }), rpc.url);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(rpc.requests.length, 1);
  assert.equal(rpc.requests[0].url, '/api/idbots/group-task/member-status');
  assert.deepEqual(rpc.requests[0].body, { task_id: 42 });
  const printed = JSON.parse(result.stdout.trim());
  assert.equal(printed.success, true);
  assert.equal(printed.members[0].workStatus, 'working');
});

test('F4: member_status requires a valid task_id', async (t) => {
  const rpc = await createRpcServer();
  t.after(() => rpc.close());

  const result = await runSkill(JSON.stringify({ action: 'member_status' }), rpc.url);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /task_id is required for member_status/);
  assert.equal(rpc.requests.length, 0);
});

test('F4: unknown action error enumerates member_status in the supported list', async (t) => {
  const rpc = await createRpcServer();
  t.after(() => rpc.close());

  const result = await runSkill(JSON.stringify({ action: 'no-such-action' }), rpc.url);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /action must be one of/);
  assert.match(result.stderr, /member_status/);
  assert.equal(rpc.requests.length, 0);
});
