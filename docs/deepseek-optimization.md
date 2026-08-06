# DeepSeek Optimization

This document describes the DeepSeek-first optimizations introduced on the
`feat/deepseek-optimization` branch. The goal is to reduce token consumption,
increase context-cache hit rates, and make DeepSeek the natural default across
every auto-invoke path — drawing on techniques from the Reasonix reference
project (Go) and the official DeepSeek Responses API.

## 1. Responses API + Built-in Web Search

### What changed

DeepSeek flash models now use the **Responses API** (`POST /responses`) by
default instead of chat/completions. The Responses API is stateless on
DeepSeek, supports a server-side `web_search` tool, and reports cache tokens
in a nested usage shape.

### Routing

Routing is decided per-request based on the provider and the effective model:

| Provider | Model              | API type          | Endpoint                  |
|----------|--------------------|-------------------|---------------------------|
| deepseek | `deepseek-v4-flash`| `responses`       | `/responses` (host root)  |
| deepseek | `deepseek-v4-pro`  | `chat_completions`| `/v1/chat/completions`    |
| openai   | any                | `responses`       | `/v1/responses`           |
| others   | any                | `chat_completions`| `/v1/chat/completions`    |

DeepSeek Responses lives at the **host root** (`https://api.deepseek.com/responses`)
with no `/v1` prefix, matching the OpenAI-SDK `base_url` convention. The URL
builder strips a trailing `/anthropic` or `/v1` so a base URL configured for
the Anthropic-compat endpoint still resolves correctly.

**Code paths:**

- **Cowork proxy** (Claude Agent SDK sessions, IM gateway):
  `resolveUpstreamAPIType` in `coworkOpenAICompatProxy.ts` routes flash →
  responses. `convertChatCompletionsRequestToResponsesRequest` injects
  `{ type: 'web_search' }` as the first tool and maps `reasoning.effort` from
  the existing `reasoning_effort` / `output_config` / `thinking` controls.

- **Cognitive layer** (orchestrator, private chat, group tasks, browser
  bridge): `shouldUseDeepSeekResponses` in `cognitiveChatCompletion.ts` gates
  the same routing. `callDeepSeekResponsesStyle` builds the Responses request
  (`instructions`, `input`, `tools`, `reasoning`) and parses `output` items
  (`message` / `reasoning` / `web_search_call` / `function_call`).

### Web search

The `web_search` tool is injected as the **first** tool and kept stable across
turns. This is deliberate: DeepSeek's automatic context cache matches the
longest common prefix, so a stable tools array is essential for high hit
rates. `tool_choice` defaults to `'auto'` so the model decides when to search.

### Cache token accounting

The Responses API reports cache tokens differently from chat/completions:

```
chat/completions:  usage.prompt_cache_hit_tokens (top-level)
responses:         usage.input_tokens_details.cached_tokens (nested)
```

Both the non-streaming (`convertResponsesToOpenAIResponse`) and streaming
(`response.completed` event) paths parse the nested field and derive
`prompt_cache_miss_tokens = input_tokens - cached_tokens` so accounting stays
truthful across the two API shapes.

## 2. Thinking + Reasoning Defaults

### Default: Flash + thinking ON + effort max

All DeepSeek automation paths default to **`deepseek-v4-flash`** with thinking
enabled and reasoning effort set to max. This is the project's DeepSeek-first
policy: the flash model is fast enough for interactive use while still
reasoning deeply.

- The flash model preset (`config.ts`) ships with
  `options: { reasoningEffort: 'max', thinking: { type: 'enabled' } }`.
- Existing users inherit these automatically — `normalizeDeepSeekModel` picks
  up canonical options when a stored model has none, so no DB migration is
  needed.
- `DEEPSEEK_AUTOMATION_MODEL_ID` remains `deepseek-v4-flash` (not pro).

### Per-path wiring

| Path | Thinking | Rationale |
|------|----------|-----------|
| Orchestrator replies | `enabled` | Reasoning turns need full thinking |
| Group task chair/worker/owner | `enabled` | Planning + reply turns |
| Private chat main reply | `enabled` | Conversational depth |
| Private chat wait-notice | `disabled` | Short ack, latency-sensitive |
| Private chat rating | `disabled` | Short utility generation |
| Dream service | `disabled` | Output budget needed for JSON, not reasoning |
| Browser bridge game moves | model default | Caller may opt out via `thinking:'disabled'` |

