/**
 * Wiring tests for metabot llm_id -> provider routing:
 *  - the session automation model override honors ANY llm_id (not just
 *    'deepseek') so metabots configured for opencode (or other providers)
 *    actually route their CoWork traffic there;
 *  - when the llm_id fails to resolve (provider disabled/removed), the run
 *    falls back to the global default config instead of failing;
 *  - the billing source is resolved AFTER the fallback, from whichever
 *    config the session actually runs on.
 * Style: static source assertions (see coworkBillingSourceWiring.test.mjs).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function methodBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing ${signature}`);
  const rest = source.slice(start + signature.length);
  const nextMethod = rest.search(/\n  (?:private|public|protected) /);
  return nextMethod >= 0 ? rest.slice(0, nextMethod) : rest;
}

test('metabot brain override honors any llm_id, not just deepseek', () => {
  const source = read('src/main/libs/coworkRunner.ts');
  const body = methodBody(source, 'private getSessionAutomationBrain(');
  // The old narrow guard that ignored every llm_id except 'deepseek' must be
  // gone — that is why opencode-configured metabots still billed DeepSeek.
  assert.ok(
    !body.includes("llmId.toLowerCase() === 'deepseek' ? llmId : null"),
    'llm_id must not be narrowed to deepseek only'
  );
  assert.ok(
    body.includes('if (!modelId) return null'),
    'any non-empty brain model id must be returned as the override'
  );
  // Model-level brain: provider hint + effort ride along, plus the fallback
  // brain pair.
  assert.ok(body.includes('providerKey:'), 'brain carries the provider hint');
  assert.ok(body.includes('effort: toLlmEffortLevel('), 'brain carries the normalized effort');
  assert.ok(body.includes('fallbackModelId:'), 'brain carries the fallback brain');
});

test('runClaudeCodeLocal falls back to the global default when llm_id does not resolve', () => {
  const source = read('src/main/libs/coworkRunner.ts');
  const body = methodBody(source, 'private async runClaudeCodeLocal(');
  assert.ok(
    body.includes("if (!apiConfig && automationModelOverride)"),
    'failed override resolution must trigger a fallback path'
  );
  assert.ok(
    body.includes('falling back to the default model config'),
    'the fallback must be logged so routing issues stay diagnosable'
  );
  assert.ok(
    body.includes("apiConfigResolution = { config: getCurrentApiConfig('local') }"),
    'the fallback must reuse the global default config'
  );
  // Billing source is resolved after the fallback, from the config the
  // session actually runs on.
  const billingIndex = body.indexOf('activeSession.billingSource = resolveCoworkBillingSource(');
  const fallbackIndex = body.indexOf('apiConfigResolution = { config: getCurrentApiConfig');
  assert.ok(billingIndex > fallbackIndex && fallbackIndex > 0,
    'billingSource must be resolved after the config (incl. fallback) is final');
});

test('metabot llm_id stays the routing key in the store/UI contract', () => {
  // The renderer models llm_id as the provider key chosen for the metabot.
  const metaBotEdit = read('src/renderer/components/metabots/MetaBotEditTabs.tsx');
  assert.match(metaBotEdit, /llm_id/);
});
