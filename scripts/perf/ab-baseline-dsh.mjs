#!/usr/bin/env node
// A/B latency baseline: IDBots app-shaped DSH composition vs a stock
// deepseek-harness-shaped composition, same kernel, same model + effort,
// same scripted tasks, same driver.
//
// Both sides spawn THIS repo's dsh-runtime (kernel 0.2.0-rc.1, the same
// packages deepseek-harness builds) and are driven over the same SDK client,
// so the only variable is the composition (prompt surface + tool catalog):
//
//   side "idbots":  this repo's generateRuntimeConfig composition with the
//                   system prompt + host-tool catalog EXTRACTED from a real
//                   app session artifact (first system/message baseline +
//                   request/header tool list) — the app's actual request shape.
//   side "stock":   a hand-translated stock base-bundle composition (harness
//                   identity system prompt, the stock 24-tool catalog, stock
//                   compaction/spill/pruner defaults, no IDBots layers).
//
// Host/approval bridges on the idbots side are auto-answered (tools
// unavailable / allow) — this measures prompt-shape effects on model behavior
// (reasoning tokens per step), not host tool execution.
//
// Usage (from a worktree root):
//   node scripts/perf/ab-baseline-dsh.mjs [--side both|stock|idbots]
//        [--runs 1] [--extract-from <sessionDir>] [--out scripts/perf/ab-results]
//        [--model deepseek-flash] [--tasks <json file>]
//
// Requires the IDBots app DB with the official DeepSeek provider key
// (~/Library/Application Support/IDBots/idbots.sqlite, kv app_config) and
// /opt/homebrew/bin/zstd for parsing zstd session artifacts.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const IDBOTS_DB = process.env.AB_IDBOTS_DB || path.join(os.homedir(), 'Library/Application Support/IDBots/idbots.sqlite');
const IDBOTS_SESSIONS_ROOT = process.env.AB_IDBOTS_SESSIONS || path.join(os.homedir(), 'Library/Application Support/IDBots/dsh-sessions/v0');
const ZSTD = '/opt/homebrew/bin/zstd';
const TASK_TIMEOUT_MS = 300_000;

// ---------- args ----------
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const side = arg('side', 'both');
const runs = Math.max(1, Number(arg('runs', '1')));
const model = arg('model', 'deepseek-flash');
const maxOutputTokens = Math.max(1024, Number(arg('max-tokens', '256000')));
const outDir = path.resolve(arg('out', path.join(REPO, 'scripts/perf/ab-results')));

// Built-in task set: everyday assistant turns — reasoning-only plus light
// file tool use. Tool tasks operate on seeded files so both sides see
// identical inputs.
const DEFAULT_TASKS = [
  { id: 'explain-idempotency', kind: 'reason', text: 'Explain in 2-3 sentences why idempotency keys matter for payment APIs.' },
  { id: 'debounce', kind: 'reason', text: 'Write a small TypeScript debounce function in a code block. Do not create files.' },
  { id: 'kvcache', kind: 'reason', text: 'In one short paragraph: what is the difference between KV-cache prefix reuse and a full prefill?' },
  { id: 'reconnect', kind: 'reason', text: 'Name two common causes of WebSocket reconnect storms and one mitigation for each.' },
  { id: 'biglog', kind: 'reason', text: 'You have a 2 GiB log file on a machine with 512 MiB RAM. Describe an efficient way to count occurrences of each unique error code (format ABC-1234) in the file. Sketch the approach and its memory profile.' },
  { id: 'read-note', kind: 'tool', text: 'Read the file notes.txt in the current directory and summarize it in one sentence.', seed: { 'notes.txt': 'Meeting 2026-09-27: latency diagnosis found the agent thinks ~9x longer per step than upstream. Next step is prompt-surface reduction, then re-measure.\n' } },
  { id: 'write-hello', kind: 'tool', text: 'Create a file hello.txt containing exactly the text hi, then read it back to confirm.', seed: {} },
];
// Tool tasks ride the kernel's bash/fs tools in a seeded temp workspace; the
// runner answers the sdk-server policy gate (allow) so file tools never block.

