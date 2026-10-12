#!/usr/bin/env node
/**
 * cerebellum-memory-eval — offline A/B evaluation of cerebellum (decision
 * model) memory re-ranking vs IDBots' current lexical ranker.
 *
 * What it does:
 *   For each test query, rank the candidate memory pool twice:
 *     A) lexical  — a faithful port of scoreEntryForPrompt
 *        (src/main/memory/memoryPromptBlocks.ts): 1 + 3 per whitespace/punct
 *        token (>=2 chars) of the query found as a substring of the memory,
 *        +6 for full-query containment.
 *     B) cerebellum — one POST {baseUrl}/v1/systemone per query carrying one
 *        Noul question per candidate memory (all evaluated in parallel against
 *        the same state; question instructions are in English per TypeSafe's
 *        English-primary guidance while the state stays Chinese).
 *   Then prints a side-by-side table with labeled hits, recall@5 aggregates,
 *   latency, token usage and an estimated cost.
 *
 * Usage:
 *   node scripts/cerebellum-memory-eval.mjs check
 *       Connectivity + auth check (GET /v1/models, then one tiny Noul call).
 *   node scripts/cerebellum-memory-eval.mjs eval
 *       Run the embedded Chinese sample dataset (default).
 *   node scripts/cerebellum-memory-eval.mjs eval --db <idbots.sqlite> [--metabot-id N]
 *       Rank real memories exported read-only from an IDBots database
 *       (user_memories WHERE status='created' AND archived_at IS NULL,
 *       ordered like the real candidate pool). Pair with --queries to score.
 *   node scripts/cerebellum-memory-eval.mjs eval --queries <queries.json>
 *       Custom queries: [{ "q": "...", "relevant": ["m1", "m7"] }]
 *
 * Options:
 *   --key <k>          API key (or TYPESAFE_API_KEY env)
 *   --base-url <url>   default https://api.typesafe.ai (or TYPESAFE_BASE_URL)
 *   --model <id>       default jev-latest
 *   --threshold <f>    noul selection threshold, default 0.5
 *   --max-memories <n> cap the candidate pool, default 100
 *   --verbose          dump raw API responses
 *
 * Privacy: whatever dataset you point this at IS sent to the configured
 * provider. The embedded sample contains no real user data; --db exports your
 * own memories — only use it against a provider you have opted into.
 *
 * Network note: api.typesafe.ai returns HTTP 451 (region-blocked) in some
 * regions. Node's global fetch does NOT follow the macOS system proxy; for
 * Node >= 24.5 set NODE_USE_ENV_PROXY=1 plus HTTPS_PROXY, e.g.:
 *   NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 \
 *     TYPESAFE_API_KEY=... node scripts/cerebellum-memory-eval.mjs eval
 * (Inside the Electron app, the main-process net stack follows the system
 * proxy automatically, so this only affects bare-Node runs like this script.)
 */

import { argv, env, exit } from 'node:process';

// ---------------------------------------------------------------------------
// Embedded sample dataset (Chinese, synthetic — mirrors IDBots owner-scope
// memory shapes: profile facts, preferences, dream lessons, operational prefs)
// ---------------------------------------------------------------------------

