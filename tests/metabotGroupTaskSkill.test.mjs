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

test('propose forwards the staffing plan to propose-staffing', async (t) => {
  const rpc = await createRpcServer();
  t.after(() => rpc.close());

  const result = await runSkill(JSON.stringify({
    action: 'propose',
    title: '技能介绍',
    goal: '写出介绍并发布',
    source_session_id: 'sess-1',
    plan: { stages: [], seats: [{ role: 'content', candidateName: 'Coder', source: 'local' }] },
  }), rpc.url);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(rpc.requests[0].url, '/api/idbots/group-task/propose-staffing');
  assert.equal(rpc.requests[0].body.source_session_id, 'sess-1');
  assert.equal(rpc.requests[0].body.plan.seats[0].role, 'content');
});

test('search_candidates forwards query and role_hint', async (t) => {
  const rpc = await createRpcServer();
  t.after(() => rpc.close());

  const missing = await runSkill(JSON.stringify({ action: 'search_candidates' }), rpc.url);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /query or role_hint is required/);
  assert.equal(rpc.requests.length, 0);

  const ok = await runSkill(JSON.stringify({
    action: 'search_candidates',
    query: '法律 合同',
    role_hint: 'domain',
    domain_label: 'legal',
    limit: 8,
  }), rpc.url);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(rpc.requests[0].url, '/api/idbots/group-task/search-candidates');
  assert.equal(rpc.requests[0].body.query, '法律 合同');
  assert.equal(rpc.requests[0].body.role_hint, 'domain');
  assert.equal(rpc.requests[0].body.domain_label, 'legal');
  assert.equal(rpc.requests[0].body.limit, 8);
});

test('create requires proposal_id and forwards it', async (t) => {
  const rpc = await createRpcServer();
  t.after(() => rpc.close());

  const missing = await runSkill(JSON.stringify({
    action: 'create',
    title: '技能介绍',
    goal: '写出介绍并发布',
  }), rpc.url);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /proposal_id is required/);
  assert.equal(rpc.requests.length, 0);

  const ok = await runSkill(JSON.stringify({
    action: 'create',
    title: '技能介绍',
    goal: '写出介绍并发布',
    proposal_id: 7,
    source_session_id: 'sess-1',
  }), rpc.url);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(rpc.requests[0].url, '/api/idbots/group-task/create');
  assert.equal(rpc.requests[0].body.proposal_id, 7);
  assert.equal(rpc.requests[0].body.created_by, 'twinbot');
});

test('fix-v2 P1-4: show forwards view, limit and before_id to the show endpoint', async (t) => {
  const rpc = await createRpcServer();
  t.after(() => rpc.close());

  const ok = await runSkill(JSON.stringify({
    action: 'show',
    task_id: 62,
    view: 'summary',
    limit: 50,
    before_id: 3546,
  }), rpc.url);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(rpc.requests[0].url, '/api/idbots/group-task/show');
  assert.deepEqual(rpc.requests[0].body, {
    task_id: 62,
    view: 'summary',
    before_id: 3546,
    limit: 50,
  });

  // Out-of-range values fail locally with a clear error, no RPC call.
  const rpc2 = await createRpcServer();
  t.after(() => rpc2.close());
  const bad = await runSkill(JSON.stringify({ action: 'show', task_id: 62, limit: 0 }), rpc2.url);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /limit must be a positive integer for show/);
  assert.equal(rpc2.requests.length, 0);
});
