// metaAppGuard: intent gate + alias/fuzzy matching for the local MetaApp
// launcher tools (open_metaapp / resolve_metaapp_url).

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'

const require = Module.createRequire(import.meta.url)
const {
  buildMetaAppAliases,
  metaAppAliasesMentionedInText,
  isExplicitMetaAppUserRequest,
  QUICK_ACTION_MESSAGE_SOURCE,
} = require('../dist-electron/main/libs/metaAppGuard.js')

// The app from the smoke-test report: a chain-community MetaApp whose formal
// name is "Agent 日报 · Agent Internet 门户" while users say "今日门户" etc.
const AGENT_DAILY = { id: 'agent-daily-portal', name: 'Agent 日报 · Agent Internet 门户' }
const AGENT_DAILY_ALIASES = buildMetaAppAliases(AGENT_DAILY)

test('buildMetaAppAliases covers id, spaced id, full name and name segments', () => {
  assert.ok(AGENT_DAILY_ALIASES.includes('agent-daily-portal'))
  assert.ok(AGENT_DAILY_ALIASES.includes('agent daily portal'))
  assert.ok(AGENT_DAILY_ALIASES.includes('agent 日报 · agent internet 门户'))
  assert.ok(AGENT_DAILY_ALIASES.includes('agent 日报'))
  assert.ok(AGENT_DAILY_ALIASES.includes('agent internet 门户'))
})

test('buildMetaAppAliases drops empty and single-char candidates', () => {
  const aliases = buildMetaAppAliases({ id: 'a', name: ' · ' })
  assert.deepEqual(aliases, [])
})

test('generic confirmations never pass the intent gate', () => {
  for (const text of ['好的', '确定', 'ok', 'yes']) {
    assert.equal(isExplicitMetaAppUserRequest(text, 'agent-daily-portal', AGENT_DAILY_ALIASES), false)
  }
})

test('exact app id mention with an intent verb passes', () => {
  assert.equal(
    isExplicitMetaAppUserRequest('请帮我打开 agent-daily-portal', 'agent-daily-portal', AGENT_DAILY_ALIASES),
    true
  )
})

test('alias and fuzzy wording all hit the same app', () => {
  const allowed = [
    '请帮我打开 Agent 日报 · 今日门户，不需要使用任何技能。',
    '打开今日门户',
    '帮我进入日报门户',
    'open the Agent 日报 app please',
  ]
  for (const text of allowed) {
    assert.equal(
      isExplicitMetaAppUserRequest(text, 'agent-daily-portal', AGENT_DAILY_ALIASES),
      true,
      `expected allow: ${text}`
    )
  }
})

test('unrelated turns without app mention or context stay blocked', () => {
  assert.equal(
    isExplicitMetaAppUserRequest('帮我把这个文件整理一下', 'agent-daily-portal', AGENT_DAILY_ALIASES),
    false
  )
  // Intent verb but no app mention and no MetaApp context word.
  assert.equal(
    isExplicitMetaAppUserRequest('打开我昨天下载的那个压缩包', 'agent-daily-portal', AGENT_DAILY_ALIASES),
    false
  )
})

test('without aliases the matcher falls back to the exact app id', () => {
  assert.equal(isExplicitMetaAppUserRequest('打开今日门户', 'agent-daily-portal'), false)
  assert.equal(isExplicitMetaAppUserRequest('请打开 agent-daily-portal', 'agent-daily-portal'), true)
})

test('metaAppAliasesMentionedInText shares CJK runs of 2+ chars', () => {
  assert.equal(metaAppAliasesMentionedInText('今日门户在哪', AGENT_DAILY_ALIASES), true)
  assert.equal(metaAppAliasesMentionedInText('随便聊聊天气', AGENT_DAILY_ALIASES), false)
})

test('quick action source marker constant is stable', () => {
  assert.equal(QUICK_ACTION_MESSAGE_SOURCE, 'quick_action')
})