const SAMPLE_MEMORIES = [
  { id: 'm1', text: '主人用的主力开发机是 MacBook Pro M4，外接一台 4K 显示器' },
  { id: 'm2', text: '主人偏好简洁直接的回答，不喜欢长篇大论和客套话' },
  { id: 'm3', text: '主人的猫叫布丁，是一只三岁的布偶猫，肠胃比较敏感' },
  { id: 'm4', text: '主人在 MVC 链上发行过一个头像类数字藏品系列，总量 2100 个' },
  { id: 'm5', text: '主人不喜欢别人打探他的持仓和收益情况' },
  { id: 'm6', text: '每周一上午 9 点主人要和产品团队开周会，别安排别的定时任务' },
  { id: 'm7', text: '主人的 Twin Bot 叫「大管家」，主要负责派活给其他 Worker Bot' },
  { id: 'm8', text: '上次帮主人写周报时，他要求数据部分一律用表格呈现' },
  { id: 'm9', text: '主人的钱包主要用 SPACE 结算，MVC 只留少量做 gas' },
  { id: 'm10', text: '主人说过：任何要花币的操作都必须先报价、等他确认再执行' },
  { id: 'm11', text: '梦境复盘：上次未经确认就连发三条 buzz，主人明确表示不满' },
  { id: 'm12', text: '主人最近在研究把决策模型接进 IDBots 当「小脑」，重点关注记忆召回' },
  { id: 'm13', text: '主人的生日是 10 月 8 日，不喜欢过生日，别主动提' },
  { id: 'm14', text: '主人喝咖啡只喝手冲，家里有一台泰摩的磨豆机' },
  { id: 'm15', text: '主人英语读写没问题，但日常交流坚持只用中文' },
  { id: 'm16', text: '主人有两只手表，常戴的是一块卡西欧小方块' },
  { id: 'm17', text: '工作复盘：给主人整理 MetaWeb 搜索结果时，要先按主题聚类再给摘要' },
  { id: 'm18', text: '主人的服务器在旧金山机房，SSH 私钥存在 1Password 里' },
  { id: 'm19', text: '主人周末一般不看工作消息，紧急事情打电话' },
  { id: 'm20', text: '主人正在训练公路自行车，每周三晚上夜骑 40 公里' },
  { id: 'm21', text: '主人交代过：发往外群的消息一律先给他过目，不能自动发送' },
  { id: 'm22', text: '主人的移动硬盘是希捷 5T，所有 worktree 都放在那块盘上' },
  { id: 'm23', text: '主人对花生过敏，点外卖时必须检查配料表' },
  { id: 'm24', text: '上次主人问 Web3 钱包 gas 费，解释完他说太技术了，下次要打比方' },
];

const SAMPLE_QUERIES = [
  // Lexical-friendly baseline (shared tokens exist).
  { q: '帮我整理一下这周周报要用的数据', relevant: ['m8'] },
  // Synonym/paraphrase cases — the lexical ranker should miss these.
  { q: '我的苹果笔记本带得动这个模型吗', relevant: ['m1'] },
  { q: '以后回复能不能别那么啰嗦', relevant: ['m2'] },
  { q: '帮我给 Pudding 挑一款低敏猫粮', relevant: ['m3', 'm23'] },
  { q: '小脑那边的集成进展怎么样了', relevant: ['m12'] },
  { q: '今晚想出去骑车，帮我看下天气适不适合', relevant: ['m20'] },
  { q: '把上周的链上动态汇总一下发给我', relevant: ['m17'] },
  // Distractor-heavy: surface tokens overlap with irrelevant memories.
  { q: '最近数字藏品行情怎么样，帮我搜搜', relevant: [] },
  { q: '帮我发个 buzz 说今天的梦做完了', relevant: ['m11'] },
  { q: '周日晚上八点提醒我准备明天的东西', relevant: ['m19'] },
];

// ---------------------------------------------------------------------------
// Lexical baseline — faithful port of scoreEntryForPrompt/memoryPromptBlocks
// ---------------------------------------------------------------------------

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function tokenize(value) {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  return normalized.split(/[\s,，、|/\\;；:.!?]+/g).filter((t) => t.length >= 2);
}

function lexicalScore(memoryText, query) {
  const text = normalizeText(memoryText);
  if (!text) return 0;
  let score = 1;
  for (const token of tokenize(query)) {
    if (text.includes(token)) score += 3;
  }
  const q = normalizeText(query);
  if (q && text.includes(q)) score += 6;
  return score;
}

function lexicalTop(memories, query, k) {
  return memories
    .map((m) => ({ id: m.id, score: lexicalScore(m.text, query) }))
    .sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id))
    .slice(0, k);
}

// ---------------------------------------------------------------------------
// Cerebellum (TypeSafe JEV) client — plain fetch, no SDK
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

