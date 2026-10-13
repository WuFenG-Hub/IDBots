#!/usr/bin/env node
/**
 * cerebellum-effort-eval — offline evaluation of the cerebellum (decision
 * model) reasoning-effort auto-selection: does one JEV Choice question pick
 * the right effort rung (off / low / high / max) for real-shaped Chinese
 * chat messages?
 *
 * This is the Phase-0 tuning harness for the "auto" effort rung design:
 * the request builder below is the exact shape Phase 1 will ship in
 * src/main/cerebellum/effortSelector.ts — keep the two in sync when tuning
 * the instructions.
 *
 * What it does:
 *   For each labeled message, one POST {baseUrl}/v1/systemone carrying ONE
 *   Choice question whose `criteria` map holds the four effort rungs against
 *   a state with the user's message. Prints the probability distribution per
 *   message with the argmax verdict vs label, then:
 *     - exact-match rate + full confusion matrix (4x4 rungs)
 *     - the assistant-mode escalation policy sweep: escalate to thinking
 *       only when P(high)+P(max) >= T (else off), for T in 0.30..0.80 —
 *       reporting over-escalation (casual -> thinking, a first-sentence
 *       latency cost) and under-escalation (complex -> off, a quality cost).
 *
 * Usage:
 *   node scripts/cerebellum-effort-eval.mjs check
 *       Connectivity + auth check (GET /v1/models, then one tiny Noul call).
 *   node scripts/cerebellum-effort-eval.mjs eval
 *       Run the embedded labeled dataset (default).
 *   node scripts/cerebellum-effort-eval.mjs eval --cases <c.json>
 *       Custom cases [{ "q": "...", "expected": "off|low|high|max" }].
 *
 * Options:
 *   --key <k>          API key (or TYPESAFE_API_KEY env)
 *   --base-url <url>   default https://api.typesafe.ai (or TYPESAFE_BASE_URL)
 *   --model <id>       default jev-latest
 *   --dry-run          print the cases and one full request body WITHOUT any
 *                      API call (preview what leaves this machine)
 *   --verbose          dump raw API responses
 *
 * Privacy: whatever cases you point this at ARE sent to the configured
 * provider. The embedded sample is synthetic (hand-written for this eval);
 * only use a provider you have opted into.
 *
 * Network note: api.typesafe.ai returns HTTP 451 (region-blocked) in some
 * regions. Node's global fetch does NOT follow the macOS system proxy; for
 * Node >= 24.5 set NODE_USE_ENV_PROXY=1 plus HTTPS_PROXY, e.g.:
 *   NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 \
 *     TYPESAFE_API_KEY=... node scripts/cerebellum-effort-eval.mjs eval
 */

import { argv, env, exit } from 'node:process';

// ---------------------------------------------------------------------------
// Embedded labeled dataset (synthetic, hand-written, Chinese-first because
// that is the assistant-mode audience). `expected` is the rung a strong
// reasoning model SHOULD get: casual chat and tool commands need no thinking
// (off — the mode's first-sentence promise), light drafting deserves low,
// correctness-risk work (coding/debugging/analysis) high, and formal/intricate
// reasoning max. Tricky entries are deliberate: look-hard-but-shallow
// ("9.11 vs 9.9"), look-easy-but-deep (concurrency bugs), and bare follow-ups
// ("继续") which must never escalate.
// ---------------------------------------------------------------------------

const RUNGS = ['off', 'low', 'high', 'max'];

const SAMPLE_CASES = [
  // ---- off: casual chat, social, simple lookups, tool commands -----------
  { q: '早上好！今天过得怎么样？', expected: 'off' },
  { q: '谢谢，辛苦啦，早点休息', expected: 'off' },
  { q: '继续', expected: 'off' },
  { q: '好，就按你说的方案办', expected: 'off' },
  { q: '明天早上九点提醒我吃药，以后每天都要', expected: 'off' },
  { q: '查一下我上次发那条动态是什么时候', expected: 'off' },
  { q: '1+1 等于几？', expected: 'off' },
  { q: '9.11 和 9.9 哪个大？', expected: 'off' },
  { q: '帮我给这张照片想一句朋友圈配文', expected: 'off' },
  { q: '把这句话翻译成英文：会议改到下周三了', expected: 'off' },
  { q: '1+1 等于几？不要想太久', expected: 'off' },
  // ---- low: light drafting, summarizing, rephrasing -----------------------
  { q: '帮我把这段会议记录整理成纪要，标出待办事项', expected: 'low' },
  { q: '把这篇文章用三句话总结给我', expected: 'low' },
  { q: '帮我把这封邮件改得客气一点，别太生硬', expected: 'low' },
  { q: '给我们的咖啡品牌起五个名字，各附一句理由', expected: 'low' },
  { q: '把这份五千字的调研报告压缩成两百字摘要', expected: 'low' },
  { q: '给我讲讲量子纠缠是什么，通俗一点', expected: 'low' },
  { q: '写一首关于秋天的小诗，四句就行', expected: 'low' },
  { q: '帮我把这段中文简历的经历部分润色一下', expected: 'low' },
  // ---- high: coding, debugging, analysis, multi-step ----------------------
  { q: '帮我看看这段 Python 为什么报错：TypeError: NoneType is not callable', expected: 'high' },
  { q: '用 TypeScript 写一个带重试、超时和取消的 fetch 封装，要处理好竞态', expected: 'high' },
  { q: '分析这份季度运营数据，找出增长异常的三个可能原因', expected: 'high' },
  { q: '重构这个模块，把回调风格改成 async/await，注意不能破坏现有行为', expected: 'high' },
  { q: '帮我审查这个 PR，重点看并发安全和边界条件', expected: 'high' },
  { q: '设计一个多机器人协作的任务分配方案，要考虑失败恢复和超时', expected: 'high' },
  { q: '我的服务在并发场景下偶发死锁，帮我定位可能的原因', expected: 'high' },
  { q: '对比 React 和 Vue 在大型项目里的性能差异，给我们做个技术选型', expected: 'high' },
  // ---- max: formal / intricate reasoning ----------------------------------
  { q: '推导这段排序算法的平均时间复杂度，给出严格证明', expected: 'max' },
  { q: '设计一个分布式共识协议，并论证其在节点宕机时的安全性', expected: 'max' },
  { q: '用 Coq 形式化验证这段快速幂实现的正确性', expected: 'max' },
];

