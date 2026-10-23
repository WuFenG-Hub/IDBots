#!/usr/bin/env node
/**
 * cerebellum-volatile-gate-eval — offline evaluation of the cerebellum
 * (decision model) volatile block gate: do the per-block "does this turn
 * need block X?" Nouls agree with human labels on real-shaped Chinese turns?
 *
 * This is the tuning harness for CEREBELLUM_VOLATILE_GATE_THRESHOLDS in
 * src/main/cerebellum/volatileBlockGate.ts. The question builder below is a
 * faithful copy of that module — keep the two in sync when tuning.
 *
 * What it does:
 *   For each labeled turn, one POST {baseUrl}/v1/systemone carrying FIVE
 *   Noul questions (experience / twin-impression / knowledge-bases /
 *   remote-services / team-culture) against one shared state (the user
 *   message). Verdicts
 *   at the module thresholds are compared with labels and a per-block
 *   confusion matrix is printed:
 *     keep-and-needed (TP)   skip-and-unneeded (TN = tokens saved)
 *     keep-but-unneeded (FP = tokens wasted, status-quo cost)
 *     skip-but-needed   (FN = LOST CONTEXT — the dangerous error)
 *   plus a threshold sweep.
 *
 * Usage:
 *   node scripts/cerebellum-volatile-gate-eval.mjs check
 *   node scripts/cerebellum-volatile-gate-eval.mjs eval
 *   node scripts/cerebellum-volatile-gate-eval.mjs eval --cases <cases.json>
 *       Custom cases: [{ "user": "...", "needs": ["knowledge-bases", "..."] }]
 *
 * Options:
 *   --key <k>          API key (or TYPESAFE_API_KEY env)
 *   --base-url <url>   default https://api.typesafe.ai (or TYPESAFE_BASE_URL)
 *   --model <id>       default jev-latest
 *   --dry-run          print the dataset and the full request body WITHOUT
 *                      any API call (preview exactly what leaves this machine)
 *   --verbose          dump raw API responses
 *
 * Privacy: whatever dataset you point this at IS sent to the configured
 * provider (the user message only — block content never leaves). The
 * embedded sample is synthetic; real turns mean those turns leave this
 * machine. Only use a provider you have opted into.
 *
 * Network note: api.typesafe.ai returns HTTP 451 (region-blocked) in some
 * regions. Node's global fetch does NOT follow the macOS system proxy; for
 * Node >= 24.5 set NODE_USE_ENV_PROXY=1 plus HTTPS_PROXY, e.g.:
 *   NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 \
 *     TYPESAFE_API_KEY=... node scripts/cerebellum-volatile-gate-eval.mjs eval
 */

import { argv, env, exit } from 'node:process';

// ---------------------------------------------------------------------------
// Embedded sample dataset (synthetic Chinese turns; label = which gateable
// blocks a good assistant would actually consult for this turn)
// ---------------------------------------------------------------------------

// Review Minor 6: 'team-culture' joined the gateable blocks — the embedded
// copy must carry it like the module does.
const BLOCK_KEYS = ['experience', 'twin-impression', 'knowledge-bases', 'remote-services', 'team-culture'];

const SAMPLE_CASES = [
  // --- none needed: plain tasks / chat ---
  { user: '帮我重构这个函数，把命名改成驼峰', needs: [] },
  { user: '今天杭州天气怎么样？', needs: [] },
  { user: '把这段话翻译成英文：本项目专注于链上身份。', needs: [] },
  { user: '嗯嗯，明白了，就按这个方案来', needs: [] },
  { user: '给我一个快速排序的 Python 实现', needs: [] },
  // --- knowledge-bases only ---
  { user: '查一下我的知识库里关于 MVC 协议的笔记', needs: ['knowledge-bases'] },
  { user: '把这篇文章存进你的知识库，之后我要引用它', needs: ['knowledge-bases'] },
  // --- remote-services only ---
  { user: '有没有别的 Bot 提供视频生成的服务？帮我对比下价格', needs: ['remote-services'] },
  { user: '帮我找一个能做智能合约审计的外部服务，价格合适的', needs: ['remote-services'] },
  // --- experience only ---
  { user: '你最近从梦境复盘里学到了什么？', needs: ['experience'] },
  { user: '介绍一下你自己，你的性格和做事原则是什么', needs: ['experience'] },
  { user: '上次你连发 buzz 被我批了，还记得吗？以后怎么避免', needs: ['experience'] },
  // --- twin-impression only ---
  { user: '这个活派给哪个 Worker Bot 比较合适？说说你对他们的了解', needs: ['twin-impression'] },
  { user: '「大管家」最近的表现怎么样，活干得靠谱吗', needs: ['twin-impression'] },
  // --- mixed ---
  { user: '结合你梦境里的复盘，总结这周哪些任务可以派给 Worker 们', needs: ['experience', 'twin-impression'] },
  // Note: "跟外部服务方谈价格" is a negotiation scenario, not service discovery.
  { user: '查下知识库里存的谈判技巧，看看跟外部服务方谈价格时能不能用上', needs: ['knowledge-bases'] },
  // Note: "你对我的了解" is user memories (ungated), not the assistant's
  // self-identity/dream reflections the experience block carries.
  { user: '根据你对我的了解和我知识库里的资料，帮我拟一份合作提案', needs: ['knowledge-bases'] },
];

