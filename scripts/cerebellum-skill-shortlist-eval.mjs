#!/usr/bin/env node
/**
 * cerebellum-skill-shortlist-eval — offline evaluation of the cerebellum
 * (decision model) skill shortlist: does the JEV Choice ranking put the
 * right skill in the top-3 for real-shaped Chinese requests?
 *
 * This is the tuning harness for CEREBELLUM_SKILL_RANK_INSTRUCTIONS /
 * CEREBELLUM_SKILL_SHORTLIST_TOP_K in src/main/cerebellum/skillShortlist.ts.
 * The request builder below is a faithful copy of that module — keep the two
 * in sync when tuning.
 *
 * What it does:
 *   For each labeled query, one POST {baseUrl}/v1/systemone carrying ONE
 *   Choice question whose `criteria` map holds every skill (id -> "name:
 *   description") against a state with the user's message. Prints the ranked
 *   top-K per query with hit markers, then top-1 accuracy and recall@K.
 *
 * Usage:
 *   node scripts/cerebellum-skill-shortlist-eval.mjs check
 *       Connectivity + auth check (GET /v1/models, then one tiny Noul call).
 *   node scripts/cerebellum-skill-shortlist-eval.mjs eval
 *       Run the embedded roster + queries (default).
 *   node scripts/cerebellum-skill-shortlist-eval.mjs eval --roster <r.json> --queries <q.json>
 *       Custom roster [{ "id": "...", "name": "...", "description": "..." }]
 *       and queries [{ "q": "...", "relevant": ["skill-id"] }].
 *
 * Options:
 *   --key <k>          API key (or TYPESAFE_API_KEY env)
 *   --base-url <url>   default https://api.typesafe.ai (or TYPESAFE_BASE_URL)
 *   --model <id>       default jev-latest
 *   --top-k <n>        recall cutoff, default 3 (module default)
 *   --dry-run          print the roster/queries and one full request body
 *                      WITHOUT any API call (preview what leaves this machine)
 *   --verbose          dump raw API responses
 *
 * Privacy: whatever roster you point this at IS sent to the configured
 * provider. The embedded sample is synthetic; a real exported roster means
 * your installed skill names/descriptions leave this machine — only use a
 * provider you have opted into.
 *
 * Network note: api.typesafe.ai returns HTTP 451 (region-blocked) in some
 * regions. Node's global fetch does NOT follow the macOS system proxy; for
 * Node >= 24.5 set NODE_USE_ENV_PROXY=1 plus HTTPS_PROXY, e.g.:
 *   NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 \
 *     TYPESAFE_API_KEY=... node scripts/cerebellum-skill-shortlist-eval.mjs eval
 * (Inside the Electron app, the main-process net stack follows the system
 * proxy automatically, so this only affects bare-Node runs like this script.)
 */

import { argv, env, exit } from 'node:process';

// ---------------------------------------------------------------------------
// Embedded sample roster (synthetic, IDBots-flavored: 48 skills, zh + en
// descriptions) and labeled queries. Distractor skills deliberately share
// surface keywords with some queries.
// ---------------------------------------------------------------------------

