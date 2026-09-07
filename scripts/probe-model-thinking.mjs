#!/usr/bin/env node
/**
 * Model-thinking onboarding probe: before a NEW model family gets a
 * dshModelReasoning.ts declaration, run this against the provider to learn
 * the endpoint's thinking dialect in one shot — the manual curl matrix from
 * the 2026-09 GLM incident (z.ai flipped its server-side thinking default;
 * undeclared models send no reasoning parameter and GLM narrated its
 * deliberation into the visible text that went on-chain) turned into a
 * repeatable script.
 *
 * For each probe shape it reports: HTTP status, output item kinds (reasoning
 * separate or absent), reasoning tokens, and the message text head so merged
 * deliberation is visible to the eye. Nothing is judged by content heuristics
 * — the report is factual; the human reads it and writes the declaration.
 *
 * Shapes:
 *   responses wire:  bare | pi-ai effort shape (reasoning.effort+summary+include)
 *                    | streaming bare | bare with one function tool
 *   openai wire:     bare | zai thinking:{type:'enabled'} | reasoning_effort
 *                    | streaming bare | bare with one function tool
 *   anthropic wire:  out of scope — dshModelReasoning declares no anthropic
 *                    dialects; the native anthropic path is not probeable here.
 *
 * Usage:
 *   node scripts/probe-model-thinking.mjs --provider custom-zai [--model glm-5.3-flash]
 *        [--db <sqlite path>] [--effort high] [--timeout-ms 120000]
 *
 * Provider row (baseUrl, apiFormat, apiKey) is read from the app's
 * app_config kv; the key is never printed. Exit 0 = report complete.
 */
'use strict';

import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_DB = path.join(os.homedir(), 'Library/Application Support/IDBots/idbots.sqlite');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

const providerKey = argValue('--provider');
if (!providerKey) {
  console.error('usage: probe-model-thinking.mjs --provider <key> [--model <id>] [--db <path>] [--effort high]');
  process.exit(1);
}
const dbPath = argValue('--db') || DEFAULT_DB;
const effort = argValue('--effort') || 'high';
const timeoutMs = Number(argValue('--timeout-ms') || 120_000);

// The incident-shaped conversation: a policy that demands meta-decisions
// (reply or skip a closing message) is exactly what makes a thinking-less
// model narrate its judgment into the text, so the probe exposes the
// failure mode instead of hiding it behind a trivial Q&A prompt.
const PROBE_SYSTEM = [
  'You are a bot in a 1:1 private chat with a peer bot. Policy:',
  '- Reply concisely and naturally.',
  '- Reply in the same language as the latest peer message.',
  '- You do not need to reply to every message; reply only to the latest meaningful message.',
  '- If the latest message is clearly closing content such as "bye", do not reply.',
].join('\n');
const PROBE_USER = '线已闭环，无差异。收。bye';

const TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
};

function loadProvider() {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key = 'app_config'").get();
    if (!row) throw new Error(`no app_config row in ${dbPath}`);
    const providers = JSON.parse(row.value).providers ?? {};
    const provider = providers[providerKey];
    if (!provider) {
      throw new Error(`provider "${providerKey}" not in app_config (have: ${Object.keys(providers).join(', ')})`);
    }
    if (!provider.apiKey) throw new Error(`provider "${providerKey}" has no apiKey`);
    return provider;
  } finally {
    db.close();
  }
}

function responsesUrlOf(base) {
  let normalized = String(base).trim().replace(/\/+$/, '');
  const isDeepSeekHost = /api\.deepseek\.com/i.test(normalized) || providerKey.toLowerCase() === 'deepseek';
  if (isDeepSeekHost) {
    normalized = normalized.replace(/\/anthropic$/, '').replace(/\/v1$/, '');
    return `${normalized}/responses`;
  }
  if (normalized.endsWith('/responses')) return normalized;
  if (normalized.endsWith('/v1')) return `${normalized}/responses`;
  return `${normalized}/v1/responses`;
}

function chatCompletionsUrlOf(base) {
  let normalized = String(base).trim().replace(/\/+$/, '');
  if (normalized.endsWith('/chat/completions')) return normalized;
  if (!/\/v\d+(?:$|\/)/.test(normalized) && !normalized.endsWith('/v1')) normalized += '/v1';
  return `${normalized}/chat/completions`;
}

async function postJson(url, apiKey, body, { stream = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, text };
  } finally {
    clearTimeout(timer);
  }
}

const head = (text, max = 120) => {
  const compact = String(text ?? '').replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
};

