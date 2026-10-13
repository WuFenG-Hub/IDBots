#!/usr/bin/env node
/**
 * cerebellum-write-gate-eval — offline evaluation of the cerebellum (decision
 * model) memory write gate: does the JEV "is this turn worth remembering?"
 * Noul agree with human labels on real-shaped Chinese turns?
 *
 * This is the tuning harness for CEREBELLUM_MEMORY_WRITE_GATE_THRESHOLD in
 * src/main/cerebellum/memoryWriteGate.ts. The question wording below is a
 * faithful copy of that module — keep the two in sync when tuning.
 *
 * What it does:
 *   For each labeled turn, one POST {baseUrl}/v1/systemone carrying ONE Noul
 *   question (implicit or explicit-only mode) against a state with the turn's
 *   user/assistant excerpts. Compares the verdict (noul >= threshold) with the
 *   label and prints a confusion matrix:
 *     TP  proceed & memory-worthy   (correct)
 *     FP  proceed & not worthy      (brain call wasted — status-quo cost)
 *     FN  skip   & memory-worthy    (LOST memory — the dangerous error)
 *     TN  skip   & not worthy       (brain call saved — the win)
 *   plus accuracy/precision/recall/F1, a threshold sweep, latency and cost.
 *
 * Usage:
 *   node scripts/cerebellum-write-gate-eval.mjs check
 *       Connectivity + auth check (GET /v1/models, then one tiny Noul call).
 *   node scripts/cerebellum-write-gate-eval.mjs eval
 *       Run the embedded labeled sample dataset (default).
 *   node scripts/cerebellum-write-gate-eval.mjs eval --cases <cases.json>
 *       Custom cases: [{ "user": "...", "assistant": "...", "label": true, "note": "..." }]
 *
 * Options:
 *   --key <k>          API key (or TYPESAFE_API_KEY env)
 *   --base-url <url>   default https://api.typesafe.ai (or TYPESAFE_BASE_URL)
 *   --model <id>       default jev-latest
 *   --threshold <f>    verdict threshold, default 0.5 (module default)
 *   --explicit-only    evaluate the explicit-only question variant instead
 *   --dry-run          print the dataset and one full request body WITHOUT any
 *                      API call (preview exactly what would leave this machine)
 *   --verbose          dump raw API responses
 *
 * Privacy: whatever dataset you point this at IS sent to the configured
 * provider. The embedded sample contains no real user data; --cases with real
 * turns means those turns leave this machine — only use a provider you have
 * opted into.
 *
 * Network note: api.typesafe.ai returns HTTP 451 (region-blocked) in some
 * regions. Node's global fetch does NOT follow the macOS system proxy; for
 * Node >= 24.5 set NODE_USE_ENV_PROXY=1 plus HTTPS_PROXY, e.g.:
 *   NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 \
 *     TYPESAFE_API_KEY=... node scripts/cerebellum-write-gate-eval.mjs eval
 * (Inside the Electron app, the main-process net stack follows the system
 * proxy automatically, so this only affects bare-Node runs like this script.)
 */

import { argv, env, exit } from 'node:process';

// ---------------------------------------------------------------------------
// Embedded sample dataset (Chinese, synthetic — mirrors IDBots owner-scope
// conversation shapes). label=true: durable fact / preference / explicit
// remember-forget instruction. label=false: question, small talk, one-off
// task, transient context, procedural output.
// ---------------------------------------------------------------------------