// ---------------------------------------------------------------------------
// Request builder — the exact shape Phase 1 will ship in
// src/main/cerebellum/effortSelector.ts (keep in sync when tuning).
// ---------------------------------------------------------------------------

const QUESTION_ID = 'effort_level';

const INSTRUCTIONS =
  'How much reasoning effort does answering the user\'s message at `user_message` need? '
  + 'Judge the DEPTH of work the task intrinsically requires, not its topic or length. '
  + '`off`: casual chat, greetings, thanks, bare follow-ups, simple lookups, short single-shot '
  + 'factual or creative snippets, commands that just invoke a tool. '
  + '`low`: light drafting — summarizing, translating a passage, rephrasing, short structured '
  + 'writing with a clear shape to follow. '
  + '`high`: work with correctness risk — writing or debugging code, refactoring, multi-step '
  + 'analysis, tradeoff decisions, planning with failure modes. '
  + '`max`: formal proofs, rigorous derivations, intricate algorithm or protocol design. '
  + 'When unsure between two levels, pick the lower one — depth of thinking is expensive and is '
  + 'only worth it when the task genuinely needs it. The user may write in any language.';

const RUNG_CRITERIA = {
  off: 'off — no deliberation needed: chat, greetings, simple facts, tool commands, follow-ups',
  low: 'low — light drafting: summarize, translate, rephrase, short structured writing',
  high: 'high — correctness-risk work: coding, debugging, refactoring, multi-step analysis, tradeoffs',
  max: 'max — formal or intricate reasoning: proofs, derivations, protocol/algorithm design',
};