// ---------- shared artifact parsing ----------
function readSessionText(file) {
  if (file.endsWith('.zstd')) return execFileSync(ZSTD, ['-dc', file], { maxBuffer: 1 << 30 }).toString('utf8');
  return fs.readFileSync(file, 'utf8');
}

// v3 sessions carry the system/message content as a plain string; v4 as an
// array of blocks — normalize both to the concatenated text.
function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  }
  return '';
}

function parseArtifactText(text) {
  const events = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const steps = [];
  let sysBytes = 0, tools = null, turns = 0;
  for (const ev of events) {
    if (ev.type === 'turn/start') turns++;
    if (ev.type === 'system/message' && !sysBytes) {
      sysBytes = Buffer.byteLength(messageText(ev?.data?.message?.content));
    }
    if (ev.type === 'request/header' && !tools) {
      const tl = ev?.data?.header?.tools;
      if (Array.isArray(tl)) tools = tl;
    }
    if (ev.type === 'assistant/message') {
      const u = ev.data.usage || {};
      let decodeMs = 0;
      for (const s of Array.isArray(ev.data.stream) ? ev.data.stream : []) {
        if (Array.isArray(s.dt)) decodeMs += s.dt.reduce((a, b) => a + b, 0);
      }
      steps.push({
        input: (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0),
        cacheRead: u.cacheReadTokens ?? 0,
        output: u.outputTokens ?? 0,
        reasoning: u.reasoningTokens ?? 0,
        decodeMs,
      });
    }
  }
  return { steps, turns, sysBytes, tools };
}

function parseArtifact(file) {
  return parseArtifactText(readSessionText(file));
}

// ---------- extraction: app shape from a real session ----------
// Tools the kernel itself mounts in the app's workspace composition; the rest
// of the extracted catalog rides the hostTools bridge.
const KERNEL_TOOLS = new Set([
  'bash', 'read', 'read_image', 'write', 'edit', 'glob', 'grep', 'todo_write',
  'ask_user_question', 'exit_plan_mode', 'subagent', 'interrupt_agent',
  'send_message', 'list_subagent_models', 'web_search', 'web_fetch', 'pwsh',
]);

function findSourceSessionDir(explicit) {
  if (explicit) return explicit;
  const candidates = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/session\.v\d+\.jsonl(\.zstd)?$/.test(e.name)) candidates.push(p);
    }
  };
  walk(IDBOTS_SESSIONS_ROOT);
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const file of candidates.slice(0, 60)) {
    try {
      const parsed = parseArtifact(file);
      if ((parsed.tools?.length ?? 0) >= 30 && parsed.sysBytes > 10_000) return path.dirname(file);
    } catch { /* skip unreadable */ }
  }
  throw new Error('no source session with >=30 tools and a system baseline found; pass --extract-from <sessionDir>');
}

function extractAppShape(sessionDir) {
  const artifact = fs.readdirSync(sessionDir).find((f) => /session\.v\d+\.jsonl/.test(f));
  const text = readSessionText(path.join(sessionDir, artifact));
  const parsed = parseArtifactText(text);
  let systemText = '';
  for (const ev of text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)) {
    if (ev.type === 'system/message') {
      const joined = messageText(ev?.data?.message?.content);
      if (joined.length > 0) { systemText = joined; break; }
    }
  }
  if (!systemText) throw new Error('source session has no system/message baseline');
  const hostTools = (parsed.tools ?? [])
    .filter((t) => !KERNEL_TOOLS.has(t.name))
    // The artifact redacts input_schema; a permissive schema keeps name+description
    // (the byte-dominant, behavior-shaping part) faithful.
    .map((t) => ({ name: t.name, description: t.description ?? '', parameters: { type: 'object', additionalProperties: true } }));
  return {
    systemText,
    hostTools,
    kernelToolCount: (parsed.tools ?? []).filter((t) => KERNEL_TOOLS.has(t.name)).length,
    sourceSessionDir: sessionDir,
  };
}