const SAMPLE_CASES = [
  // --- memory-worthy (label: true) ---
  { user: '记住：我对花生过敏，点外卖时一定要检查配料表', assistant: '好的，记下来了。以后点外卖我会先看配料表。', label: true, note: 'explicit remember command' },
  { user: '以后写代码注释一律用英文，别用中文', assistant: '明白，之后注释都用英文。', label: true, note: 'durable preference' },
  { user: '我叫陈明，朋友们都叫我老陈', assistant: '你好老陈！', label: true, note: 'identity fact' },
  { user: '我家猫叫布丁，三岁的布偶，肠胃敏感不能随便换粮', assistant: '收到，布丁的饮食我会留意的。', label: true, note: 'durable family fact' },
  { user: '我周末一般不看工作消息，有急事直接打电话', assistant: '了解，周末非紧急不打扰。', label: true, note: 'durable habit' },
  { user: '我只喝手冲咖啡，别给我推荐速溶的', assistant: '好，只推手冲相关的。', label: true, note: 'durable preference' },
  { user: '忘掉我之前说的住址吧，我搬到杭州了', assistant: '好的，住址更新为杭州。', label: true, note: 'explicit forget + update' },
  { user: '帮我整理资料时先按主题分组再写摘要，我习惯这样看', assistant: '明白，按主题分组再给摘要。', label: true, note: 'durable work preference' },
  { user: 'Recuerda que me llamo Carlos', assistant: '¡Encantado, Carlos!', label: true, note: 'multilingual explicit command' },
  { user: '每周一早上 9 点我们团队有周会，那段时间别给我安排别的', assistant: '好的，周一 9 点保持空闲。', label: true, note: 'recurring schedule (durable)' },
  { user: '我最近在学 Rust，想用它重写一个小工具', assistant: 'Rust 挺适合的，需要资料随时说。', label: true, note: 'ongoing interest' },
  { user: '以后任何要花钱的操作都必须先问我', assistant: '明白，花钱操作一律先确认。', label: true, note: 'standing constraint' },
  // --- not memory-worthy (label: false) ---
  { user: '今天杭州天气怎么样？', assistant: '今天多云，22 度左右。', label: false, note: 'question' },
  { user: '哈哈哈这个表情包太好笑了', assistant: '😄', label: false, note: 'small talk' },
  { user: '帮我看看这个报错为什么：TypeError: Cannot read properties of undefined', assistant: '看起来是变量还没初始化……', label: false, note: 'one-off debugging task' },
  { user: '下周三提醒我去取快递', assistant: '好，下周三提醒你。', label: false, note: 'one-off reminder (transient)' },
  { user: '运行 npm install 装好依赖后把输出贴给我', assistant: '装好了，输出如下……', label: false, note: 'procedural command' },
  { user: '今天有点累，不想干活了', assistant: '那就早点休息吧。', label: false, note: 'transient mood' },
  { user: '你觉得 TypeScript 和 Go 哪个更适合写后端？', assistant: '各有优劣……', label: false, note: 'opinion question' },
  { user: '帮我搜一下最近 MVC 链上有什么新动态', assistant: '搜到了几条……', label: false, note: 'one-off lookup' },
  { user: '嗯嗯好的，就这样吧', assistant: '好的。', label: false, note: 'acknowledgment' },
  { user: '我这周都在出差，等回来再说', assistant: '好的，回来再继续。', label: false, note: 'transient state' },
  { user: '那个任务跑完了吗？', assistant: '还在跑，预计十分钟。', label: false, note: 'task status question' },
];

// ---------------------------------------------------------------------------
// Question builder — faithful copy of src/main/cerebellum/memoryWriteGate.ts
// (keep in sync when tuning the module wording)
// ---------------------------------------------------------------------------

const QUESTION_ID = 'worth_remembering';

function buildGateQuestion(explicitOnly) {
  const clause = explicitOnly
    ? 'In this explicit-only mode ONLY an explicit remember/forget instruction from the user counts — '
      + 'personal facts and preferences do NOT. '
    : '';
  const instructions =
    'Does the conversation turn at `user_message` (with `assistant_message` as context) contain '
    + 'anything worth storing as a long-term memory about the user — a stable personal fact, a '
    + 'stable preference or habit, or an explicit remember/forget instruction given by the user? '
    + 'The user may write in ANY language. '
    + clause
    + 'Ignore questions, transient small talk, one-off tasks, current-session debugging context, '
    + 'and procedural/command output; a turn about only the task at hand is not memory-worthy.';
  return {
    type: 'noul',
    instructions,
    criteria: explicitOnly
      ? {
        true: 'The user gives an explicit remember/forget instruction in this turn.',
        false: 'The user gives no explicit remember/forget instruction; nothing here counts in explicit-only mode.',
      }
      : {
        true: 'The turn contains at least one durable user fact, stable preference, or explicit remember/forget instruction.',
        false: 'The turn is transient — small talk, a question, a one-off task, or command output — with nothing durable about the user.',
      },
  };
}

