/**
 * Wiring tests for metabot llm_id -> provider routing:
 *  - the session automation model override honors ANY llm_id (not just
 *    'deepseek') so metabots configured for opencode (or other providers)
 *    actually route their CoWork traffic there;
 *  - when the llm_id fails to resolve (provider disabled/removed), the run
 *    tries the bot's fallback brain, then the global default — except the
 *    free-quota relay is never substituted for a non-free brain;
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

test('runDshSessionLocal tries the fallback brain before any default, and refuses the free-quota relay', () => {
  const source = read('src/main/libs/coworkRunner.ts');
  const body = methodBody(source, 'private resolveSessionDshRoute(');
  assert.ok(
    body.includes('Primary brain did not resolve; using the fallback brain'),
    'disabled primary brain must try the bot fallback before the app default'
  );
  assert.ok(
    body.includes('Refusing to bill the free-quota relay for a non-free bot brain'),
    'a paid bot brain must not be rewritten onto IDBots-Free'
  );
  assert.ok(
    body.includes('const defaultRoute = resolveDshProviderRoute()'),
    'non-free defaults may still reuse the global default DSH route'
  );
  const billingBody = methodBody(source, 'private async runDshSessionLocal(');
  const billingIndex = billingBody.indexOf('activeSession.billingSource = resolveCoworkBillingSource(');
  assert.ok(billingIndex >= 0, 'billingSource must be resolved from the DSH route the session actually runs on');
});

test('CoworkRunner getMetabotById wiring passes brain provider, effort, and fallback', () => {
  const source = read('src/main/main.ts');
  const start = source.indexOf('getMetabotById: (id: number) => {');
  assert.ok(start >= 0, 'CoworkRunner getMetabotById mapper is missing');
  const body = source.slice(start, start + 1200);
  assert.ok(body.includes('llm_id: m.llm_id ?? null'), 'mapper must pass llm_id');
  assert.ok(body.includes('llm_provider: m.llm_provider ?? null'), 'mapper must pass llm_provider so DSH can honor the hint');
  assert.ok(body.includes('llm_effort: m.llm_effort ?? null'), 'mapper must pass llm_effort');
  assert.ok(body.includes('fallback_llm_id: m.fallback_llm_id ?? null'), 'mapper must pass fallback_llm_id');
  assert.ok(body.includes('fallback_llm_provider: m.fallback_llm_provider ?? null'), 'mapper must pass fallback_llm_provider');
  assert.ok(body.includes('fallback_llm_effort: m.fallback_llm_effort ?? null'), 'mapper must pass fallback_llm_effort');
});

test('metabot llm_id stays the routing key in the store/UI contract', () => {
  // The renderer models llm_id as the provider key chosen for the metabot.
  const metaBotEdit = read('src/renderer/components/metabots/MetaBotEditTabs.tsx');
  assert.match(metaBotEdit, /llm_id/);
});