// ---------------------------------------------------------------------------
// Request builder — faithful copy of src/main/cerebellum/volatileBlockGate.ts
// (keep in sync when tuning the module wording)
// ---------------------------------------------------------------------------

const INSTRUCTIONS = {
  experience:
    'Does replying to the user\'s message at `user_message` need the assistant\'s own ' +
    'self-identity, nightly dream reflections, or lessons learned from past interactions? ' +
    'Needed only when the message is about who the assistant is, what it has learned or ' +
    'reflects on, or explicitly references its past behavior; ordinary task requests do not need it.',
  'twin-impression':
    'Does replying to the user\'s message at `user_message` need the assistant\'s stored ' +
    'impressions of its local worker bots (their strengths, habits, reliability)? Needed ' +
    'only when the message involves those worker bots, delegating work to them, or team ' +
    'composition questions.',
  'knowledge-bases':
    'Does replying to the user\'s message at `user_message` need the listing of the ' +
    'assistant\'s knowledge bases (their names and document counts)? Needed only when the ' +
    'message asks to search, store into, or consult a knowledge base or its documents.',
  'remote-services':
    'Does replying to the user\'s message at `user_message` need the directory of remote ' +
    'on-chain services offered by other bots? Needed only when the message seeks a ' +
    'capability the assistant itself lacks and might delegate or purchase externally; ' +
    'ordinary self-served requests do not need it.',
  'team-culture':
    'Does replying to the user\'s message at `user_message` need the shared team ' +
    'culture block (fleet-wide glossary terms, working conventions, distilled team ' +
    'lessons)? Needed only when the message involves fleet coordination, team members, ' +
    'shared terminology, or ways of working; ordinary task requests do not need it.',
};

const CRITERIA = {
  true: 'The message clearly falls into what this block provides.',
  false: 'The message is unrelated to what this block provides.',
};

