#!/usr/bin/env node
/**
 * cerebellum-remote-service-shortlist-eval — offline evaluation of the
 * cerebellum (decision model) remote-service shortlist: does the JEV Choice
 * ranking put the right on-chain service in the top-3 for real-shaped
 * Chinese requests?
 *
 * This is the tuning harness for
 * CEREBELLUM_REMOTE_SERVICE_RANK_INSTRUCTIONS /
 * CEREBELLUM_REMOTE_SERVICE_SHORTLIST_TOP_K in
 * src/main/cerebellum/remoteServiceShortlist.ts. The script imports the
 * module's own request builder and answer parser, so the question wording
 * cannot drift from what ships.
 *
 * What it does:
 *   For each labeled query, one POST {baseUrl}/v1/systemone carrying ONE
 *   Choice question whose `criteria` map holds every service
 *   (pin id -> "name: description") against a state with the user's message.
 *   Prints the ranked top-K per query with hit markers, then top-1 accuracy
 *   and recall@K.
 *
 * Usage:
 *   node scripts/cerebellum-remote-service-shortlist-eval.mjs check
 *       Connectivity + auth check (GET /v1/models, then one tiny Noul call).
 *   node scripts/cerebellum-remote-service-shortlist-eval.mjs eval
 *       Run the embedded roster + queries (default).
 *   node scripts/cerebellum-remote-service-shortlist-eval.mjs eval --roster <r.json> --queries <q.json>
 *       Custom roster [{ "id": "...", "name": "...", "description": "..." }]
 *       and queries [{ "q": "...", "relevant": ["service-id"] }].
 *
 * Options:
 *   --key <k>          API key (or TYPESAFE_API_KEY / JEV_API_KEY env)
 *   --base-url <url>   default https://api.typesafe.ai (or TYPESAFE_BASE_URL)
 *   --model <id>       default jev-latest
 *   --top-k <n>        recall cutoff, default 3 (module default)
 *   --dry-run          print the roster/queries and one full request body
 *                      WITHOUT any API call (preview what leaves this machine)
 *   --verbose          dump raw API responses
 *
 * Privacy: whatever roster you point this at IS sent to the configured
 * provider. The embedded sample is synthetic; a real exported roster means
 * the discovered on-chain service names/descriptions leave this machine —
 * only use a provider you have opted into.
 *
 * Network note: api.typesafe.ai returns HTTP 451 (region-blocked) in some
 * regions. Node's global fetch does NOT follow the macOS system proxy; for
 * Node >= 24.5 set NODE_USE_ENV_PROXY=1 plus HTTPS_PROXY, e.g.:
 *   NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 \
 *     TYPESAFE_API_KEY=... node scripts/cerebellum-remote-service-shortlist-eval.mjs eval
 * (Inside the Electron app, the main-process net stack follows the system
 * proxy automatically, so this only affects bare-Node runs like this script.)
 */

import { argv, env, exit } from 'node:process';

import {
  CEREBELLUM_REMOTE_SERVICE_SHORTLIST_TOP_K,
  CEREBELLUM_REMOTE_SERVICE_RANK_QUESTION_ID,
  buildRemoteServiceShortlistRequest,
  parseRemoteServiceShortlistAnswers,
} from '../src/main/cerebellum/remoteServiceShortlist.ts';

// ---------------------------------------------------------------------------
// Embedded sample roster (synthetic, Gig-Square-flavored: 16 on-chain
// services, zh + en descriptions) and labeled queries. Distractor services
// deliberately share surface keywords with some queries.
// ---------------------------------------------------------------------------

const SAMPLE_ROSTER = [
  { id: 'svc-weather-i0', name: 'Weather Query', description: '查询指定城市实时天气与未来三天预报，支持生活指数。' },
  { id: 'svc-translate-i0', name: 'Pro Translation', description: '专业文档翻译：术语表、双语对照、语气保持，支持 30+ 语种。' },
  { id: 'svc-image-gen-i0', name: 'Image Gen', description: 'Text-to-image generation: posters, illustrations, avatars, style variants.' },
  { id: 'svc-image-edit-i0', name: 'Image Edit', description: '图片处理：局部重绘、抠图去背景、分辨率放大、老照片修复。' },
  { id: 'svc-ocr-i0', name: 'OCR Extract', description: '图片文字识别：印刷体与手写体，表格结构还原，多语种。' },
  { id: 'svc-contract-audit-i0', name: 'Contract Audit', description: '智能合约安全审计：重入、溢出、权限漏洞，输出修复建议。' },
  { id: 'svc-chain-data-i0', name: 'Chain Data', description: 'MVC 链上数据检索：地址余额、交易历史、pin 内容解析。' },
  { id: 'svc-news-digest-i0', name: 'News Digest', description: '新闻摘要服务：按主题聚类、重要性排序、每日推送。' },
  { id: 'svc-market-pulse-i0', name: 'Market Pulse', description: '数字资产行情速览：价格、涨跌幅、资金流与热点事件。' },
  { id: 'svc-resume-i0', name: 'Resume Polish', description: '简历优化：经历量化、岗位匹配度分析、中英文双版本。' },
  { id: 'svc-meeting-notes-i0', name: 'Meeting Notes', description: '会议纪要生成：要点、待办、责任人提取，支持录音转写输入。' },
  { id: 'svc-tts-i0', name: 'TTS Voice', description: '文字转语音：多音色、多语种、语速与情绪调节。' },
  { id: 'svc-video-cut-i0', name: 'Video Cut', description: '视频剪辑：切片、拼接、字幕烧录与转场特效。' },
  { id: 'svc-web-search-i0', name: 'Web Search', description: '全网检索与来源引用：新闻、资料、技术文档摘要。' },
  { id: 'svc-data-viz-i0', name: 'Data Viz', description: '数据可视化：图表选型、静态图输出、看板布局建议。' },
  { id: 'svc-schedule-i0', name: 'Schedule Butler', description: '日程与提醒：定时任务创建、周期事项、到期通知。' },
];

