/**
 * Wiring tests for provider-aware usage accounting (billing source):
 *  - static source assertions (style of coworkToolResultSnipWiring.test.mjs)
 *    that the runner resolves the billing source from the API config in both
 *    local and sandbox run paths, and that usage accumulation no longer
 *    hardcodes 'deepseek';
 *  - runtime checks against the compiled proxy for resolveCoworkBillingSource
 *    semantics (strict: gateway providers serving deepseek models are NOT
 *    DeepSeek-billed).
 * Requires `npm run compile:electron` to have run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

async function importCompiled(modulePath) {
  try {
    return await import(`../dist-electron/main/libs/${modulePath}.js`);
  } catch {
    return await import(`../dist-electron/libs/${modulePath}.js`);
  }
}

function methodBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing ${signature}`);
  const rest = source.slice(start + signature.length);
  const nextMethod = rest.search(/\n  (?:private|public|protected) /);
  return nextMethod >= 0 ? rest.slice(0, nextMethod) : rest;
}

// ---------------------------------------------------------------------------
// Static wiring
// ---------------------------------------------------------------------------

test('usage accumulation no longer hardcodes source to deepseek', () => {
  const source = read('src/main/libs/coworkRunner.ts');
  const accumulateBody = methodBody(source, 'private accumulateResultUsage(');
  // The old bug: any session with usage was labeled 'deepseek' regardless of
  // the actual provider. Must be gone.
  assert.ok(
    !accumulateBody.includes("prev.source === 'none' ? 'deepseek'"),
    'accumulateResultUsage must not default source to deepseek'
  );
  // The new behavior: source comes from the run-start billing source, with a
  // neutral 'other' fallback instead of 'deepseek'.
  assert.ok(
    accumulateBody.includes('?.billingSource'),
    'accumulateResultUsage must read billingSource from the active session'
  );
  assert.ok(
    accumulateBody.includes("prev.source === 'none' ? 'other'"),
    'unknown providers must fall back to other, not deepseek'
  );
});

test('runner resolves billingSource from the API config in local and sandbox run paths', () => {
  const source = read('src/main/libs/coworkRunner.ts');
  const localBody = methodBody(source, 'private async runDshSessionLocal(');
  const sandboxBody = methodBody(source, 'private async runClaudeCodeInSandbox(');
  assert.ok(
    localBody.includes('activeSession.billingSource = resolveCoworkBillingSource('),
    'DSH local run must record the billing source at run start'
  );
  assert.ok(
    localBody.includes('route.provider') && localBody.includes('route.baseUrl'),
    'DSH billing source must come from the resolved provider route'
  );
  assert.ok(
    sandboxBody.includes('activeSession.billingSource = resolveCoworkBillingSource('),
    'sandbox run must record the billing source at run start'
  );
  assert.ok(
    sandboxBody.includes('apiConfig.provider') && sandboxBody.includes('apiConfig.upstreamBaseURL'),
    'sandbox billing source must come from the resolved API config'
  );
});

test('usageStats source type admits other for gateway/plan providers', () => {
  const runnerSource = read('src/main/libs/coworkRunner.ts');
  assert.ok(
    runnerSource.includes("source: 'deepseek' | 'anthropic' | 'other' | 'none'"),
    'ActiveSession usageStats source type must include other'
  );
  const rendererTypes = read('src/renderer/types/cowork.ts');
  assert.ok(
    rendererTypes.includes("source: 'deepseek' | 'anthropic' | 'other' | 'none'"),
    'renderer CoworkUsageStats source type must include other'
  );
});

test('usage chip hides cost and DeepSeek balance for other providers', () => {
  const source = read('src/renderer/components/cowork/UsageStatsChip.tsx');
  // DeepSeek balance row is gated on the deepseek source only.
  assert.ok(source.includes('{isDeepSeek && ('), 'balance row must stay DeepSeek-only');
  // Non-DeepSeek cost is only shown for anthropic (SDK-priced); 'other' gets 0.
  assert.ok(
    source.includes(": usageStats.source === 'anthropic'"),
    'cost estimate must key on the real billing source'
  );
  assert.ok(
    source.includes('const cacheIncludedInInput = usageStats.source !== \'anthropic\''),
    'token total semantics must key on Anthropic-native vs everything else'
  );
});

// ---------------------------------------------------------------------------
// Runtime behavior of the billing-source resolver
// ---------------------------------------------------------------------------

test('resolveCoworkBillingSource: deepseek provider/host are deepseek-billed', async () => {
  const proxy = await importCompiled('coworkOpenAICompatProxy');
  assert.equal(proxy.resolveCoworkBillingSource('deepseek', 'https://api.deepseek.com/v1'), 'deepseek');
  assert.equal(proxy.resolveCoworkBillingSource('DeepSeek', 'https://api.deepseek.com/v1'), 'deepseek');
  // Custom provider whose base URL is the DeepSeek host.
  assert.equal(proxy.resolveCoworkBillingSource('custom', 'https://api.deepseek.com'), 'deepseek');
  // DeepSeek native without explicit base URL.
  assert.equal(proxy.resolveCoworkBillingSource('deepseek', undefined), 'deepseek');
});

test('resolveCoworkBillingSource: gateway providers are NOT deepseek-billed even for deepseek models', async () => {
  const proxy = await importCompiled('coworkOpenAICompatProxy');
  // opencode "Console Go" serving deepseek-v4-flash: plan/per-request billing.
  assert.equal(proxy.resolveCoworkBillingSource('opencode', 'https://opencode.ai/zen/go/v1'), 'other');
  assert.equal(proxy.resolveCoworkBillingSource('openrouter', 'https://openrouter.ai/api/v1'), 'other');
  assert.equal(proxy.resolveCoworkBillingSource('custom', 'https://gateway.example.com/v1'), 'other');
  assert.equal(proxy.resolveCoworkBillingSource('ollama', 'http://127.0.0.1:11434'), 'other');
  assert.equal(proxy.resolveCoworkBillingSource(undefined, undefined), 'other');
});

test('resolveCoworkBillingSource: anthropic provider is anthropic-billed', async () => {
  const proxy = await importCompiled('coworkOpenAICompatProxy');
  assert.equal(proxy.resolveCoworkBillingSource('anthropic', 'https://api.anthropic.com'), 'anthropic');
});
