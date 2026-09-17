#!/usr/bin/env node
/**
 * SimpleLog pilot writer — publish ONE /protocols/simplelog record (v1).
 *
 * The in-app tool `post_simplelog` serves cowork sessions; this CLI is the
 * same record written from a shell (group-task workers run commands, not a
 * model turn), validated by the SAME module (dist-electron/main/libs/
 * simpleLogProtocol.js), so a record the CLI accepts is a record the ledger
 * and the timeline app can replay.
 *
 * Usage:
 *   node scripts/simplelog-post.mjs --kind status --summary "第一棒完成" \
 *     --taskid <64hex>i0 [--step 第一棒] [--status executing] [--role worker] \
 *     [--toid idq1…] [--taskkey local:184] \
 *     [--deliverable pin://<64hex>i0]... [--ref pin://<64hex>i0]... \
 *     [--content "markdown detail"] [--content-file path] [--extra '{"k":1}'] \
 *     [--metabot 15] [--network mvc] [--dry-run]
 *
 *   node scripts/simplelog-post.mjs --json-file record.json        # raw record
 *   node scripts/simplelog-post.mjs --json '{"v":1,"kind":...}'    # raw record
 *
 * Exit codes: 0 published (or dry-run ok), 1 RPC failure, 2 validation failure.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const { SIMPLELOG_PATH, buildSimpleLogPayload } = require(
  path.join(root, 'dist-electron', 'main', 'libs', 'simpleLogProtocol.js'),
);

function parseArgv(argv) {
  const flags = { deliverable: [], ref: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'dry-run') {
      flags.dryRun = true;
      continue;
    }
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`missing value for --${key}`);
    }
    i += 1;
    if (key === 'deliverable') flags.deliverable.push(value);
    else if (key === 'ref') flags.ref.push(value);
    else flags[key] = value;
  }
  return flags;
}

function loadInput() {
  const flags = parseArgv(process.argv.slice(2));
  if (flags.json != null || flags['json-file'] != null) {
    const raw = flags['json-file'] != null
      ? readFileSync(flags['json-file'], 'utf8')
      : flags.json;
    return { input: JSON.parse(raw), flags };
  }
  const content = flags['content-file'] != null
    ? readFileSync(flags['content-file'], 'utf8')
    : flags.content;
  const input = {
    kind: flags.kind,
    summary: flags.summary,
    taskid: flags.taskid,
    taskkey: flags.taskkey,
    step: flags.step,
    status: flags.status,
    role: flags.role,
    toid: flags.toid,
    deliverables: flags.deliverable,
    refs: flags.ref,
    content,
    ...(flags.extra != null ? { extra: JSON.parse(flags.extra) } : {}),
  };
  return { input, flags };
}

function resolveRpc() {
  const url = (process.env.IDBOTS_RPC_URL || 'http://127.0.0.1:31200').replace(/\/$/, '');
  let token = (process.env.IDBOTS_RPC_TOKEN || '').trim();
  if (!token && process.env.IDBOTS_RPC_AUTHFILE) {
    token = readFileSync(process.env.IDBOTS_RPC_AUTHFILE, 'utf8').trim();
  }
  if (!token) {
    throw new Error('no RPC token: set IDBOTS_RPC_TOKEN or IDBOTS_RPC_AUTHFILE');
  }
  return { url, token };
}

async function main() {
  const { input, flags } = loadInput();
  const built = buildSimpleLogPayload(input);
  if (!built.ok) {
    console.error('SimpleLog record rejected (nothing published):');
    for (const error of built.errors) console.error(`  - ${error}`);
    process.exit(2);
  }
  for (const warning of built.warnings) console.error(`note: ${warning}`);

  const body = JSON.stringify(built.payload);
  if (built.payload.content != null && Buffer.byteLength(body, 'utf8') > 8192) {
    console.error(
      `SimpleLog record payload is ${Buffer.byteLength(body, 'utf8')} bytes — over the safe on-chain size; move detail to a metafile and use refs`,
    );
    process.exit(2);
  }

  if (flags.dryRun) {
    console.log(body);
    process.exit(0);
  }

  const metabotId = Number(flags.metabot ?? process.env.IDBOTS_METABOT_ID);
  if (!Number.isInteger(metabotId) || metabotId <= 0) {
    throw new Error('pass --metabot <id> or set IDBOTS_METABOT_ID');
  }
  const network = flags.network || 'mvc';
  const { url, token } = resolveRpc();

  const response = await fetch(`${url}/api/metaid/create-pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      metabot_id: metabotId,
      network,
      metaidData: {
        operation: 'create',
        path: SIMPLELOG_PATH,
        encryption: '0',
        version: '1.0.0',
        contentType: 'application/json',
        payload: body,
      },
    }),
  });
  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(`RPC returned non-JSON (${response.status}): ${text.slice(0, 200)}`);
  }
  if (!response.ok || result.success === false) {
    throw new Error(`create-pin failed (${response.status}): ${result.error ?? text.slice(0, 200)}`);
  }

  const pinId = result.pinId ?? `${result.txid}i0`;
  console.log('SimpleLog record cast on-chain.');
  console.log(`- pinId: ${pinId}`);
  if (result.txid) console.log(`- txid: ${result.txid}`);
  console.log(`- kind: ${built.payload.kind}`);
  console.log(`- task anchor: ${built.payload.taskid ?? built.payload.taskkey}`);
  console.log(`- summary: ${built.payload.summary}`);
  if (Array.isArray(built.payload.deliverables)) {
    for (const uri of built.payload.deliverables) console.log(`- deliverable: ${uri}`);
  }
  console.log(`- totalCost: ${result.totalCost ?? 'n/a'} sats`);
  console.log(`- view link: [pin://${pinId}](pin://${pinId})`);
  console.log(`- read back: omni_read pins_by_path ${SIMPLELOG_PATH}`);
}

main().catch((error) => {
  console.error(`simplelog-post failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