// ---------- idbots DB key ----------
function readDeepSeekKey() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(IDBOTS_DB, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key = 'app_config'").get();
    const cfg = JSON.parse(row?.value ?? '{}');
    const deep = cfg?.providers?.deepseek;
    if (!deep?.apiKey) throw new Error('providers.deepseek.apiKey missing in app_config');
    return deep.apiKey;
  } finally {
    db.close();
  }
}

function makeWorkspace(task) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `ab-ws-${task.id}-`));
  for (const [name, content] of Object.entries(task.seed ?? {})) {
    fs.writeFileSync(path.join(ws, name), content);
  }
  return ws;
}

// ---------- stock composition (translated from deepseek-harness base bundle) ----------
// Request-shaping rows only; UI/telemetry/storage rows are omitted. bash/fs
// ride the same dsh-*-local providers the IDBots composition uses (identical
// tool schemas, no sandbox wrapper) so both sides execute tools the same way.
function stockEntries({ sessionRoot, ws }) {
  return [
    { id: 'sessions', name: '@deepseek-ai/dsh-session' },
    { id: 'tools', name: '@deepseek-ai/dsh-tools' },
    { id: 'llm', name: '@deepseek-ai/dsh-llm' },
    // Stock deployment keeps the harness identity section ON (one sentence);
    // the IDBots composition turns it off and ships personas instead.
    { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt', config: { personaPrefix: '' } },
    { id: 'agent', name: '@deepseek-ai/dsh-agent' },
    { id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop', config: { agents: [] } },
    { id: 'llm-retry', name: '@deepseek-ai/dsh-llm-retry' },
    { id: 'session-projection', name: '@deepseek-ai/dsh-session-projection' },
    { id: 'token-meter', name: '@deepseek-ai/dsh-token-meter' },
    { id: 'session-title', name: '@deepseek-ai/dsh-session-title', config: { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 } },
    { id: 'session-title-llm', name: '@deepseek-ai/dsh-session-title-first-prompt-llm', config: { targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 4096, maxOutputTokens: 64, timeoutMs: 60000 } },
    // The stock plan-mode section text (the base bundle passes it verbatim;
    // the package ships no default). Same text the IDBots generator inlines.
    {
      id: 'plan-mode',
      name: '@deepseek-ai/dsh-plan-mode',
      config: {
        section: [
          'You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user\'s conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.',
          '',
          'Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.',
          '',
          'The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed only to keep the request shape stable. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.',
          '',
          'Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.',
          '',
          'Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.',
          '',
          'When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.',
        ].join('\n'),
      },
    },
    { id: 'repeat-tool-reminder', name: '@deepseek-ai/dsh-repeat-tool-reminder', config: { thresholds: [3, 5, 8], argumentsPreviewChars: 500 } },
    { id: 'timeout-policy', name: '@deepseek-ai/dsh-tool-call-timeout-policy' },
    { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
    { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner', config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 } },
    { id: 'persistence', name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: sessionRoot, compression: 'none' } },
    { id: 'checkpoint-policy', name: '@deepseek-ai/dsh-session-checkpoint-policy' },
    { id: 'user-approval', name: '@deepseek-ai/dsh-user-approval', config: { policy: 'never' } },
    { id: 'user-questions', name: '@deepseek-ai/dsh-user-questions' },
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    { id: 'attachment-local', name: '@deepseek-ai/dsh-attachment-local' },
    { id: 'shell-env', name: '@deepseek-ai/dsh-shell-env' },
    { id: 'subprocess', name: '@deepseek-ai/dsh-subprocess-local' },
    { id: 'spill-local', name: '@deepseek-ai/dsh-spill-local' },
    { id: 'spill-policy', name: '@deepseek-ai/dsh-spill-policy', config: { maxInlineTokens: 12500 } },
    { id: 'bash', name: '@deepseek-ai/dsh-bash-local', config: { cwd: ws, timeoutMs: 60000 } },
    { id: 'fs-local', name: '@deepseek-ai/dsh-fs-local', config: { cwd: ws } },
    { id: 'fs-observation-policy', name: '@deepseek-ai/dsh-fs-observation-policy' },
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
    { id: 'skill', name: '@deepseek-ai/dsh-skill' },
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
    { id: 'goal', name: '@deepseek-ai/dsh-goal' },
    { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
    { id: 'jobs', name: '@deepseek-ai/dsh-jobs-local' },
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
    { id: 'subagent', name: '@deepseek-ai/dsh-subagent' },
    { id: 'subagent-spawn-in-process', name: '@deepseek-ai/dsh-subagent-spawn-in-process', config: { providerName: 'spawn' } },
    { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
    { id: 'tool-subagent-list-agents', name: '@deepseek-ai/dsh-tool-subagent-control/list-agents' },
    { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'spawn', toolName: 'subagent', backgroundMode: 'continuable' } },
    { id: 'web', name: '@deepseek-ai/dsh-web', config: { searchProvider: 'deepseek-official', fetchProvider: 'http' } },
    { id: 'web-search-deepseek', name: '@deepseek-ai/dsh-web-search-deepseek', config: { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
    { id: 'web-fetch-http', name: '@deepseek-ai/dsh-web-fetch-http' },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
    // Thinking on at effort high — matches both projects' daily-driver
    // settings (IDBots generator pins it; the user's harness profile sets
    // agent-default-model.reasoningEffort: high).
    { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key', config: { thinking: 'enabled', reasoningEffort: 'high' } },
    // Neutral stdio JSON-RPC server (the stock CLI drives the composition
    // in-process; this layer only exposes the wire protocol — with no config
    // it registers no host tools and no prompt sections).
    { id: 'sdk-server', name: path.join(REPO, 'dsh-runtime/plugins/idbots-sdk-server.mjs'), config: {} },
  ];
}

// ---------- unified composition runner ----------
async function runComposition({ label, entries, childEnv, ws, task, run, promptMode }) {
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ab-${label}-root-`));
  const dshHome = path.join(sessionRoot, 'dsh-home');
  fs.mkdirSync(dshHome, { recursive: true });
  const configPath = path.join(sessionRoot, 'ab.runtime.json');
  fs.writeFileSync(configPath, JSON.stringify(entries(sessionRoot), null, 2));

  const { HarnessClient } = await import(pathToFileURL(path.join(REPO, 'dsh-runtime/node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js')).href);
  const client = new HarnessClient({}, {
    command: process.execPath,
    args: [path.join(REPO, 'dsh-runtime/bin.mjs'), configPath],
    environment: () => ({ ...process.env, ...childEnv, DSH_HOME: dshHome }),
    initializeTimeoutMs: 90_000,
  });

  const sessionId = `ab-${label}-${task.id}-${run}-${Date.now().toString(36)}`;
  const startedAt = Date.now();
  const pump = (async () => {
    const sub = client.subscribe();
    try {
      for (;;) {
        const notification = await sub.next();
        const method = notification?.method;
        const params = notification?.params ?? {};
        if (method === 'idbots/tool/request') {
          await client.request('idbots/tool/respond', { id: params.id, ok: false, error: '[ab-benchmark] this host tool is unavailable in the benchmark harness — for file tasks use the built-in read/write/glob/grep/bash tools instead, then finish the task' }).catch(() => {});
        } else if (method === 'idbots/policy/request') {
          await client.request('idbots/policy/respond', { id: params.id, decision: 'allow' }).catch(() => {});
        } else if (method === 'idbots/approval/request') {
          await client.request('idbots/approval/respond', { id: params.id, outcome: 'allowed-once' }).catch(() => {});
        } else if (method === 'idbots/ask/request') {
          const first = Array.isArray(params.questions) ? params.questions[0] : null;
          await client.request('idbots/ask/respond', { id: params.id, answers: first ? [{ questionId: first.id ?? first.questionId ?? '', answer: 'benchmark: proceed with your best judgment' }] : [] }).catch(() => {});
        }
      }
    } catch { /* subscription closes at shutdown — expected */ }
  })();

  const fail = (error) => ({ side: label, task: task.id, run, ok: false, wallMs: Date.now() - startedAt, error, steps: [], turns: 0, sysBytes: 0, toolCount: 0 });
  try {
    await client.initialize({ cwd: ws, provider: 'deepseek-official', model });
    if (promptMode === 'idbots') {
      await client.request('session/ensure', { sessionId, provider: 'deepseek-official', model, cwd: ws });
      await client.request('idbots/prompt', { sessionId, text: task.text, clientTimeZone: 'Asia/Shanghai' });
    } else {
      await client.prompt(sessionId, [{ type: 'text', text: task.text }]);
    }

    const artifact = await waitForTurnEnd(sessionRoot, sessionId, TASK_TIMEOUT_MS);
    await sleep(1_000);
    const parsed = parseArtifact(artifact);
    return {
      side: label, task: task.id, run, ok: true,
      wallMs: Date.now() - startedAt,
      steps: parsed.steps, turns: parsed.turns,
      sysBytes: parsed.sysBytes, toolCount: parsed.tools?.length ?? 0,
      artifact,
    };
  } catch (err) {
    return fail(err?.message ?? String(err));
  } finally {
    await client.request('session/cancel', { sessionId, cause: 'benchmark done' }, 2_000).catch(() => {});
    await Promise.race([
      Promise.resolve(client.close?.()).then((c) => typeof c?.catch === 'function' ? c : Promise.resolve()).catch(() => {}),
      sleep(3_000),
    ]);
    await Promise.race([pump, sleep(1_000)]);
  }
}

function findArtifactFile(sessionRoot, sessionId) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/session\.v\d+\.jsonl(\.zstd)?$/.test(e.name)) found.push(p);
    }
  };
  walk(sessionRoot);
  return found.filter((f) => !sessionId || path.dirname(f).includes(sessionId))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

async function waitForTurnEnd(sessionRoot, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1_000);
    const file = findArtifactFile(sessionRoot, sessionId);
    if (file) {
      try {
        const text = readSessionText(file);
        if (text.includes('"type":"turn/end"') || text.includes('"type": "turn/end"')) return file;
      } catch { /* mid-write */ }
    }
  }
  throw new Error(`timeout after ${timeoutMs}ms waiting for turn/end (session ${sessionId})`);
}

// ---------- reporting ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

function summarize(results) {
  const bySide = {};
  for (const r of results.filter((x) => x.ok && x.steps.length)) {
    const agg = bySide[r.side] ??= { tasks: 0, reasoning: [], output: [], firstInput: [], wallMs: [], sysBytes: [], toolCount: [], decode: [] };
    agg.tasks++;
    agg.reasoning.push(...r.steps.map((s) => s.reasoning));
    agg.output.push(...r.steps.map((s) => s.output));
    agg.firstInput.push(r.steps[0]?.input ?? 0);
    agg.wallMs.push(r.wallMs);
    agg.sysBytes.push(r.sysBytes);
    agg.toolCount.push(r.toolCount);
    for (const s of r.steps) if (s.decodeMs > 0 && s.output > 0) agg.decode.push(s.output / (s.decodeMs / 1000));
  }
  return bySide;
}

// ---------- main ----------
const require = createRequire(import.meta.url);
fs.mkdirSync(outDir, { recursive: true });
const apiKey = readDeepSeekKey();
let shape = null;
if (side !== 'stock') {
  const systemFile = arg('system-file', undefined);
  const hostToolsFile = arg('host-tools-file', undefined);
  if (systemFile || hostToolsFile) {
    // Direct shape override: replay a (possibly patched) system prompt and
    // host-tool catalog from files instead of extracting a live session.
    const base = (!systemFile || !hostToolsFile)
      ? extractAppShape(findSourceSessionDir(arg('extract-from', undefined)))
      : null;
    shape = {
      systemText: systemFile ? fs.readFileSync(systemFile, 'utf8') : base.systemText,
      hostTools: hostToolsFile ? JSON.parse(fs.readFileSync(hostToolsFile, 'utf8')) : base.hostTools,
      kernelToolCount: base?.kernelToolCount ?? 0,
      sourceSessionDir: 'file-override',
    };
  } else {
    shape = extractAppShape(findSourceSessionDir(arg('extract-from', undefined)));
  }
  console.log(`[extract] source=${shape.sourceSessionDir}`);
  console.log(`[extract] systemText=${shape.systemText.length}B hostTools=${shape.hostTools.length} (kernel ~${shape.kernelToolCount})`);
}
const tasks = (() => {
  const file = arg('tasks', undefined);
  return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : DEFAULT_TASKS;
})();

const results = [];
const { generateRuntimeConfig } = await import(pathToFileURL(path.join(REPO, 'dsh-runtime/lib/generate-runtime-config.mjs')).href);
for (const task of tasks) {
  for (let run = 1; run <= runs; run++) {
    if (side !== 'stock') {
      const ws = makeWorkspace(task);
      const sessionRootHolder = { root: null };
      const entries = (sessionRoot) => generateRuntimeConfig({
        sessionRoot,
        providers: [{
          key: 'deepseek-official', apiFormat: 'anthropic', baseUrl: 'https://api.deepseek.com',
          apiKeyEnv: 'IDBOTS_DSH_KEY_DEEPSEEK_OFFICIAL', native: true,
          models: [{ id: model, contextWindow: 1_000_000, maxOutputTokens, input: ['text', 'image'] }],
        }],
        sections: [{ name: 'idbots:base', order: 0, text: shape.systemText }],
        hostTools: shape.hostTools,
        workspace: { cwd: ws },
        persistenceCompression: 'none',
        timeContext: { timeZone: 'Asia/Shanghai', refreshIntervalMs: 600_000 },
      });
      const r = await runComposition({
        label: 'idbots', entries, ws, task, run, promptMode: 'idbots',
        childEnv: { IDBOTS_DSH_KEY_DEEPSEEK_OFFICIAL: apiKey },
      });
      results.push(r);
      console.log(`[idbots] ${task.id}#${run} ok=${r.ok} steps=${r.steps.length} reasoningMed=${med(r.steps.map((s) => s.reasoning))} firstIn=${r.steps[0]?.input ?? '-'} wall=${Math.round(r.wallMs / 100) / 10}s ${r.error ?? ''}`);
    }
    if (side !== 'idbots') {
      const ws = makeWorkspace(task);
      const r = await runComposition({
        label: 'stock', entries: (sessionRoot) => stockEntries({ sessionRoot, ws }), ws, task, run, promptMode: 'stock',
        childEnv: { DEEPSEEK_API_KEY: apiKey },
      });
      results.push(r);
      console.log(`[stock ] ${task.id}#${run} ok=${r.ok} steps=${r.steps.length} reasoningMed=${med(r.steps.map((s) => s.reasoning))} firstIn=${r.steps[0]?.input ?? '-'} wall=${Math.round(r.wallMs / 100) / 10}s ${r.error ?? ''}`);
    }
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
fs.writeFileSync(path.join(outDir, `ab-${stamp}.json`), JSON.stringify({ results, summary: summarize(results) }, null, 2));

const bySide = summarize(results);
console.log('\n===== SUMMARY =====');
for (const [s, agg] of Object.entries(bySide)) {
  console.log(`${s}: tasks=${agg.tasks} steps=${agg.reasoning.length}`);
  console.log(`  first-step input med=${med(agg.firstInput)}  sys bytes med=${med(agg.sysBytes)}  tools med=${med(agg.toolCount)}`);
  console.log(`  reasoning/step p50=${med(agg.reasoning)} p90=${agg.reasoning.length ? [...agg.reasoning].sort((a, b) => a - b)[Math.floor(agg.reasoning.length * 0.9)] : null}`);
  console.log(`  output/step   p50=${med(agg.output)}  decode tok/s med=${Math.round(med(agg.decode) ?? 0)}`);
  console.log(`  wall per task med=${Math.round((med(agg.wallMs) ?? 0) / 100) / 10}s`);
}
console.log(`\nresults -> ${path.join(outDir, `ab-${stamp}.json`)}`);
process.exit(0);
