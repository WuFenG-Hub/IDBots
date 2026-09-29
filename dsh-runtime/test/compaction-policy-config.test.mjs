// Per-route compaction policy config: generate-runtime-config emits one
// compaction-basic modelPolicies entry per provider/model route with a
// window-scaled headroom (8% of the window, clamped to [4K, 64K]). The
// upstream flat 64K headroom is sized for 1M-class windows; on small-window
// routes the pressure budget (window - reservedOutput - headroom) goes
// non-positive and proactive compaction silently disables itself via
// TargetPressureConfigError (the 2026-09-30 space-bunny-free incident).
//
// Run: node test/compaction-policy-config.test.mjs   (from dsh-runtime/)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateRuntimeConfig } from '../lib/generate-runtime-config.mjs'

const compactionEntry = (config) => config.find((entry) => entry.id === 'compaction-basic')
const sessionRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compact-policy-'))

// Scaled headroom: 8% of the window, clamped to [4K, 64K]; globals unchanged.
{
  const root = sessionRoot()
  const config = generateRuntimeConfig({
    sessionRoot: root,
    providers: [
      { key: 'small-gw', apiFormat: 'openai', baseUrl: 'https://a.example/v1', apiKeyEnv: 'K1', models: [{ id: 'm-128k', contextWindow: 128000, maxOutputTokens: 40960 }] },
      { key: 'big-gw', apiFormat: 'openai', baseUrl: 'https://b.example/v1', apiKeyEnv: 'K2', models: [{ id: 'm-1m', contextWindow: 1000000, maxOutputTokens: 256000 }] },
    ],
    sections: [],
  })
  const entryConfig = compactionEntry(config).config
  const policies = entryConfig.modelPolicies
  assert.ok(Array.isArray(policies), 'modelPolicies emitted')
  assert.deepEqual(
    policies.find((p) => p.provider === 'small-gw' && p.model === 'm-128k'),
    { provider: 'small-gw', model: 'm-128k', headroomTokens: 10240 },
  )
  assert.deepEqual(
    policies.find((p) => p.provider === 'big-gw' && p.model === 'm-1m'),
    // 8% of 1M clamps to the 64K ceiling — 1M-class routes keep today's behavior.
    { provider: 'big-gw', model: 'm-1m', headroomTokens: 65536 },
  )
  const { modelPolicies: _ignored, ...globals } = entryConfig
  assert.deepEqual(globals, { thresholdRatio: 0.8, retainRatio: 0.16, maxTokens: 8192, compactionRetries: 1 })
  fs.rmSync(root, { recursive: true, force: true })
  console.log('PASS  per-route headroom scales at 8% of the window, clamped to [4K, 64K]')
}

// Native DeepSeek routes key their policy to the fixed deepseek-official id.
{
  const root = sessionRoot()
  const config = generateRuntimeConfig({
    sessionRoot: root,
    providers: [
      { key: 'deepseek', native: true, apiFormat: 'openai', baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'K1', models: [{ id: 'deepseek-flash', contextWindow: 1000000, maxOutputTokens: 256000 }] },
    ],
    sections: [],
  })
  assert.deepEqual(compactionEntry(config).config.modelPolicies, [
    { provider: 'deepseek-official', model: 'deepseek-flash', headroomTokens: 65536 },
  ])
  fs.rmSync(root, { recursive: true, force: true })
  console.log('PASS  native routes key their policy to deepseek-official')
}

// Sanitized-key collisions dedupe last-wins (duplicate targets fail plugin load).
{
  const root = sessionRoot()
  const config = generateRuntimeConfig({
    sessionRoot: root,
    providers: [
      { key: 'my gw', apiFormat: 'openai', baseUrl: 'https://a.example/v1', apiKeyEnv: 'K1', models: [{ id: 'm', contextWindow: 128000 }] },
      { key: 'my-gw', apiFormat: 'openai', baseUrl: 'https://b.example/v1', apiKeyEnv: 'K2', models: [{ id: 'm', contextWindow: 256000 }] },
    ],
    sections: [],
  })
  const policies = compactionEntry(config).config.modelPolicies
  const matches = policies.filter((p) => p.provider === 'my-gw' && p.model === 'm')
  assert.equal(matches.length, 1, 'colliding route keys dedupe to one policy')
  assert.equal(matches[0].headroomTokens, 20480, 'last route wins, mirroring the routes dict')
  fs.rmSync(root, { recursive: true, force: true })
  console.log('PASS  sanitized-key collisions dedupe last-wins')
}

// No declared window → no policy (the route keeps the global flat headroom).
{
  const root = sessionRoot()
  const config = generateRuntimeConfig({
    sessionRoot: root,
    providers: [
      { key: 'nowin', apiFormat: 'openai', baseUrl: 'https://a.example/v1', apiKeyEnv: 'K1', models: [{ id: 'm' }] },
    ],
    sections: [],
  })
  assert.equal(compactionEntry(config).config.modelPolicies, undefined)
  fs.rmSync(root, { recursive: true, force: true })
  console.log('PASS  models without a context window get no policy entry')
}