`resolveThinkingForModel` gates by model capability, so non-DeepSeek models
are unaffected by the `thinking: 'enabled'` flag.

### reasoning_content round-trip fix

DeepSeek's thinking API rejects (400) any assistant tool-call message that
lacks the `reasoning_content` key. When the real reasoning is unrecoverable
(process restart, LRU eviction, history from before thinking mode), the proxy
previously injected the text placeholder `'(reasoning unavailable)'`. This
hurt cache stability: different sets of lost-reasoning turns produced
different prefixes.

The placeholder is now an **empty string** (`''`). An empty string is
byte-stable (constant regardless of which turns lost reasoning) and is
accepted by the API. This mirrors Reasonix's `openai.go`, which sends a
pointer to the (possibly empty) `ReasoningContent` field.

## 3. Cache Hit Rate Improvements

DeepSeek has no explicit caching API — the entire strategy is **prefix
discipline**, riding the automatic on-disk context cache. The key principle:
send the full history append-only every turn, and never mutate the stable
prefix (system prompt + tools).

### Deterministic tool ordering

`anthropicToOpenAI` now sorts the tools array by function name before
serialization. The tools prefix is therefore byte-identical across turns
regardless of the caller's map iteration order. Without this, a reordered
tool list would invalidate the entire cached prefix every turn.

### Prefix-stable system prompts

The orchestrator and private-chat system prompts are built from static bot
attributes (name, role, soul) with the conversation context appended at the
end. There are no timestamps or volatile IDs in the system-prompt head, so
the cacheable prefix is preserved across turns.

### Cache-miss attribution

`accumulateResultUsage` in `coworkRunner.ts` tracks a per-session
`cacheMissEvents` trail. Each turn where the provider reports cache-creation
(miss) tokens records `{ turn, reason, missTokens }`:

- **Turn 1**: always `'cold_start'` (nothing was cached yet).
- **Later turns**: `'unknown'` — without diffing the full message history we
  cannot attribute the miss to a specific cause (system change, tools change,
  compaction). A future tiered-compaction subsystem (like Reasonix's) could
  refine this.

The `UsageStatsChip` hover popover shows the session cache-hit rate (%) and
the most recent 3 miss events, so users can see whether misses are just cold
starts or a recurring prefix break.

### Not yet ported from Reasonix

- **Tiered context compaction** (snip stale tool results → prune → summarize,
  pinned prefix, cold-resume prune by 24h TTL). The Claude Agent SDK already
  manages its own history, so the gains are limited. Tracked for future work.
- **Cache-prefix-change attribution** (Reasonix's `CompareShape`), which
  diffs the system/tools/message shape to pinpoint the exact prefix break.

## 4. Balance + Usage Visibility

### Balance service

`fetchDeepSeekBalance()` in `deepseekBalanceService.ts` calls
`GET /user/balance` with Bearer auth (12s timeout, 64KB body cap). The
response is normalized into `{ available, infos[], display }` with CNY-first
display formatting.

The service reads the raw DeepSeek `apiKey` + `baseUrl` via
`getDeepSeekProviderConfig()` in `claudeSettings.ts`, bypassing the cowork
proxy (which only handles chat completions).

### UI

- **`DeepSeekBalanceChip`**: a compact chip in the cowork session header
  showing the wallet balance + per-session cache-hit rate. Hover reveals the
  per-currency breakdown (total / granted balances). Refresh is event-driven
  (manual button + on mount), not a fixed timer — mirrors Reasonix's approach
  of refreshing on `turn_done`.
- **`UsageStatsChip`** (existing, extended): the hover popover now includes
  the cache-hit rate and recent miss-attribution events.

Both chips are gated on DeepSeek model detection (`modelId` contains
`deepseek`).

## Configuration

No new configuration is required — the defaults work out of the box for a
DeepSeek-configured bot. The Responses API is used automatically when:

1. The provider is `deepseek`.
2. The model id contains `flash` (e.g. `deepseek-v4-flash`).

Pro models continue to use chat/completions until DeepSeek enables the
Responses API for them (expected in a later release).

## Testing

Run the relevant test suites:

```bash
npm run compile:electron
node --test tests/coworkFormatTransform.test.mjs \
          tests/cognitiveChatCompletion.test.mjs \
          tests/deepseekResponses.test.mjs
```

The `deepseekResponses.test.mjs` suite covers upstream routing, endpoint URL
construction, web_search injection, reasoning effort mapping, and the
cognitive-layer Responses gating.