function buildEvalRequest(memories, query, model) {
  const questions = {};
  memories.forEach((m, i) => {
    questions[`mem_${i}`] = {
      type: 'noul',
      instructions:
        `Would the memory at \`memories[${i}].text\` be useful context for the assistant ` +
        `when replying to the user's current message at \`current_message\`? ` +
        'Useful means the memory contains a durable fact, preference, commitment, or prior ' +
        'instruction about the user that is relevant to this specific message — not merely ' +
        'shared keywords.',
      criteria: {
        true: 'Replying to the current message would be noticeably better with this memory in context.',
        false: 'This memory is unrelated to the current message, or only shares surface words.',
      },
    };
  });
  return {
    state: {
      current_message: query,
      memories: memories.map((m) => ({ id: m.id, text: m.text })),
    },
    model,
    questions,
  };
}

async function cerebellumRank({ baseUrl, apiKey, model, memories, query, verbose }) {
  const { data, latencyMs } = await postJson(
    `${baseUrl}/v1/systemone`,
    apiKey,
    buildEvalRequest(memories, query, model),
  );
  if (verbose) console.error(JSON.stringify(data, null, 2));
  const scores = memories.map((m, i) => ({
    id: m.id,
    noul: data.answers[`mem_${i}`]?.noul ?? 0,
  }));
  scores.sort((a, b) => b.noul - a.noul || a.id.localeCompare(b.id));
  return {
    scores,
    latencyMs,
    inputTokens: data.usage?.input_tokens ?? 0,
    answeredModel: data.model ?? model,
  };
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadMemoriesFromDb(dbPath, metabotId, maxMemories) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // Older databases predate the hygiene ALTER that adds archived_at.
    const columns = db.prepare('PRAGMA table_info(user_memories)').all().map((c) => c.name);
    const archivedClause = columns.includes('archived_at') ? ' AND archived_at IS NULL' : '';
    const where = metabotId == null
      ? `status = 'created'${archivedClause}`
      : `status = 'created'${archivedClause} AND metabot_id = ${Number(metabotId)}`;
    const rows = db.prepare(`
      SELECT id, text FROM user_memories
      WHERE ${where}
      ORDER BY COALESCE(last_used_at, updated_at) DESC
      LIMIT ${Number(maxMemories)}
    `).all();
    return rows.map((r) => ({ id: String(r.id), text: String(r.text) }));
  } finally {
    db.close();
  }
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

function fmtRow(rank, entry, memoriesById, labels, probField) {
  const hit = labels.includes(entry.id) ? '✓' : ' ';
  const text = (memoriesById.get(entry.id) ?? '').slice(0, 34);
  const val = probField != null ? entry[probField].toFixed(2) : String(entry.score);
  return `    ${hit} ${String(rank + 1)}. ${entry.id.padEnd(4)} ${val.padStart(5)}  ${text}`;
}

