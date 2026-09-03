#!/usr/bin/env node
/**
 * team-builder skill script: parse a Worker Bot role-card pin body into a
 * normalized, metabot_create-ready JSON view. Dual-compat with card schema
 * v1 (model_advice is free text) and v1.1 (model_advice is structured).
 *
 * Usage:
 *   node parse_role_card.js --file /path/to/card.md
 *   cat card.md | node parse_role_card.js
 *
 * Input: the pin's markdown body (the ```json block inside is extracted).
 * Output: one JSON object on stdout (exit 1 + stderr on parse failure).
 */
'use strict';

const fs = require('fs');

function readInput() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1]) {
      return fs.readFileSync(args[i + 1], 'utf-8');
    }
  }
  return fs.readFileSync(0, 'utf-8');
}

/** Extract the LAST ```json fenced block (machine-readable config sits at the card bottom). */
function extractJsonBlock(markdown) {
  const blocks = [...markdown.matchAll(/```json\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (blocks.length === 0) return null;
  return blocks[blocks.length - 1];
}

const STRUCTURED_MODEL_KEYS = ['llm_id', 'llm_provider', 'fallback_llm_id', 'fallback_llm_provider'];

function normalizeModelAdvice(raw) {
  if (raw == null) return { structured: null, raw_text: null, needs_mapping: false };
  if (typeof raw === 'string') {
    // Schema v1: free text (e.g. "快检索+强综合模型（如 glm-5.3-flash），配 deepseek 类 fallback").
    // The Twin must map it to a concrete model id from metabot_list before create.
    return { structured: null, raw_text: raw, needs_mapping: true };
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    // Schema v1.1: structured advice aligned with metabot_create params.
    const structured = {};
    for (const key of STRUCTURED_MODEL_KEYS) {
      if (typeof raw[key] === 'string' && raw[key].trim()) structured[key] = raw[key].trim();
    }
    if (!structured.llm_id) {
      return { structured: null, raw_text: JSON.stringify(raw), needs_mapping: true };
    }
    return { structured, raw_text: null, needs_mapping: false };
  }
  return { structured: null, raw_text: String(raw), needs_mapping: true };
}

function normalizeLocaleBlock(block) {
  if (block == null || typeof block !== 'object') return null;
  const out = {};
  for (const key of ['role', 'bio', 'soul', 'goal']) {
    out[key] = typeof block[key] === 'string' && block[key].trim() ? block[key].trim() : null;
  }
  return out;
}

function main() {
  const markdown = readInput();
  const jsonText = extractJsonBlock(markdown);
  if (!jsonText) {
    console.error('No ```json fenced block found in the card body.');
    process.exit(1);
  }
  let card;
  try {
    card = JSON.parse(jsonText);
  } catch (err) {
    console.error(`Card JSON block failed to parse: ${err.message}`);
    process.exit(1);
  }
  if (card == null || typeof card !== 'object' || Array.isArray(card)) {
    console.error('Card JSON block is not an object.');
    process.exit(1);
  }

  const schemaTag = typeof card.schema === 'string' ? card.schema : '';
  const modelAdvice = normalizeModelAdvice(card.model_advice);
  // Schema version: explicit @1.1 wins; otherwise infer from the advice shape.
  let schemaVersion;
  if (/@1\.1$/.test(schemaTag) || (!schemaTag && modelAdvice.structured)) schemaVersion = '1.1';
  else if (/@1$/.test(schemaTag) || schemaTag) schemaVersion = '1';
  else schemaVersion = modelAdvice.structured ? '1.1' : '1';

  const skillsAdvice = Array.isArray(card.skills_advice)
    ? card.skills_advice.map((s) => String(s).trim()).filter(Boolean)
    : [];

  const output = {
    ok: true,
    schema: schemaTag || `idbots/workerbot-role-card@${schemaVersion}`,
    schema_version: schemaVersion,
    card_id: typeof card.card_id === 'string' ? card.card_id : null,
    origin: typeof card.origin === 'string' ? card.origin : null,
    for_tools: Array.isArray(card.for_tools) ? card.for_tools : ['metabot_create', 'metabot_update'],
    keywords: Array.isArray(card.keywords) ? card.keywords.map(String) : [],
    scenarios: Array.isArray(card.scenarios) ? card.scenarios.map(String) : [],
    zh: normalizeLocaleBlock(card.zh),
    en: normalizeLocaleBlock(card.en),
    model_advice: modelAdvice,
    skills_advice: skillsAdvice,
    // Reminder for the PROPOSE step: bundled skills (web-search, scheduled-task,
    // playwright, ...) are available to every bot by default and are silently
    // dropped from assignment — do NOT sell them as an install step.
    bundled_skills_hint: 'bundled skills need no assignment; only user-directory skills go through assignment',
  };

  if (!output.zh && !output.en) {
    console.error('Card has neither a zh nor an en configuration block.');
    process.exit(1);
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main();
