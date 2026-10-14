#!/usr/bin/env node
/**
 * cerebellum-worker-rank-eval — offline eval of worker fit ranking.
 *
 * One labeled worker per Chinese task goal. Metric: top-1 accuracy and
 * recall@3. The request body is buildWorkerRankRequest.
 *
 *   node scripts/cerebellum-worker-rank-eval.mjs eval --dry-run
 *   node scripts/cerebellum-worker-rank-eval.mjs eval
 */

import { argv, env, exit } from 'node:process';
import {
  CEREBELLUM_WORKER_RANK_TOP_K,
  buildWorkerRankRequest,
  parseWorkerRankAnswers,
} from '../src/main/cerebellum/workerRank.ts';

const ROSTER = [
  { id: 'design', name: '小绘', description: '设计师。负责海报、配色、版式。印象：视觉交付稳定，不写代码。' },
  { id: 'eng', name: '阿码', description: '工程师。负责接口、链上交付、txid。印象：能把文件发到链上。' },
  { id: 'copy', name: '文案', description: '文案。负责中文标题和短介绍。印象：写得快，不做设计。' },
  { id: 'ops', name: '运营', description: '运营。负责发布节奏和渠道。印象：擅长排期，不画图。' },
];

const QUERIES = [
  { q: '做一张活动海报，要醒目的大字和配色', relevant: 'design' },
  { q: '把交付文件发到链上，并在群里贴 txid', relevant: 'eng' },
  { q: '给这个产品写三句中文介绍', relevant: 'copy' },
  { q: '排一下这周各渠道的发布时间', relevant: 'ops' },
  { q: '海报初稿的字体和留白再收一版', relevant: 'design' },
  { q: '接口 401 了，把免费 relay 的请求修好', relevant: 'eng' },
];

function parseArgs(args) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--key') opts.apiKey = args[++i];
    else if (arg === '--base-url') opts.baseUrl = args[++i];
    else if (arg === '--model') opts.model = args[++i];
    else if (arg.startsWith('--')) { console.error(`unknown option: ${arg}`); exit(2); }
    else positional.push(arg);
  }
  return { mode: positional[0] ?? 'eval', opts };
}

async function postJson(url, apiKey, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

const { mode, opts } = parseArgs(argv.slice(2));
const apiKey = opts.apiKey ?? env.TYPESAFE_API_KEY ?? env.JEV_API_KEY;
const baseUrl = (opts.baseUrl ?? env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai').replace(/\/+$/, '');
const model = opts.model ?? 'jev-latest';

if (mode !== 'eval') {
  console.error('unknown mode (use eval)');
  exit(2);
}
if (opts.dryRun) {
  console.log(`dry-run: ${ROSTER.length} workers, ${QUERIES.length} goals — no API calls.\n`);
  console.log(JSON.stringify(buildWorkerRankRequest({ taskText: QUERIES[0].q, workers: ROSTER, model }), null, 2));
  process.exit(0);
}
if (!apiKey) {
  console.error('missing API key: pass --key or set TYPESAFE_API_KEY');
  exit(2);
}

let top1 = 0;
let recall = 0;
for (const item of QUERIES) {
  const request = buildWorkerRankRequest({ taskText: item.q, workers: ROSTER, model });
  let ranking;
  try {
    ranking = parseWorkerRankAnswers(await postJson(`${baseUrl}/v1/systemone`, apiKey, request), ROSTER);
  } catch (error) {
    console.error(`${item.relevant} failed: ${error.message}`);
    continue;
  }
  if (!ranking) {
    console.error(`${item.q} — no ranking`);
    continue;
  }
  const top = ranking.slice(0, CEREBELLUM_WORKER_RANK_TOP_K).map((entry) => entry.id);
  const hit1 = top[0] === item.relevant;
  const hitK = top.includes(item.relevant);
  if (hit1) top1 += 1;
  if (hitK) recall += 1;
  console.log(`${hit1 ? 'ok' : 'miss'}  want=${item.relevant}  top=${top.join(',')}  ${item.q}`);
}
console.log(`top-1 ${top1}/${QUERIES.length}  recall@${CEREBELLUM_WORKER_RANK_TOP_K} ${recall}/${QUERIES.length}`);
