#!/usr/bin/env node
/**
 * cerebellum-knowledge-hot-rank-eval — offline A/B of the knowledge hot layer.
 *
 * The production hot layer renders 8 points. Recency takes the newest 8
 * (array order here is newest-first, matching listKnowledge's
 * updated_at DESC). The cerebellum path is the same request the app sends:
 * one Noul per point via buildKnowledgeRankRequest / rankKnowledgeWithCerebellum,
 * then orderKnowledgeEntriesForPrompt, then the same 8-item cap.
 *
 * Metric: recall@8 — how many labeled points land inside that cap.
 * There is no probability cutoff in the product (the noul is a rank key).
 * The sweep below only reports how many labeled points scored at or above
 * each level, so a collapsed "everything is 0.9" run is visible.
 *
 * Usage:
 *   node scripts/cerebellum-knowledge-hot-rank-eval.mjs check
 *   node scripts/cerebellum-knowledge-hot-rank-eval.mjs eval
 *   node scripts/cerebellum-knowledge-hot-rank-eval.mjs eval --dry-run
 *   node scripts/cerebellum-knowledge-hot-rank-eval.mjs eval --entries e.json --queries q.json
 *
 * --entries: [{ id, topic, summary, kind }] newest-first.
 * --queries: [{ q, relevant: ["id"] }]
 *
 * Privacy: the embedded sample is synthetic. Custom files are sent as-is.
 *
 * Network: api.typesafe.ai can return HTTP 451 without a proxy. Node does
 * not follow the macOS system proxy; set NODE_USE_ENV_PROXY=1 and HTTPS_PROXY.
 * The free relay does not need that proxy. Pass --base-url and --key.
 */

import { argv, env, exit } from 'node:process';

import {
  buildKnowledgeRankRequest,
  rankKnowledgeWithCerebellum,
} from '../src/main/cerebellum/knowledgeHotRank.ts';

// Compiled: knowledgePromptBlocks.ts imports ./llmSafeText without an
// extension, which Node's type stripper cannot resolve. compile:electron
// first. The rank request itself still comes from the TS module above.
const { KNOWLEDGE_PROMPT_MAX_ITEMS, orderKnowledgeEntriesForPrompt } = await import(
  '../dist-electron/main/libs/knowledgePromptBlocks.js'
);

// Newest-first. k0–k7 are recent distractors (the recency hot layer).
// k8–k15 are older points the queries actually need.
const SAMPLE_ENTRIES = [
  { id: 'k0', kind: 'know_how', topic: '飞书通知格式', summary: '群通知标题用【IDBots】前缀，正文不超过三行。' },
  { id: 'k1', kind: 'know_how', topic: '周报表格', summary: '给主人写周报时，数据部分一律用表格，不要大段叙述。' },
  { id: 'k2', kind: 'know_how', topic: '布偶猫粮', summary: '布丁肠胃敏感，猫粮要选低敏、少谷物的。' },
  { id: 'k3', kind: 'principle', topic: '手冲咖啡', summary: '主人只喝手冲，不要推荐意式或即溶。' },
  { id: 'k4', kind: 'know_how', topic: '公路车胎压', summary: '夜骑前胎压保持在 80psi 左右，雨天再降 5。' },
  { id: 'k5', kind: 'know_how', topic: '显示器色温', summary: '外接 4K 显示器晚上把色温调到 4500K 以下。' },
  { id: 'k6', kind: 'principle', topic: '生日不提', summary: '主人不喜欢过生日，日期到了也不要主动祝贺。' },
  { id: 'k7', kind: 'pitfall', topic: '花生过敏', summary: '点外卖必须检查配料，花生及其酱料一律排除。' },
  { id: 'k8', kind: 'know_how', topic: 'MVC pin 费用估算', summary: '创建 pin 前按费率估算大约 600 vB 的 sats，余额不够要先告诉主人，不要直接发。' },
  { id: 'k9', kind: 'pitfall', topic: '知识热层只留最新几条', summary: '提示词里的知识点按更新时间取最新的一小撮，主题相关但较旧的点不会出现，不能假设它还在上下文里。' },
  { id: 'k10', kind: 'pitfall', topic: '群任务交付必须附 txid', summary: '群任务做完交付时必须带上链上 txid，没有 txid 的交付会被打回。' },
  { id: 'k11', kind: 'pitfall', topic: 'worktree 在希捷盘', summary: '新建 worktree 后如果 git status 把所有文件标成已修改，是 exFAT 没有权限位，要把 core.filemode 设成 false。' },
  { id: 'k12', kind: 'principle', topic: '小脑问题用英文', summary: '给小脑写判断题时指令用英文，用户的原文放在 state 里，不要把题目本身写成中文。' },
  { id: 'k13', kind: 'pitfall', topic: '免费小脑 401', summary: '免费 relay 的请求必须走带 key 重试的 fetch，直接用裸 session.fetch 会 401。' },
  { id: 'k14', kind: 'pitfall', topic: '记忆 last_used 只碰注入行', summary: 'last_used_at 只能更新真正写进提示词的记忆，不能把整池候选都刷新，否则衰减时钟失真。' },
  { id: 'k15', kind: 'know_how', topic: 'MetaWeb 换中文关键词', summary: 'MetaWeb 英文检索结果很弱时，要用中文关键词再搜一次，再判断库里没有。' },
];