const SAMPLE_ROSTER = [
  { id: 'web-search', name: 'web-search', description: 'Search the public web for fresh information and summarize the results with sources.' },
  { id: 'ppt-maker', name: 'ppt-maker', description: '生成演示文稿幻灯片：主题大纲、图表、排版与讲稿。' },
  { id: 'docx-writer', name: 'docx-writer', description: '撰写并导出 Word 文档：报告、方案、长文排版。' },
  { id: 'xlsx-analyst', name: 'xlsx-analyst', description: '创建和分析 Excel 表格：公式、透视、数据清洗。' },
  { id: 'pdf-toolkit', name: 'pdf-toolkit', description: 'PDF 读取、拆分合并、页码目录与格式转换。' },
  { id: 'image-gen', name: 'image-gen', description: 'Text-to-image generation: posters, illustrations, avatars, style variants.' },
  { id: 'image-edit', name: 'image-edit', description: '局部重绘、抠图去背景、分辨率放大与色调调整。' },
  { id: 'logo-design', name: 'logo-design', description: '品牌 Logo 与 IP 形象设计，含配色与多尺寸导出。' },
  { id: 'video-cut', name: 'video-cut', description: '视频剪辑：切片、拼接、字幕烧录与转场。' },
  { id: 'video-summary', name: 'video-summary', description: '长视频内容摘要与章节时间轴提取。' },
  { id: 'music-gen', name: 'music-gen', description: 'AI 作曲与编曲：主题旋律、BGM、多乐器轨。' },
  { id: 'tts-voice', name: 'tts-voice', description: '文字转语音：多音色、多语种、语速情绪调节。' },
  { id: 'stt-transcribe', name: 'stt-transcribe', description: '音频/视频转文字稿，支持说话人分离与时间戳。' },
  { id: 'translate-pro', name: 'translate-pro', description: '专业文档翻译：术语表、双语对照、语气保持。' },
  { id: 'code-review', name: 'code-review', description: '代码审查：缺陷、安全风险、性能与可读性建议。' },
  { id: 'code-gen', name: 'code-gen', description: '按需求生成代码脚手架与单元测试。' },
  { id: 'regex-forge', name: 'regex-forge', description: '构造与解释正则表达式，含测试用例生成。' },
  { id: 'sql-helper', name: 'sql-helper', description: 'SQL 编写与优化：查询计划、索引建议。' },
  { id: 'api-doc', name: 'api-doc', description: '从代码或 OpenAPI 规范生成接口文档。' },
  { id: 'wallet-manage', name: 'wallet-manage', description: '链上钱包管理：余额查询、转账、费率估算。' },
  { id: 'mvc-pin', name: 'mvc-pin', description: '在 MVC 链上写入数据：上链存证、内容固定 pin。' },
  { id: 'nft-mint', name: 'nft-mint', description: '数字藏品铸造：元数据、发行计划与白名单。' },
  { id: 'chain-scan', name: 'chain-scan', description: '区块链浏览器检索：地址、交易、合约事件追踪。' },
  { id: 'contract-audit', name: 'contract-audit', description: '智能合约安全审计：重入、溢出、权限漏洞。' },
  { id: 'metaweb-reader', name: 'metaweb-reader', description: '阅读 MetaWeb 链上文章与 pin 内容并结构化摘要。' },
  { id: 'metaweb-search', name: 'metaweb-search', description: 'MetaWeb 链上内容检索：按主题、作者、pinId 过滤。' },
  { id: 'buzz-post', name: 'buzz-post', description: '撰写并发布 simplebuzz 动态，支持附件与引用。' },
  { id: 'wiki-build', name: 'wiki-build', description: '创建与维护链上 wiki 条目，自动内链相关主题。' },
  { id: 'knowledge-base', name: 'knowledge-base', description: '本地知识库：文档入库、向量检索、引用回答。' },
  { id: 'memory-curator', name: 'memory-curator', description: '整理长期记忆：去重、归并、过期清理建议。' },
  { id: 'schedule-butler', name: 'schedule-butler', description: '日程与提醒：定时任务、周期事项、到期通知。' },
  { id: 'email-draft', name: 'email-draft', description: '邮件撰写与回复建议：语气、称呼、跟进链。' },
  { id: 'meeting-notes', name: 'meeting-notes', description: '会议纪要：要点、待办、责任人提取。' },
  { id: 'data-viz', name: 'data-viz', description: '数据可视化：图表选型、交互式看板生成。' },
  { id: 'report-weekly', name: 'report-weekly', description: '周报生成：进展汇总、风险提示、下周计划。' },
  { id: 'market-pulse', name: 'market-pulse', description: '行情速览：数字资产价格、涨跌与热点事件。' },
  { id: 'news-digest', name: 'news-digest', description: '新闻摘要：按主题聚类、重要性排序。' },
  { id: 'paper-reading', name: 'paper-reading', description: '论文精读：方法、实验、局限与延伸工作梳理。' },
  { id: 'patent-search', name: 'patent-search', description: '专利检索与分析：同族、引证、技术图谱。' },
  { id: 'resume-polish', name: 'resume-polish', description: '简历优化：经历量化、岗位匹配度分析。' },
  { id: 'interview-coach', name: 'interview-coach', description: '模拟面试：技术/行为问题、评分与改进建议。' },
  { id: 'ppt-theme', name: 'ppt-theme', description: '演示主题模板与母版设计，统一视觉风格。' },
  { id: 'ocr-extract', name: 'ocr-extract', description: '图片文字识别：表格还原、手写体、多语种。' },
  { id: 'screenshot-annotate', name: 'screenshot-annotate', description: '截图标注：框选、序号、步骤说明生成。' },
  { id: 'browser-agent', name: 'browser-agent', description: '浏览器自动化操作：网页填写、数据抓取、流程回放。' },
  { id: 'file-organize', name: 'file-organize', description: '本地文件整理：按规则重命名、归类、去重。' },
  { id: 'backup-plan', name: 'backup-plan', description: '备份策略制定与脚本：增量、异地、恢复演练。' },
  { id: 'iot-monitor', name: 'iot-monitor', description: '设备监控告警：温度、在线状态、阈值通知。' },
];

