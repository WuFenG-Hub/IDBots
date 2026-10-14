#!/usr/bin/env node
/**
 * cerebellum-group-reply-eval — offline eval of the unsolicited group-reply gate.
 *
 * Mentions are decided in code and are not in this set. Each case is one
 * latest message plus a short recent window. The metric that matters is
 * LOST: a message labeled reply=true that the gate would skip. Extra replies
 * are the cheaper error ("rather over-reply than miss").
 *
 * The request body is buildGroupReplyRequest, so the wording cannot drift.
 *
 * Usage:
 *   node scripts/cerebellum-group-reply-eval.mjs eval --dry-run
 *   node scripts/cerebellum-group-reply-eval.mjs eval
 *   node scripts/cerebellum-group-reply-eval.mjs eval --cases cases.json
 *
 * --cases: [{ id, botName, latest, recent, reply }]
 */

import { argv, env, exit } from 'node:process';

import {
  CEREBELLUM_GROUP_REPLY_THRESHOLD,
  buildGroupReplyRequest,
  groupReplyFromNoul,
  parseGroupReplyNoul,
} from '../src/main/cerebellum/groupReplyGate.ts';

const SAMPLE = [
  { id: 'c1', botName: '大管家', reply: true, recent: ['部署脚本又挂了'], latest: '谁看下这个 401，免费小脑接口打不通' },
  { id: 'c2', botName: '大管家', reply: true, recent: ['群任务交付卡在最后一步'], latest: '没有 txid 的话客户会打回吗' },
  { id: 'c3', botName: '大管家', reply: true, recent: ['新建 worktree 之后状态全红'], latest: 'git status 把所有文件都标成修改了，怎么回事' },
  { id: 'c4', botName: '大管家', reply: true, recent: [], latest: '帮我把这周的群任务进度收个口' },
  { id: 'c5', botName: '大管家', reply: false, recent: ['Alice: 今晚吃啥'], latest: '火锅吧，我请客' },
  { id: 'c6', botName: '大管家', reply: false, recent: ['Bob: 哈哈哈哈'], latest: '笑死' },
  { id: 'c7', botName: '大管家', reply: false, recent: [], latest: '收到' },
  { id: 'c8', botName: '大管家', reply: false, recent: ['Carol: 小李你把海报发我'], latest: '小李，源文件也一起' },
  { id: 'c9', botName: '大管家', reply: true, recent: ['上次说记忆整池都在刷新'], latest: 'last_used 是不是又把没注入的也碰了' },
  { id: 'c10', botName: '大管家', reply: false, recent: ['David: 周末爬山吗'], latest: '我周六有空' },
];

const SWEEP = [0.2, 0.35, 0.5, 0.65];

function parseArgs(args) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--verbose') opts.verbose = true;
    else if (arg === '--key') opts.apiKey = args[++i];
    else if (arg === '--base-url') opts.baseUrl = args[++i];
    else if (arg === '--model') opts.model = args[++i];
    else if (arg === '--cases') opts.cases = args[++i];
    else if (arg.startsWith('--')) {
      console.error(`unknown option: ${arg}`);
      exit(2);
    } else positional.push(arg);
  }
  return { mode: positional[0] ?? 'eval', opts };
}

async function postJson(url, apiKey, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    return { data: JSON.parse(text), latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function runEval(opts) {
  const cases = opts.casesData ?? SAMPLE;
  if (opts.dryRun) {
    console.log(`dry-run: ${cases.length} cases — no API calls made.\n`);
    for (const item of cases) {
      console.log(`  ${item.reply ? 'REPLY' : 'SKIP '}  ${item.id}  ${item.latest}`);
    }
    console.log('\nfirst request body that would be sent:');
    const first = cases[0];
    console.log(JSON.stringify(buildGroupReplyRequest({
      botName: first.botName,
      latestMessage: first.latest,
      recentMessages: first.recent,
      model: opts.model,
    }), null, 2));
    return;
  }

  let lost = 0;
  let extra = 0;
  let labeled = 0;
  const scored = [];
  for (const item of cases) {
    const request = buildGroupReplyRequest({
      botName: item.botName,
      latestMessage: item.latest,
      recentMessages: item.recent ?? [],
      model: opts.model,
    });
    let data;
    let latencyMs;
    try {
      ({ data, latencyMs } = await postJson(`${opts.baseUrl}/v1/systemone`, opts.apiKey, request));
    } catch (error) {
      console.error(`  ${item.id} failed: ${error.message}`);
      continue;
    }
    const noul = parseGroupReplyNoul(data);
    if (noul === null) {
      console.error(`  ${item.id} no noul`);
      continue;
    }
    const reply = groupReplyFromNoul(noul);
    const want = item.reply === true;
    labeled += 1;
    if (want && !reply) lost += 1;
    if (!want && reply) extra += 1;
    scored.push({ ...item, noul, reply });
    const mark = want === reply ? 'ok' : want ? 'LOST' : 'EXTRA';
    console.log(`${mark.padEnd(5)} ${item.id}  noul=${noul.toFixed(2)}  want=${want ? 'reply' : 'skip'}  [${latencyMs}ms]  ${item.latest}`);
  }

  console.log('—'.repeat(72));
  console.log(`threshold=${CEREBELLUM_GROUP_REPLY_THRESHOLD}  lost=${lost}  extra=${extra}  labeled=${labeled}`);
  console.log('threshold sweep (lost / extra):');
  for (const threshold of SWEEP) {
    let sweepLost = 0;
    let sweepExtra = 0;
    for (const item of scored) {
      const reply = groupReplyFromNoul(item.noul, threshold);
      if (item.reply && !reply) sweepLost += 1;
      if (!item.reply && reply) sweepExtra += 1;
    }
    console.log(`  >=${threshold.toFixed(2)}  lost=${sweepLost}  extra=${sweepExtra}`);
  }
}

const { mode, opts } = parseArgs(argv.slice(2));
const apiKey = opts.apiKey ?? env.TYPESAFE_API_KEY ?? env.JEV_API_KEY;
const baseUrl = (opts.baseUrl ?? env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai').replace(/\/+$/, '');
const model = opts.model ?? env.TYPESAFE_MODEL ?? 'jev-latest';

if (!apiKey && !opts.dryRun) {
  console.error('missing API key: pass --key or set TYPESAFE_API_KEY (or pass --dry-run)');
  exit(2);
}
if (opts.cases) {
  opts.casesData = JSON.parse(await (await import('node:fs/promises')).readFile(opts.cases, 'utf8'));
}

try {
  if (mode !== 'eval') {
    console.error(`unknown mode: ${mode} (use eval)`);
    exit(2);
  }
  await runEval({ ...opts, apiKey, baseUrl, model });
} catch (error) {
  console.error(error.message);
  exit(1);
}