function buildGateRequest({ userText, model }) {
  const questions = {};
  for (const key of BLOCK_KEYS) {
    questions[key] = { type: 'noul', instructions: INSTRUCTIONS[key], criteria: { ...CRITERIA } };
  }
  return {
    state: { user_message: String(userText ?? '').replace(/\s+/g, ' ').trim() },
    model,
    questions,
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

async function evaluateGate({ baseUrl, apiKey, model, userText, verbose }) {
  const { data, latencyMs } = await postJson(`${baseUrl}/v1/systemone`, apiKey, buildGateRequest({ userText, model }));
  if (verbose) console.error(JSON.stringify(data, null, 2));
  const nouls = {};
  for (const key of BLOCK_KEYS) {
    const noul = data.answers?.[key]?.noul;
    nouls[key] = typeof noul === 'number' && Number.isFinite(noul)
      ? Math.max(0, Math.min(1, noul))
      : null; // missing answer: the module fails open per block
  }
  return {
    nouls,
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

function confusion(cases, threshold) {
  const matrix = {};
  for (const key of BLOCK_KEYS) {
    matrix[key] = { tp: 0, fp: 0, fn: 0, tn: 0, open: 0 };
  }
  for (const c of cases) {
    for (const key of BLOCK_KEYS) {
      const noul = c.nouls?.[key];
      if (noul === null || noul === undefined) {
        matrix[key].open += 1; // fail-open: kept
        if (!c.needs.includes(key)) matrix[key].fp += 1;
        else matrix[key].tp += 1;
        continue;
      }
      const keep = noul >= threshold;
      const needed = c.needs.includes(key);
      if (keep && needed) matrix[key].tp += 1;
      else if (keep && !needed) matrix[key].fp += 1;
      else if (!keep && needed) matrix[key].fn += 1;
      else matrix[key].tn += 1;
    }
  }
  return matrix;
}

async function runEval(opts) {
  const { baseUrl, apiKey, model, verbose } = opts;
  let cases = SAMPLE_CASES;
  if (opts.cases) {
    const loaded = JSON.parse(await (await import('node:fs/promises')).readFile(opts.cases, 'utf8'));
    cases = loaded.map((item) => ({ user: String(item.user ?? ''), needs: item.needs ?? [] }));
  }

  if (opts.dryRun) {
    console.log(`dry-run: ${cases.length} cases — no API calls made.\n`);
    for (const [index, c] of cases.entries()) {
      console.log(`  [${index}] needs=[${c.needs.join(', ') || 'none'}]  ${c.user}`);
    }
    console.log('\nfirst request body that would be sent:');
    console.log(JSON.stringify(buildGateRequest({ userText: cases[0].user, model }), null, 2));
    return;
  }

  const MODULE_THRESHOLD = 0.35;
  console.log(`\nmodel=${model}  cases=${cases.length}  moduleThreshold=${MODULE_THRESHOLD}\n`);

  let totalLatency = 0;
  let totalInputTokens = 0;
  let answeredModel = model;
  let failures = 0;

  for (const [index, c] of cases.entries()) {
    let evaluated;
    try {
      evaluated = await evaluateGate({ baseUrl, apiKey, model, userText: c.user, verbose });
    } catch (error) {
      failures += 1;
      console.error(`  [${index}] gate call failed: ${error.message}`);
      continue;
    }
    c.nouls = evaluated.nouls;
    answeredModel = evaluated.answeredModel;
    totalLatency += evaluated.latencyMs;
    totalInputTokens += evaluated.inputTokens;

    const summary = BLOCK_KEYS.map((key) => {
      const noul = evaluated.nouls[key];
      const needed = c.needs.includes(key);
      const verdict = noul === null ? 'open' : noul >= MODULE_THRESHOLD ? 'keep' : 'SKIP';
      const mark = noul === null ? ' ' : (noul >= MODULE_THRESHOLD) === needed ? '✓' : '✗';
      return `${mark} ${key}=${noul === null ? ' -' : noul.toFixed(2)} ${verdict}`;
    }).join('  ');
    console.log(`  [${String(index).padStart(2)}] ${c.user}`);
    console.log(`       ${summary}`);
  }

  if (failures > 0) {
    console.error(`\n${failures} gate call(s) failed — results below are partial.`);
  }

  const matrix = confusion(cases, MODULE_THRESHOLD);
  console.log('\n' + '—'.repeat(72));
  let totalFn = 0;
  for (const key of BLOCK_KEYS) {
    const m = matrix[key];
    totalFn += m.fn;
    console.log(`${key.padEnd(17)} keep-needed=${String(m.tp).padStart(2)}  saved=${String(m.tn).padStart(2)}  ` +
      `wasted=${String(m.fp).padStart(2)}  LOST=${m.fn}${m.fn ? '  ⚠' : ''}`);
  }

  console.log('\nthreshold sweep (FN must stay 0 for ship):');
  for (const t of [0.2, 0.35, 0.5, 0.65]) {
    const m = confusion(cases, t);
    const fn = BLOCK_KEYS.reduce((sum, key) => sum + m[key].fn, 0);
    const tn = BLOCK_KEYS.reduce((sum, key) => sum + m[key].tn, 0);
    console.log(`  threshold=${t.toFixed(2)}  LOST(fn)=${fn}  saved(tn)=${tn}`);
  }

  const costUsd = (totalInputTokens * 0.042) / 1e6;
  console.log(`\nanswered model: ${answeredModel}`);
  console.log(`gate total: ${totalLatency}ms, ${totalInputTokens} input tokens, ` +
    `≈ $${costUsd.toFixed(6)} ($0.042/Mtok input, output free)`);
  if (totalFn > 0) {
    console.log('\nWARNING: FN > 0 — the gate would drop context a labeled turn needs. ' +
      'Lower CEREBELLUM_VOLATILE_GATE_THRESHOLDS or reword the question before enabling.');
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

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
    else if (arg === '--cases') opts.cases = args[++i];
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
