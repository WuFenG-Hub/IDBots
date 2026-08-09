/**
 * Wiring tests for upstream visibility (which provider a session REALLY
 * hits):
 *  - the runner records the resolved provider key + upstream base URL on the
 *    active session in both local and sandbox paths, and logs it;
 *  - accumulateResultUsage persists them into usageStats so the usage panel
 *    can show the upstream row across restarts;
 *  - the usage chip renders the upstream row from those fields (zh + en i18n).
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

test('runner records and logs the resolved upstream provider in local mode', () => {
  const source = read('src/main/libs/coworkRunner.ts');
  const body = methodBody(source, 'private async runClaudeCodeLocal(');
  assert.ok(
    body.includes('activeSession.upstreamProvider = apiConfig.provider'),
    'local run must record the provider key'
  );
  assert.ok(
    body.includes('activeSession.upstreamBaseURL = apiConfig.upstreamBaseURL'),
    'local run must record the upstream base URL'
  );
  // A log line makes the upstream visible in cowork.log without the UI.
  assert.ok(
    body.includes("'Resolved API config for session'"),
    'local run must log the resolved API config'
  );
  assert.ok(
    body.includes('provider: apiConfig.provider') && body.includes('upstreamBaseURL: apiConfig.upstreamBaseURL'),
    'the log must carry provider + upstream URL'
  );
});

test('runner records the resolved upstream provider in sandbox mode', () => {
  const source = read('src/main/libs/coworkRunner.ts');
  const body = methodBody(source, 'private async runClaudeCodeInSandbox(');
  assert.ok(
    body.includes('activeSession.upstreamProvider = apiConfig.provider'),
    'sandbox run must record the provider key'
  );
  assert.ok(
    body.includes('activeSession.upstreamBaseURL = apiConfig.upstreamBaseURL'),
    'sandbox run must record the upstream base URL'
  );
});

test('accumulateResultUsage persists upstream identity into usageStats', () => {
  const source = read('src/main/libs/coworkRunner.ts');
  const body = methodBody(source, 'private accumulateResultUsage(');
  assert.ok(
    body.includes('upstreamProvider: this.activeSessions.get(sessionId)?.upstreamProvider ?? prev.upstreamProvider'),
    'usageStats must carry the provider key across turns'
  );
  assert.ok(
    body.includes('upstreamBaseURL: this.activeSessions.get(sessionId)?.upstreamBaseURL ?? prev.upstreamBaseURL'),
    'usageStats must carry the upstream URL across turns'
  );
  // The ActiveSession usageStats type declares the fields.
  assert.ok(
    source.includes("upstreamProvider?: string;"),
    'ActiveSession usageStats type must declare upstreamProvider'
  );
});

test('usage chip renders the upstream row with zh and en i18n', () => {
  const chip = read('src/renderer/components/cowork/UsageStatsChip.tsx');
  assert.ok(
    chip.includes("usageStats.upstreamProvider?.trim()"),
    'chip must read the persisted provider key'
  );
  assert.ok(
    chip.includes("i18nService.t('coworkUsageUpstream')"),
    'chip must render the upstream row label'
  );
  const i18n = read('src/renderer/services/i18n.ts');
  const zh = i18n.includes("coworkUsageUpstream: '上游链路'");
  const en = i18n.includes("coworkUsageUpstream: 'Upstream'");
  assert.ok(zh && en, 'coworkUsageUpstream must exist in both zh and en dictionaries');
});

test('renderer usage stats type declares upstream fields', () => {
  const types = read('src/renderer/types/cowork.ts');
  assert.ok(types.includes('upstreamProvider?: string'), 'renderer CoworkUsageStats must declare upstreamProvider');
  assert.ok(types.includes('upstreamBaseURL?: string'), 'renderer CoworkUsageStats must declare upstreamBaseURL');
});