function reportResponseShape(label, { status, text }) {
  if (status >= 400) {
    console.log(`  [${label}] HTTP ${status} REJECTED: ${head(text, 200)}`);
    return `${label}:rejected-${status}`;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.log(`  [${label}] HTTP ${status} but body is not JSON: ${head(text, 120)}`);
    return `${label}:non-json`;
  }
  if (data.error) {
    console.log(`  [${label}] HTTP ${status} ERROR BODY: ${head(JSON.stringify(data.error), 200)}`);
    return `${label}:error-body`;
  }
  const items = data.output ?? [];
  const kinds = items.map((item) => item.type).join(',') || '(empty)';
  let message = '';
  for (const item of items) {
    if (item.type === 'message') {
      message = (item.content ?? []).filter((c) => c.type === 'output_text' || c.type === 'text').map((c) => c.text ?? '').join('');
    }
  }
  const reasoningTokens = data.usage?.output_tokens_details?.reasoning_tokens;
  const verdict = kinds.includes('reasoning')
    ? (message ? 'SEPARATE (reasoning item + clean message)' : 'REASONING_ONLY (no message — model declined to answer?)')
    : (message ? 'NO_REASONING_ITEM (deliberation, if any, lives in the message text)' : 'EMPTY output');
  console.log(`  [${label}] HTTP ${status} kinds=[${kinds}] reasoning_tokens=${reasoningTokens ?? '?'} → ${verdict}`);
  console.log(`      text: ${head(message)}`);
  return `${label}:${message ? (kinds.includes('reasoning') ? 'separate' : 'no-reasoning-item') : 'no-message'}`;
}

async function probeResponses(provider, model, url, apiKey) {
  console.log(`\n== responses wire == ${url}`);
  const base = (extra = {}) => ({
    model, stream: false, max_output_tokens: 1024, store: false,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: PROBE_SYSTEM }] },
      { role: 'user', content: [{ type: 'input_text', text: PROBE_USER }] },
    ],
    ...extra,
  });
  const results = [];
  results.push(reportResponseShape('bare', await postJson(url, apiKey, base())));
  results.push(reportResponseShape('effort(pii-shape)', await postJson(url, apiKey, base({
    reasoning: { effort, summary: 'auto' },
    include: ['reasoning.encrypted_content'],
  }))));
  results.push(reportResponseShape('tools', await postJson(url, apiKey, base({ tools: [TOOL] }))));

  // Streaming: tally SSE event families — reasoning deltas vs output text deltas.
  console.log('  [stream-bare] streaming…');
  const streamBody = base({ stream: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(streamBody),
      signal: controller.signal,
    });
    if (response.status >= 400 || !response.body) {
      const text = await response.text().catch(() => '');
      console.log(`  [stream-bare] HTTP ${response.status} REJECTED: ${head(text, 200)}`);
      results.push('stream-bare:rejected');
    } else {
      const counts = new Map();
      let completedKinds = '';
      let completedText = '';
      const handleLine = (rawLine) => {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (line.startsWith('event: ')) {
          const name = line.slice(7).trim();
          counts.set(name, (counts.get(name) ?? 0) + 1);
        } else if (line.startsWith('data: ') && line.includes('response.completed')) {
          try {
            const payload = JSON.parse(line.slice(6));
            const items = payload.response?.output ?? [];
            completedKinds = items.map((i) => i.type).join(',') || '(empty)';
            for (const item of items) {
              if (item.type === 'message') {
                completedText = (item.content ?? []).filter((c) => c.type === 'output_text' || c.type === 'text').map((c) => c.text ?? '').join('');
              }
            }
          } catch { /* partial data payload */ }
        }
      };
      // Body chunks are Uint8Arrays that may split SSE lines mid-boundary:
      // decode incrementally and consume only complete lines.
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let newlineAt;
        while ((newlineAt = buffer.indexOf('\n')) >= 0) {
          handleLine(buffer.slice(0, newlineAt));
          buffer = buffer.slice(newlineAt + 1);
        }
      }
      if (buffer.trim()) handleLine(buffer.trim());
      const reasoningEvents = [...counts.keys()].filter((n) => n.includes('reasoning')).length;
      const textEvents = counts.get('response.output_text.delta') ?? 0;
      const verdict = reasoningEvents > 0
        ? `SEPARATE (${reasoningEvents} reasoning event kinds, ${textEvents} text deltas)`
        : 'NO_REASONING_EVENTS (thinking did not stream separately)';
      console.log(`  [stream-bare] events=${counts.size} kinds=[${completedKinds}] → ${verdict}`);
      console.log(`      text: ${head(completedText)}`);
      results.push(`stream-bare:${reasoningEvents > 0 ? 'separate' : 'no-reasoning'}`);
    }
  } finally {
    clearTimeout(timer);
  }
  return results;
}