function buildEffortRequest({ userText, model }) {
  return {
    state: { user_message: String(userText ?? '').replace(/\s+/g, ' ').trim() },
    model,
    questions: {
      [QUESTION_ID]: { type: 'choice', instructions: INSTRUCTIONS, criteria: RUNG_CRITERIA },
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

async function selectEffort({ baseUrl, apiKey, model, userText, verbose }) {
  const { data, latencyMs } = await postJson(
    `${baseUrl}/v1/systemone`,
    apiKey,
    buildEffortRequest({ userText, model }),
  );
  if (verbose) console.error(JSON.stringify(data, null, 2));
  const answer = data.answers?.[QUESTION_ID] ?? {};
  const entries = Object.entries(answer.probabilities ?? {})
    .filter(([rung, value]) => RUNGS.includes(rung) && typeof value === 'number' && Number.isFinite(value))
    .map(([rung, value]) => ({ rung, probability: Math.max(0, Math.min(1, value)) }))
    .sort((a, b) => b.probability - a.probability || a.rung.localeCompare(b.rung));
  if (entries.length === 0 && typeof answer.choice === 'string' && RUNGS.includes(answer.choice)) {
    entries.push({ rung: answer.choice, probability: 1 });
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
    state: '测试消息：帮我看看这段代码为什么死锁。',
    model,
    questions: {
      effort_level: { type: 'choice', instructions: INSTRUCTIONS, criteria: RUNG_CRITERIA },
    },
  });
  console.log(`POST /v1/systemone OK — model=${data.model} latency=${latencyMs}ms ` +
    `input_tokens=${data.usage?.input_tokens} choice=${JSON.stringify(data.answers?.effort_level?.probabilities ?? data.answers?.effort_level?.choice)}`);
  console.log('check: OK');
}

async function loadJsonFlag(flagValue) {
  if (!flagValue) return null;
  return JSON.parse(await (await import('node:fs/promises')).readFile(flagValue, 'utf8'));
}

function printConfusionMatrix(cases, verdictOf) {
  const matrix = {};
  for (const expected of RUNGS) matrix[expected] = {};
  for (const actual of RUNGS) {
    for (const expected of RUNGS) matrix[expected][actual] = 0;
  }
  for (const testCase of cases) {
    matrix[testCase.expected][verdictOf(testCase)] += 1;
  }
  const width = 6;
  console.log('\nconfusion matrix (rows = expected, cols = predicted):');
  console.log(`  ${' '.repeat(width)}${RUNGS.map((r) => r.padStart(width)).join('')}`);
  for (const expected of RUNGS) {
    console.log(`  ${expected.padEnd(width)}${RUNGS.map((actual) => String(matrix[expected][actual]).padStart(width)).join('')}`);
  }
  return matrix;
}

async function runEval(opts) {
  const { baseUrl, apiKey, model, verbose } = opts;
  const cases = opts.casesData
    ? opts.casesData.map((item) => ({ q: item.q, expected: RUNGS.includes(item.expected) ? item.expected : 'off' }))
    : SAMPLE_CASES;

  if (opts.dryRun) {
    console.log(`dry-run: ${cases.length} cases — no API calls made.\n`);
    for (const { q, expected } of cases) {
      console.log(`  [${expected.padEnd(4)}] ${q}`);
    }
    console.log('\nfirst request body that would be sent:');
    console.log(JSON.stringify(buildEffortRequest({ userText: cases[0].q, model }), null, 2));
    return;
  }

  console.log(`\nmodel=${model}  cases=${cases.length}\n`);

  let totalLatency = 0;
  let totalInputTokens = 0;
  let answeredModel = model;
  let failures = 0;

  for (const testCase of cases) {
    let ranked;
    try {
      ranked = await selectEffort({ baseUrl, apiKey, model, userText: testCase.q, verbose });
    } catch (error) {
      failures += 1;
      console.error(`  effort call failed for "${testCase.q}": ${error.message}`);
      testCase.probabilities = null;
      continue;
    }
    answeredModel = ranked.answeredModel;
    totalLatency += ranked.latencyMs;
    totalInputTokens += ranked.inputTokens;

    const probabilities = {};
    for (const rung of RUNGS) probabilities[rung] = 0;
    for (const entry of ranked.entries) probabilities[entry.rung] = entry.probability;
    testCase.probabilities = probabilities;

    const argmax = ranked.entries[0]?.rung ?? 'off';
    testCase.argmax = argmax;
    const mark = argmax === testCase.expected ? '✓' : '✗';
    const distribution = RUNGS.map((rung) => `${rung}:${probabilities[rung].toFixed(2)}`).join('  ');
    console.log(`${mark} [${testCase.expected}] -> ${argmax.padEnd(4)}  ${testCase.q}`);
    console.log(`    ${distribution}   [${ranked.latencyMs}ms, ${ranked.inputTokens} in-tokens]`);
  }
  console.log('');

  if (failures > 0) {
    console.error(`\n${failures} effort call(s) failed — results below are partial.`);
  }

  const answered = cases.filter((testCase) => testCase.probabilities);
  const exact = answered.filter((testCase) => testCase.argmax === testCase.expected).length;

  console.log('—'.repeat(72));
  console.log(`exact-match (argmax): ${exact}/${answered.length}`);
  printConfusionMatrix(answered, (testCase) => testCase.argmax);

  // Assistant-mode escalation policy sweep. Two levels only (off vs thinking):
  // escalate when P(high)+P(max) >= T. Over-escalation = an off/low-labeled
  // case escalates (first-sentence latency cost); under-escalation = a
  // high/max-labeled case stays off (quality cost).
  console.log('\nassistant-mode escalation sweep (escalate when P(high)+P(max) >= T, else off):');
  console.log(`  ${'T'.padEnd(5)}${'over-esc'.padEnd(11)}${'under-esc'.padEnd(11)}both-correct`);
  for (const threshold of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
    let overEscalated = 0;
    let underEscalated = 0;
    let correct = 0;
    for (const testCase of answered) {
      const escalate = testCase.probabilities.high + testCase.probabilities.max >= threshold;
      const shouldEscalate = testCase.expected === 'high' || testCase.expected === 'max';
      if (escalate === shouldEscalate) correct += 1;
      else if (escalate && !shouldEscalate) overEscalated += 1;
      else underEscalated += 1;
    }
    console.log(`  ${String(threshold).padEnd(5)}${`${overEscalated}`.padEnd(11)}${`${underEscalated}`.padEnd(11)}${correct}/${answered.length}`);
  }

  const costUsd = (totalInputTokens * 0.042) / 1e6;
  console.log(`\nanswered model: ${answeredModel}`);
  console.log(`effort total: ${totalLatency}ms, ${totalInputTokens} input tokens, ` +
    `≈ $${costUsd.toFixed(6)} ($0.042/Mtok input, output free)`);
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

try {
  opts.casesData = await loadJsonFlag(opts.cases);
} catch (error) {
  console.error(`failed to load --cases: ${error.message}`);
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