async function runEval(opts) {
  const { baseUrl, apiKey, model, threshold, maxMemories, verbose } = opts;
  let memories = SAMPLE_MEMORIES;
  let queries = SAMPLE_QUERIES;
  if (opts.db) {
    memories = await loadMemoriesFromDb(opts.db, opts.metabotId, maxMemories);
    console.log(`loaded ${memories.length} memories from ${opts.db}`);
    if (!opts.queries) queries = [];
  } else {
    memories = memories.slice(0, maxMemories);
  }
  if (opts.queries) {
    const loaded = JSON.parse(await (await import('node:fs/promises')).readFile(opts.queries, 'utf8'));
    queries = loaded.map((item) => ({ q: item.q, relevant: item.relevant ?? [] }));
  }
  if (queries.length === 0) {
    console.error('no queries to run (provide --queries with --db)');
    exit(2);
  }
  const memoriesById = new Map(memories.map((m) => [m.id, m.text]));
  const TOP_K = 5;

  console.log(`\nmodel=${model}  memories=${memories.length}  queries=${queries.length}  ` +
    `threshold=${threshold}  topK=${TOP_K}\n`);

  let lexHits = 0;
  let jevHits = 0;
  let labelTotal = 0;
  let totalLatency = 0;
  let totalInputTokens = 0;
  let answeredModel = model;

  for (const { q, relevant } of queries) {
    const labels = relevant.filter((id) => memoriesById.has(id));
    const lex = lexicalTop(memories, q, TOP_K);
    let jev;
    try {
      jev = await cerebellumRank({ baseUrl, apiKey, model, memories, query: q, verbose });
    } catch (error) {
      console.error(`  cerebellum call failed for "${q}": ${error.message}`);
      continue;
    }
    answeredModel = jev.answeredModel;
    totalLatency += jev.latencyMs;
    totalInputTokens += jev.inputTokens;

    const jevTop = jev.scores.slice(0, TOP_K);
    const jevSelected = jev.scores.filter((s) => s.noul >= threshold);
    lexHits += lex.filter((e) => labels.includes(e.id)).length;
    jevHits += jevTop.filter((e) => labels.includes(e.id)).length;
    labelTotal += labels.length;

    console.log(`Q: ${q}${labels.length ? `   (relevant: ${labels.join(', ')})` : ''}`);
    console.log('  lexical top5:');
    lex.forEach((e, i) => console.log(fmtRow(i, e, memoriesById, labels)));
    console.log(`  cerebellum top5:   [${jev.latencyMs}ms, ${jev.inputTokens} in-tokens]`);
    jevTop.forEach((e, i) => console.log(fmtRow(i, e, memoriesById, labels, 'noul')));
    console.log(`  cerebellum >=${threshold}: [${jevSelected.map((s) => `${s.id}:${s.noul.toFixed(2)}`).join(', ') || '(none)'}]`);
    console.log('');
  }

  console.log('—'.repeat(72));
  if (labelTotal > 0) {
    console.log(`recall@5 (labeled queries only):  lexical ${lexHits}/${labelTotal}` +
      `   cerebellum ${jevHits}/${labelTotal}`);
  }
  const costUsd = (totalInputTokens * 0.042) / 1e6;
  console.log(`answered model: ${answeredModel}`);
  console.log(`cerebellum total: ${totalLatency}ms, ${totalInputTokens} input tokens, ` +
    `≈ $${costUsd.toFixed(6)} ($0.042/Mtok input, output free)`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(args) {
  const opts = { threshold: 0.5, maxMemories: 100 };
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--verbose') opts.verbose = true;
    else if (arg === '--key') opts.apiKey = args[++i];
    else if (arg === '--base-url') opts.baseUrl = args[++i];
    else if (arg === '--model') opts.model = args[++i];
    else if (arg === '--threshold') opts.threshold = Number(args[++i]);
    else if (arg === '--max-memories') opts.maxMemories = Number(args[++i]);
    else if (arg === '--db') opts.db = args[++i];
    else if (arg === '--metabot-id') opts.metabotId = Number(args[++i]);
    else if (arg === '--queries') opts.queries = args[++i];
    else if (arg.startsWith('--')) { console.error(`unknown option: ${arg}`); exit(2); }
    else positional.push(arg);
  }
  return { mode: positional[0] ?? 'eval', opts };
}

const { mode, opts } = parseArgs(argv.slice(2));
const apiKey = opts.apiKey ?? env.TYPESAFE_API_KEY;
const baseUrl = (opts.baseUrl ?? env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai').replace(/\/+$/, '');
const model = opts.model ?? 'jev-latest';

if (!apiKey) {
  console.error('missing API key: pass --key or set TYPESAFE_API_KEY');
  exit(2);
}

const shared = { baseUrl, apiKey, model };
if (mode === 'check') {
  await runCheck(shared);
} else if (mode === 'eval') {
  await runEval({ ...shared, ...opts });
} else {
  console.error(`unknown mode: ${mode} (expected "check" or "eval")`);
  exit(2);
}