function buildGateRequest({ userText, assistantText, model, explicitOnly }) {
  const collapse = (value, max) =>
    String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  return {
    state: {
      user_message: collapse(userText, 1200),
      assistant_message: collapse(assistantText, 400),
    },
    model,
    questions: { [QUESTION_ID]: buildGateQuestion(explicitOnly) },
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

async function evaluateGate({ baseUrl, apiKey, model, explicitOnly, userText, assistantText, verbose }) {
  const { data, latencyMs } = await postJson(
    `${baseUrl}/v1/systemone`,
    apiKey,
    buildGateRequest({ userText, assistantText, model, explicitOnly }),
  );
  if (verbose) console.error(JSON.stringify(data, null, 2));
  const noul = data.answers?.[QUESTION_ID]?.noul;
  return {
    noul: typeof noul === 'number' && Number.isFinite(noul) ? Math.max(0, Math.min(1, noul)) : null,
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
  const matrix = { tp: 0, fp: 0, fn: 0, tn: 0, noVerdict: 0 };
  for (const c of cases) {
    if (c.noul === null) {
      matrix.noVerdict += 1; // fail-open: proceeds to the brain, counted apart
      continue;
    }
    const proceed = c.noul >= threshold;
    if (proceed && c.label === true) matrix.tp += 1;
    else if (proceed && c.label === false) matrix.fp += 1;
    else if (!proceed && c.label === true) matrix.fn += 1;
    else matrix.tn += 1;
  }
  return matrix;
}

function fmtMetrics(matrix) {
  const { tp, fp, fn, tn } = matrix;
  const total = tp + fp + fn + tn;
  const accuracy = total ? (tp + tn) / total : 0;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return `accuracy=${accuracy.toFixed(2)} precision=${precision.toFixed(2)} ` +
    `recall=${recall.toFixed(2)} F1=${f1.toFixed(2)}`;
}

async function runEval(opts) {
  const { baseUrl, apiKey, model, threshold, explicitOnly, verbose } = opts;
  let cases = SAMPLE_CASES;
  if (opts.cases) {
    const loaded = JSON.parse(await (await import('node:fs/promises')).readFile(opts.cases, 'utf8'));
    cases = loaded.map((item) => ({
      user: String(item.user ?? ''),
      assistant: String(item.assistant ?? ''),
      label: item.label === true,
      note: String(item.note ?? ''),
    }));
  }

  if (opts.dryRun) {
    console.log(`dry-run: ${cases.length} cases, mode=${explicitOnly ? 'explicit-only' : 'implicit'} — no API calls made.\n`);
    for (const [index, c] of cases.entries()) {
      console.log(`  [${index}] ${c.label ? 'MEMORABLE' : 'skip    '}  ${c.user.slice(0, 52)}` +
        `${c.note ? `   # ${c.note}` : ''}`);
    }
    console.log('\nfirst request body that would be sent:');
    console.log(JSON.stringify(buildGateRequest({
      userText: cases[0].user,
      assistantText: cases[0].assistant,
      model,
      explicitOnly,
    }), null, 2));
    return;
  }

  console.log(`\nmodel=${model}  cases=${cases.length}  mode=${explicitOnly ? 'explicit-only' : 'implicit'}  threshold=${threshold}\n`);

  let totalLatency = 0;
  let totalInputTokens = 0;
  let answeredModel = model;
  let failures = 0;

  for (const [index, c] of cases.entries()) {
    let evaluated;
    try {
      evaluated = await evaluateGate({
        baseUrl, apiKey, model, explicitOnly,
        userText: c.user, assistantText: c.assistant, verbose,
      });
    } catch (error) {
      failures += 1;
      console.error(`  [${index}] gate call failed: ${error.message}`);
      continue;
    }
    c.noul = evaluated.noul;
    answeredModel = evaluated.answeredModel;
    totalLatency += evaluated.latencyMs;
    totalInputTokens += evaluated.inputTokens;

    const verdict = evaluated.noul === null
      ? 'no-verdict'
      : evaluated.noul >= threshold ? 'proceed' : 'SKIP';
    const mark = evaluated.noul === null
      ? ' '
      : (evaluated.noul >= threshold) === c.label ? '✓' : '✗';
    const noulText = evaluated.noul === null ? '  - ' : evaluated.noul.toFixed(2);
    console.log(`  ${mark} [${index}] ${verdict.padEnd(9)} noul=${noulText}  ` +
      `(label=${c.label ? 'memorable' : 'skip'}) ${evaluated.latencyMs}ms  ${c.user.slice(0, 40)}`);
  }

  if (failures > 0) {
    console.error(`\n${failures} gate call(s) failed — results below are partial.`);
  }

  const matrix = confusion(cases, threshold);
  console.log('\n' + '—'.repeat(72));
  console.log(`TP=${matrix.tp}  FP=${matrix.fp} (brain call wasted, status-quo cost)  ` +
    `FN=${matrix.fn} (LOST memory — dangerous)  TN=${matrix.tn} (brain call saved)  ` +
    `no-verdict=${matrix.noVerdict} (fail-open, proceeds)`);
  console.log(fmtMetrics(matrix));

  console.log('\nthreshold sweep (FN must stay 0 for ship):');
  for (const t of [0.3, 0.4, 0.5, 0.6, 0.7]) {
    const m = confusion(cases, t);
    console.log(`  threshold=${t.toFixed(1)}  TP=${m.tp} FP=${m.fp} FN=${m.fn} TN=${m.tn}  ${fmtMetrics(m)}`);
  }

  const costUsd = (totalInputTokens * 0.042) / 1e6;
  console.log(`\nanswered model: ${answeredModel}`);
  console.log(`gate total: ${totalLatency}ms, ${totalInputTokens} input tokens, ` +
    `≈ $${costUsd.toFixed(6)} ($0.042/Mtok input, output free)`);
  if (matrix.fn > 0) {
    console.log('\nWARNING: FN > 0 — the gate would skip memory-worthy turns. ' +
      'Lower CEREBELLUM_MEMORY_WRITE_GATE_THRESHOLD or reword the question before enabling.');
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(args) {
  const opts = { threshold: 0.5, explicitOnly: false };
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--verbose') opts.verbose = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--explicit-only') opts.explicitOnly = true;
    else if (arg === '--key') opts.apiKey = args[++i];
    else if (arg === '--base-url') opts.baseUrl = args[++i];
    else if (arg === '--model') opts.model = args[++i];
    else if (arg === '--threshold') opts.threshold = Number(args[++i]);
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