async function probeChatCompletions(provider, model, url, apiKey) {
  console.log(`\n== openai (chat completions) wire == ${url}`);
  const base = (extra = {}) => ({
    model, stream: false, max_tokens: 1024,
    messages: [
      { role: 'system', content: PROBE_SYSTEM },
      { role: 'user', content: PROBE_USER },
    ],
    ...extra,
  });
  const results = [];
  const report = async (label, body) => {
    const { status, text } = await postJson(url, apiKey, body);
    if (status >= 400) {
      console.log(`  [${label}] HTTP ${status} REJECTED: ${head(text, 200)}`);
      results.push(`${label}:rejected-${status}`);
      return;
    }
    let data;
    try { data = JSON.parse(text); } catch { console.log(`  [${label}] non-JSON: ${head(text, 120)}`); results.push(`${label}:non-json`); return; }
    const choice = data.choices?.[0]?.message ?? {};
    const reasoning = choice.reasoning_content ?? choice.reasoning;
    const content = choice.content ?? '';
    const verdict = reasoning
      ? 'SEPARATE (reasoning_content + message)'
      : (content ? 'NO_REASONING_FIELD (deliberation, if any, lives in content)' : 'EMPTY choice');
    console.log(`  [${label}] HTTP ${status} reasoning_len=${(reasoning ?? '').length} → ${verdict}`);
    if (reasoning) console.log(`      reasoning head: ${head(reasoning)}`);
    console.log(`      content: ${head(content)}`);
    results.push(`${label}:${reasoning ? 'separate' : 'no-reasoning-field'}`);
  };
  await report('bare', base());
  await report("zai-thinking(thinking:{type:'enabled'})", base({ thinking: { type: 'enabled', clear_thinking: false } }));
  await report(`openai-reasoning-effort(reasoning_effort:'${effort}')`, base({ reasoning_effort: effort }));
  await report('tools', base({ tools: [TOOL] }));

  console.log('  [stream-bare] streaming…');
  const { status, text } = await postJson(url, apiKey, base({ stream: true }));
  if (status >= 400) {
    console.log(`  [stream-bare] HTTP ${status} REJECTED: ${head(text, 200)}`);
    results.push('stream-bare:rejected');
  } else {
    const reasoningDeltas = (text.match(/"reasoning_content"\s*:/g) ?? []).length;
    const contentDeltas = (text.match(/"content"\s*:/g) ?? []).length;
    const verdict = reasoningDeltas > 0
      ? `SEPARATE (${reasoningDeltas} reasoning_content chunks, ${contentDeltas} content chunks)`
      : 'NO reasoning_content chunks in stream';
    console.log(`  [stream-bare] HTTP ${status} → ${verdict}`);
    results.push(`stream-bare:${reasoningDeltas > 0 ? 'separate' : 'no-reasoning'}`);
  }
  return results;
}

const provider = loadProvider();
const model = argValue('--model') || provider.models?.[0]?.id;
if (!model) {
  console.error(`provider "${providerKey}" lists no models; pass --model <id>`);
  process.exit(1);
}
console.log(`probe-model-thinking: provider=${providerKey} model=${model} apiFormat=${provider.apiFormat} effort=${effort}`);
console.log(`db=${dbPath}`);
console.log(`probe prompt deliberately invites a reply-or-skip meta-decision (the 2026-09 leak shape); read "text:" lines for narrated deliberation.`);

let results = [];
if (provider.apiFormat === 'responses') {
  results = await probeResponses(provider, model, responsesUrlOf(provider.baseUrl), provider.apiKey);
} else if (provider.apiFormat === 'openai') {
  results = await probeChatCompletions(provider, model, chatCompletionsUrlOf(provider.baseUrl), provider.apiKey);
} else {
  console.log(`apiFormat "${provider.apiFormat}" is out of scope: dshModelReasoning.ts declares no anthropic dialects (native adapter / another thinking wire).`);
  process.exit(2);
}

console.log('\n== summary ==');
for (const line of results) console.log(`  ${line}`);
console.log('\nNext: write the family declaration in src/main/libs/dshModelReasoning.ts from the ACCEPTED shapes above');
console.log('(reasoningEfforts wire values = the param the endpoint honored), then run tests/dshRuntimeGlmResponsesBoot.test.mjs');
console.log('as the template for a real-boot smoke of the new declaration.');