const SAMPLE_QUERIES = [
  { q: '帮我估一下发这条 pin 大概要多少 sats', relevant: ['k8'] },
  { q: '为什么上次那个知识点没出现在这次提示词里', relevant: ['k9'] },
  { q: '群任务做完了，交付的时候要注意什么', relevant: ['k10'] },
  { q: '新建 worktree 之后 git status 怎么全是修改', relevant: ['k11'] },
  { q: '给小脑写一个新的判断题，中文指令行不行', relevant: ['k12'] },
  { q: '免费小脑接口返回 401 了', relevant: ['k13'] },
  { q: '记忆的 last_used 为什么整池都在刷新', relevant: ['k14'] },
  { q: 'MetaWeb 用英文搜教程什么都没有', relevant: ['k15'] },
  { q: '帮我把这周的周报数据整理一下', relevant: ['k1'] },
  { q: '布丁最近软便，猫粮要不要换', relevant: ['k2'] },
];

const SWEEP = [0.2, 0.35, 0.5, 0.65, 0.8];

function parseArgs(args) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--verbose') opts.verbose = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--key') opts.apiKey = args[++i];
    else if (arg === '--base-url') opts.baseUrl = args[++i];
    else if (arg === '--model') opts.model = args[++i];
    else if (arg === '--entries') opts.entries = args[++i];
    else if (arg === '--queries') opts.queries = args[++i];
    else if (arg.startsWith('--')) {
      console.error(`unknown option: ${arg}`);
      exit(2);
    } else positional.push(arg);
  }
  return { mode: positional[0] ?? 'eval', opts };
}

async function loadJsonFlag(flagValue) {
  if (!flagValue) return null;
  return JSON.parse(await (await import('node:fs/promises')).readFile(flagValue, 'utf8'));
}