const SAMPLE_QUERIES = [
  { q: '上海明天会下雨吗？适合跑步吗', relevant: ['svc-weather-i0'] },
  { q: '把这份英文合同翻译成中文，术语要准确', relevant: ['svc-translate-i0'] },
  { q: '帮我画一张赛博朋克风格的头像', relevant: ['svc-image-gen-i0'] },
  { q: '这张老照片糊了，帮我修复放大一下', relevant: ['svc-image-edit-i0'] },
  { q: '图片里的表格数据帮我提取出来', relevant: ['svc-ocr-i0'] },
  { q: '帮我看看这个智能合约有没有重入漏洞', relevant: ['svc-contract-audit-i0'] },
  { q: '查一下这个地址最近的链上交易记录', relevant: ['svc-chain-data-i0'] },
  { q: '最近区块链行业有什么大新闻', relevant: ['svc-news-digest-i0', 'svc-web-search-i0'] },
  { q: 'BTC 今天涨跌怎么样', relevant: ['svc-market-pulse-i0'] },
  { q: '下周要面试了，帮我改改简历', relevant: ['svc-resume-i0'] },
  { q: '这段会议录音帮我整理成纪要', relevant: ['svc-meeting-notes-i0'] },
  { q: '把这篇文章读出来做成音频', relevant: ['svc-tts-i0'] },
];

// ---------------------------------------------------------------------------
// Client — plain fetch, no SDK (request/parse come from the shipped module)
// ---------------------------------------------------------------------------