const SAMPLE_QUERIES = [
  { q: '帮我把这份调研整理成一份给投资人看的演示文稿', relevant: ['ppt-maker'] },
  { q: '查一下最近一周关于 MVC 链生态的新闻', relevant: ['news-digest', 'web-search'] },
  { q: '把这段会议录音整理成纪要，标出待办', relevant: ['stt-transcribe', 'meeting-notes'] },
  { q: '我想给我们的咖啡品牌设计一个 Logo', relevant: ['logo-design'] },
  { q: '这张截图里的表格帮我转成 Excel', relevant: ['ocr-extract', 'xlsx-analyst'] },
  { q: '帮我审一下这个智能合约有没有安全漏洞', relevant: ['contract-audit', 'code-review'] },
  { q: '明天早上九点提醒我吃药，以后每天都要', relevant: ['schedule-butler'] },
  { q: '把这篇文章翻译成英文，术语要跟行业惯例一致', relevant: ['translate-pro'] },
  { q: '在链上把这份哈希存证固定下来', relevant: ['mvc-pin'] },
  { q: '帮我搜一下 MetaWeb 上关于 Agent 协作的文章', relevant: ['metaweb-search'] },
  { q: '老照片修复一下，顺便把分辨率提高', relevant: ['image-edit'] },
  { q: '给这周的进展写一份周报', relevant: ['report-weekly'] },
];

// ---------------------------------------------------------------------------
// Request builder — faithful copy of src/main/cerebellum/skillShortlist.ts
// (keep in sync when tuning the module wording)
// ---------------------------------------------------------------------------

const QUESTION_ID = 'best_skill';
const OPTION_MAX_DESCRIPTION_CHARS = 320;

const INSTRUCTIONS =
  'Which ONE skill listed in `criteria` is the best match for handling the user\'s request at '
  + '`user_message`? Judge by the capability and trigger conditions each option describes — not by '
  + 'shared keywords or name similarity. The user may write in any language. If no skill truly '
  + 'fits, still pick the closest one: only the ranking order is used downstream.';

function buildGateRequest({ userText, skills, model }) {
  const criteria = {};
  for (const skill of skills) {
    const description = String(skill.description ?? '').replace(/\s+/g, ' ').trim()
      .slice(0, OPTION_MAX_DESCRIPTION_CHARS);
    criteria[String(skill.id)] = description ? `${skill.name}: ${description}` : skill.name;
  }
  return {
    state: { user_message: String(userText ?? '').replace(/\s+/g, ' ').trim() },
    model,
    questions: {
      [QUESTION_ID]: { type: 'choice', instructions: INSTRUCTIONS, criteria },
    },
  };
}

// ---------------------------------------------------------------------------
// Client — plain fetch, no SDK
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

async function rankSkills({ baseUrl, apiKey, model, userText, skills, verbose }) {
  const { data, latencyMs } = await postJson(
    `${baseUrl}/v1/systemone`,
    apiKey,
    buildGateRequest({ userText, skills, model }),
  );
  if (verbose) console.error(JSON.stringify(data, null, 2));
  const answer = data.answers?.[QUESTION_ID] ?? {};
  const known = new Set(skills.map((s) => String(s.id)));
  const entries = Object.entries(answer.probabilities ?? {})
    .filter(([id, value]) => known.has(id) && typeof value === 'number' && Number.isFinite(value))
    .map(([id, value]) => ({ id, probability: Math.max(0, Math.min(1, value)) }))
    .sort((a, b) => b.probability - a.probability || a.id.localeCompare(b.id));
  if (entries.length === 0 && typeof answer.choice === 'string' && known.has(answer.choice)) {
    entries.push({ id: answer.choice, probability: 1 });
  }
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
    console.log(`dry-run: ${roster.length} skills, ${queries.length} queries — no API calls made.\n`);
    for (const s of roster) {
      console.log(`  ${s.id.padEnd(22)} ${s.description.slice(0, 56)}`);
    }
    console.log('');
    for (const { q, relevant } of queries) {
      console.log(`  Q: ${q}   (relevant: ${relevant.join(', ') || '(none)'})`);
    }
    console.log('\nfirst request body that would be sent:');
    console.log(JSON.stringify(buildGateRequest({ userText: queries[0].q, skills: roster, model }), null, 2));
    return;
  }

  console.log(`\nmodel=${model}  skills=${roster.length}  queries=${queries.length}  topK=${topK}\n`);

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
      ranked = await rankSkills({ baseUrl, apiKey, model, userText: q, skills: roster, verbose });
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
      console.log(`    ${mark} ${index + 1}. ${entry.id.padEnd(20)} ${entry.probability.toFixed(2)}  ${text}`);
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
    console.log('\nWARNING: some labeled skills missed the top-K — the shortlist would not surface them. ' +
      'Reword CEREBELLUM_SKILL_RANK_INSTRUCTIONS or raise TOP_K before enabling.');
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(args) {
  const opts = { topK: 3 };
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
const apiKey = opts.apiKey ?? env.TYPESAFE_API_KEY;
const baseUrl = (opts.baseUrl ?? env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai').replace(/\/+$/, '');
const model = opts.model ?? 'jev-latest';

if (!apiKey && !opts.dryRun) {
  console.error('missing API key: pass --key or set TYPESAFE_API_KEY');
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