async function runCheck({ baseUrl, apiKey, model }) {
  console.log(`GET ${baseUrl}/v1/models`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const res = await fetch(`${baseUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
  const body = await res.text();
  console.log(`  HTTP ${res.status}  ${body.slice(0, 400)}`);
  if (!res.ok) exit(1);
  const scores = await rankKnowledgeWithCerebellum({
    config: { provider: 'typesafe-jev', apiKey, baseUrl, model },
    fetchImpl: async (url, init) => {
      const response = await fetch(url, init);
      return { ok: response.ok, status: response.status, json: () => response.json() };
    },
    currentUserText: '测试：群任务交付要带 txid 吗',
    entries: SAMPLE_ENTRIES.slice(8, 11),
    timeoutMs: 15000,
  });
  console.log(`POST /v1/systemone  scores=${scores ? [...scores.entries()].map(([id, noul]) => `${id}:${noul}`).join(', ') : 'null'}`);
  if (!scores) exit(1);
  console.log('check: OK');
}

function topIds(entries, scores) {
  return orderKnowledgeEntriesForPrompt(entries, scores)
    .slice(0, KNOWLEDGE_PROMPT_MAX_ITEMS)
    .map((entry) => entry.id);
}

async function runEval(opts) {
  const { baseUrl, apiKey, model, verbose } = opts;
  const entries = opts.entriesData
    ? opts.entriesData.map((entry) => ({
      id: String(entry.id),
      topic: String(entry.topic ?? ''),
      summary: String(entry.summary ?? ''),
      kind: entry.kind,
    }))
    : SAMPLE_ENTRIES;
  const queries = opts.queriesData
    ? opts.queriesData.map((item) => ({ q: item.q, relevant: item.relevant ?? [] }))
    : SAMPLE_QUERIES;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const recencyTop = entries.slice(0, KNOWLEDGE_PROMPT_MAX_ITEMS).map((entry) => entry.id);

  if (opts.dryRun) {
    console.log(`dry-run: ${entries.length} knowledge points, ${queries.length} queries — no API calls made.\n`);
    entries.forEach((entry, index) => {
      const marker = index < KNOWLEDGE_PROMPT_MAX_ITEMS ? 'recency' : 'older  ';
      console.log(`  ${marker}  ${entry.id.padEnd(6)} [${entry.kind}] ${entry.topic}`);
    });
    console.log('');
    for (const { q, relevant } of queries) {
      console.log(`  Q: ${q}   (relevant: ${relevant.join(', ') || '(none)'})`);
    }
    console.log('\nfirst request body that would be sent:');
    console.log(JSON.stringify(buildKnowledgeRankRequest({
      currentUserText: queries[0]?.q ?? '',
      entries,
      model,
    }), null, 2));
    return;
  }

  console.log(`\nmodel=${model}  points=${entries.length}  queries=${queries.length}  hot=${KNOWLEDGE_PROMPT_MAX_ITEMS}\n`);

  let recencyHits = 0;
  let cerebellumHits = 0;
  let labelTotal = 0;
  let totalLatency = 0;
  let failures = 0;
  const labeledNouls = [];
  const otherNouls = [];

  for (const { q, relevant } of queries) {
    const labels = relevant.filter((id) => byId.has(id));
    const started = Date.now();
    let scores;
    try {
      scores = await rankKnowledgeWithCerebellum({
        config: { provider: 'typesafe-jev', apiKey, baseUrl, model },
        fetchImpl: async (url, init) => {
          const response = await fetch(url, init);
          return { ok: response.ok, status: response.status, json: () => response.json() };
        },
        currentUserText: q,
        entries,
        timeoutMs: 30000,
      });
    } catch (error) {
      failures += 1;
      console.error(`  rank call threw for "${q}": ${error.message}`);
      continue;
    }
    const latencyMs = Date.now() - started;
    if (!scores) {
      failures += 1;
      console.error(`  no verdict for "${q}"`);
      continue;
    }
    totalLatency += latencyMs;
    const ranked = topIds(entries, scores);
    const recencyHitIds = recencyTop.filter((id) => labels.includes(id));
    const cerebellumHitIds = ranked.filter((id) => labels.includes(id));
    recencyHits += recencyHitIds.length;
    cerebellumHits += cerebellumHitIds.length;
    labelTotal += labels.length;
    for (const entry of entries) {
      const noul = scores.get(entry.id);
      if (typeof noul !== 'number') continue;
      (labels.includes(entry.id) ? labeledNouls : otherNouls).push(noul);
    }

    console.log(`Q: ${q}   (relevant: ${labels.join(', ') || 'none'})  [${latencyMs}ms]`);
    console.log(`  recency@${KNOWLEDGE_PROMPT_MAX_ITEMS}:    ${recencyHitIds.join(', ') || '(miss)'}`);
    console.log(`  cerebellum@${KNOWLEDGE_PROMPT_MAX_ITEMS}: ${ranked.map((id) => {
      const noul = scores.get(id);
      const mark = labels.includes(id) ? '✓' : ' ';
      return `${mark}${id}:${typeof noul === 'number' ? noul.toFixed(2) : '-'}`;
    }).join('  ')}`);
    if (verbose) {
      console.log(`  full: ${[...scores.entries()].map(([id, noul]) => `${id}:${noul.toFixed(2)}`).join(' ')}`);
    }
    console.log('');
  }

  console.log('—'.repeat(72));
  if (labelTotal > 0) {
    console.log(`recall@${KNOWLEDGE_PROMPT_MAX_ITEMS}:  recency ${recencyHits}/${labelTotal}   cerebellum ${cerebellumHits}/${labelTotal}`);
  }
  if (failures > 0) console.log(`failures: ${failures}`);
  const summarize = (values) => {
    if (values.length === 0) return '(none)';
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted[Math.floor(sorted.length / 2)];
    return `n=${sorted.length} min=${sorted[0].toFixed(2)} med=${mid.toFixed(2)} max=${sorted[sorted.length - 1].toFixed(2)}`;
  };
  console.log(`labeled nouls: ${summarize(labeledNouls)}`);
  console.log(`other nouls:   ${summarize(otherNouls)}`);
  if (labeledNouls.length > 0) {
    console.log('labeled points at or above noul (calibration, not a product cutoff):');
    for (const threshold of SWEEP) {
      const kept = labeledNouls.filter((noul) => noul >= threshold).length;
      console.log(`  >=${threshold.toFixed(2)}  ${kept}/${labeledNouls.length}`);
    }
  }
  console.log(`rank total: ${totalLatency}ms across ${queries.length - failures} verdicts`);
  console.log('input-token cost is not on this client; the app log records latency only. Output tokens are free.');
}

const { mode, opts } = parseArgs(argv.slice(2));
const apiKey = opts.apiKey ?? env.TYPESAFE_API_KEY ?? env.JEV_API_KEY;
const baseUrl = (opts.baseUrl ?? env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai').replace(/\/+$/, '');
const model = opts.model ?? env.TYPESAFE_MODEL ?? 'jev-latest';

if (!apiKey && !opts.dryRun && mode !== 'eval') {
  console.error('missing API key: pass --key or set TYPESAFE_API_KEY');
  exit(2);
}
if (!apiKey && !opts.dryRun && mode === 'eval') {
  console.error('missing API key: pass --key or set TYPESAFE_API_KEY (or pass --dry-run)');
  exit(2);
}

try {
  opts.entriesData = await loadJsonFlag(opts.entries);
  opts.queriesData = await loadJsonFlag(opts.queries);
} catch (error) {
  console.error(`failed to load --entries/--queries: ${error.message}`);
  exit(2);
}

const shared = { baseUrl, apiKey, model };
try {
  if (mode === 'check') {
    await runCheck(shared);
  } else if (mode === 'eval') {
    await runEval({ ...shared, ...opts });
  } else {
    console.error(`unknown mode: ${mode} (use check | eval)`);
    exit(2);
  }
} catch (error) {
  console.error(error.message);
  exit(1);
}