async function postJson(url, apiKey, body, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    const latencyMs = Math.round(performance.now() - started);
    if (!res.ok) {
      const hint = res.status === 451
        ? ' (region-blocked: set NODE_USE_ENV_PROXY=1 and HTTPS_PROXY to route through a proxy)'
        : '';
      const err = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}${hint}`);
      err.status = res.status;
      err.latencyMs = latencyMs;
      throw err;
    }
    return { data: JSON.parse(text), latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

async function rankServices({ baseUrl, apiKey, model, userText, services, verbose }) {
  const { data, latencyMs } = await postJson(
    `${baseUrl}/v1/systemone`,
    apiKey,
    buildRemoteServiceShortlistRequest({ currentUserText: userText, services, model }),
  );
  if (verbose) console.error(JSON.stringify(data, null, 2));
  const entries = parseRemoteServiceShortlistAnswers(data, services) ?? [];
  return {
    entries,
    latencyMs,
    inputTokens: data.usage?.input_tokens ?? 0,
    answeredModel: data.model ?? model,
  };
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

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

  const { data, latencyMs } = await postJson(`${baseUrl}/v1/systemone`, apiKey, {
    state: '测试消息：主人说明天想吃火锅。',
    model,
    questions: {
      mentions_food: { type: 'noul', instructions: 'Does the message at `state` mention food?' },
    },
  });
  console.log(`POST /v1/systemone OK — model=${data.model} latency=${latencyMs}ms ` +
    `input_tokens=${data.usage?.input_tokens} noul=${data.answers?.mentions_food?.noul}`);
  console.log('check: OK');
}

async function loadJsonFlag(flagValue) {
  if (!flagValue) return null;
  return JSON.parse(await (await import('node:fs/promises')).readFile(flagValue, 'utf8'));
}

async function runEval(opts) {
  const { baseUrl, apiKey, model, topK, verbose } = opts;
  const roster = opts.rosterData
    ? opts.rosterData.map((s) => ({ id: String(s.id), name: String(s.name ?? s.id), description: String(s.description ?? '') }))
    : SAMPLE_ROSTER;
  const queries = opts.queriesData
    ? opts.queriesData.map((item) => ({ q: item.q, relevant: item.relevant ?? [] }))
    : SAMPLE_QUERIES;
  const rosterById = new Map(roster.map((s) => [s.id, s]));

  if (opts.dryRun) {
    console.log(`dry-run: ${roster.length} services, ${queries.length} queries — no API calls made.\n`);
    for (const s of roster) {
      console.log(`  ${s.id.padEnd(26)} ${s.description.slice(0, 52)}`);
    }
    console.log('');
    for (const { q, relevant } of queries) {
      console.log(`  Q: ${q}   (relevant: ${relevant.join(', ') || '(none)'})`);
    }
    console.log('\nfirst request body that would be sent:');
    console.log(JSON.stringify(buildRemoteServiceShortlistRequest({
      currentUserText: queries[0].q,
      services: roster,
      model,
    }), null, 2));
    return;
  }

  console.log(`\nmodel=${model}  services=${roster.length}  queries=${queries.length}  topK=${topK}\n`);

  let top1Hits = 0;
  let topKHits = 0;
  let labeled = 0;
  let totalLatency = 0;
  let totalInputTokens = 0;
  let answeredModel = model;
  let failures = 0;

  for (const { q, relevant } of queries) {
    let ranked;
    try {
      ranked = await rankServices({ baseUrl, apiKey, model, userText: q, services: roster, verbose });
    } catch (error) {
      failures += 1;
      console.error(`  rank call failed for "${q}": ${error.message}`);
      continue;
    }
    answeredModel = ranked.answeredModel;
    totalLatency += ranked.latencyMs;
    totalInputTokens += ranked.inputTokens;

    const labels = relevant.filter((id) => rosterById.has(id));
    const top = ranked.entries.slice(0, topK);
    const top1 = top[0];
    const top1Hit = top1 && labels.includes(top1.id);
    const topKHit = top.some((entry) => labels.includes(entry.id));
    if (labels.length > 0) {
      labeled += 1;
      if (top1Hit) top1Hits += 1;
      if (topKHit) topKHits += 1;
    }

    console.log(`Q: ${q}   (relevant: ${labels.join(', ') || 'none'})`);
    console.log(`  ranked top${topK}:   [${ranked.latencyMs}ms, ${ranked.inputTokens} in-tokens]`);
    top.forEach((entry, index) => {
      const mark = labels.includes(entry.id) ? '✓' : ' ';
      const text = (rosterById.get(entry.id)?.description ?? '').slice(0, 40);
      console.log(`    ${mark} ${index + 1}. ${entry.id.padEnd(24)} ${entry.probability.toFixed(2)}  ${text}`);
    });
    if (!top1Hit) {
      console.log(`    ✗ suggested ${top1 ? top1.id : '(none)'} — labeled ${labels[0] ?? 'none'}`);
    }
    console.log('');
  }

  if (failures > 0) {
    console.error(`\n${failures} rank call(s) failed — results below are partial.`);
  }

  console.log('—'.repeat(72));
  if (labeled > 0) {
    console.log(`top-1 accuracy: ${top1Hits}/${labeled}   recall@${topK}: ${topKHits}/${labeled}`);
  }
  const costUsd = (totalInputTokens * 0.042) / 1e6;
  console.log(`answered model: ${answeredModel}`);
  console.log(`rank total: ${totalLatency}ms, ${totalInputTokens} input tokens, ` +
    `≈ $${costUsd.toFixed(6)} ($0.042/Mtok input, output free)`);
  if (labeled > 0 && topKHits < labeled) {
    console.log('\nWARNING: some labeled services missed the top-K — the shortlist would not surface them. ' +
      'Reword CEREBELLUM_REMOTE_SERVICE_RANK_INSTRUCTIONS or raise TOP_K before enabling.');
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(args) {
  const opts = { topK: CEREBELLUM_REMOTE_SERVICE_SHORTLIST_TOP_K };
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--verbose') opts.verbose = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--key') opts.apiKey = args[++i];
    else if (arg === '--base-url') opts.baseUrl = args[++i];
    else if (arg === '--model') opts.model = args[++i];
    else if (arg === '--top-k') opts.topK = Number(args[++i]);
    else if (arg === '--roster') opts.roster = args[++i];
    else if (arg === '--queries') opts.queries = args[++i];
    else if (arg.startsWith('--')) { console.error(`unknown option: ${arg}`); exit(2); }
    else positional.push(arg);
  }
  return { mode: positional[0] ?? 'eval', opts };
}

const { mode, opts } = parseArgs(argv.slice(2));
const apiKey = opts.apiKey ?? env.TYPESAFE_API_KEY ?? env.JEV_API_KEY;
const baseUrl = (opts.baseUrl ?? env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai').replace(/\/+$/, '');
const model = opts.model ?? 'jev-latest';

if (!apiKey && !opts.dryRun) {
  console.error('missing API key: pass --key or set TYPESAFE_API_KEY / JEV_API_KEY');
  exit(2);
}

try {
  opts.rosterData = await loadJsonFlag(opts.roster);
  opts.queriesData = await loadJsonFlag(opts.queries);
} catch (error) {
  console.error(`failed to load --roster/--queries: ${error.message}`);
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
